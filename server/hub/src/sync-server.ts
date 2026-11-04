/**
 * WebSocket-сервер синхронизации: ws://host:port/sync/<id доски>.
 * Каждое изменение доски (от клиента или от агента через MCP) рассылается всем остальным клиентам.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type * as Y from 'yjs';
import { handleMessage, isValidBoardId, step1Message, updateMessage } from '@kayospace/sync';
import { CLOSE_UNAUTHORIZED, requestToken } from './auth';
import type { BoardStore } from './store';

export interface SyncServer {
  /** Сколько клиентов подключено к доске. */
  clients(id: string): number;
  /** Закрыть все соединения устройства (его отключили). */
  dropDevice(deviceId: string): void;
  close(): Promise<void>;
}

export function attachSync(
  server: Server,
  store: BoardStore,
  opts: {
    /** Проверка токена: null — отказ, иначе — какое устройство подключилось (null — не устройство). */
    authorize?: (token: string | undefined) => { device: string | null } | null;
  } = {},
): SyncServer {
  const wss = new WebSocketServer({ noServer: true });
  const byDevice = new Map<WebSocket, string>();
  const rooms = new Map<string, Set<WebSocket>>();
  const watched = new WeakSet<Y.Doc>();

  const watch = (id: string, doc: Y.Doc): void => {
    if (watched.has(doc)) return;
    watched.add(doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const msg = updateMessage(update);
      for (const ws of rooms.get(id) ?? []) {
        if (ws !== origin && ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    });
  };

  const onConnection = (ws: WebSocket, id: string, device: string | null): void => {
    ws.binaryType = 'arraybuffer';
    if (device) byDevice.set(ws, device);
    const room = rooms.get(id) ?? new Set<WebSocket>();
    rooms.set(id, room);
    room.add(ws);

    // Сообщения могут прийти раньше, чем доска загрузится с диска, — копим их.
    let doc: Y.Doc | null = null;
    const queue: Uint8Array[] = [];
    const handle = (data: Uint8Array): void => {
      try {
        const { reply } = handleMessage(doc!, data, ws);
        if (reply && ws.readyState === WebSocket.OPEN) ws.send(reply);
      } catch (err) {
        console.error(`[hub] плохое сообщение для доски ${id}`, err);
      }
    };
    ws.on('message', (data: ArrayBuffer | Buffer | Buffer[]) => {
      const bytes = toBytes(data);
      if (doc) handle(bytes);
      else queue.push(bytes);
    });
    ws.on('close', () => {
      byDevice.delete(ws);
      room.delete(ws);
      if (room.size === 0) rooms.delete(id);
    });

    store
      .get(id)
      .then((d) => {
        doc = d;
        watch(id, d);
        if (ws.readyState === WebSocket.OPEN) ws.send(step1Message(d));
        for (const m of queue.splice(0)) handle(m);
      })
      .catch((err) => {
        console.error(`[hub] не открылась доска ${id}`, err);
        ws.close(1011, 'board load failed');
      });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/sync\/([^/]+)$/.exec(url.pathname);
    const id = match?.[1] ? decodeURIComponent(match[1]) : '';
    if (!isValidBoardId(id)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const allowed = opts.authorize ? opts.authorize(requestToken(req, url)) : { device: null };
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Неверный токен: принимаем соединение и сразу закрываем с кодом 4401 —
      // браузер не показывает HTTP-статус отказа, а код закрытия клиент увидит.
      if (!allowed) ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      else onConnection(ws, id, allowed.device);
    });
  };
  server.on('upgrade', onUpgrade);

  return {
    clients: (id) => rooms.get(id)?.size ?? 0,
    dropDevice: (deviceId) => {
      for (const [ws, d] of byDevice) {
        if (d === deviceId) ws.close(CLOSE_UNAUTHORIZED, 'device revoked');
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.off('upgrade', onUpgrade);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

function toBytes(data: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
