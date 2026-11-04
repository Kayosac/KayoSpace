/**
 * Клиент синхронизации доски: держит соединение с хабом, переподключается с нарастающей паузой.
 * Работает и в браузере (встроенный WebSocket), и в Node (передайте WebSocket из пакета ws).
 * Пока соединения нет, правки просто копятся в Y.Doc и уезжают при следующем подключении.
 */

import type * as Y from 'yjs';
import { MSG_STEP2, handleMessage, step1Message, updateMessage } from './protocol';

/** Минимум WebSocket, который нужен клиенту: совпадает с браузерным API и с пакетом ws. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export type SyncStatus =
  | 'connecting'
  | 'connected'
  | 'synced'
  | 'offline'
  /** Хаб отклонил токен — переподключаться бессмысленно, пока токен не исправят. */
  | 'unauthorized'
  | 'stopped';

/** Почему соединения нет — чтобы показать человеку понятную причину. */
export type SyncError = 'timeout' | 'closed' | 'unauthorized' | 'invalid-url';

/** Код закрытия, которым хаб сообщает о неверном токене. */
export const CLOSE_UNAUTHORIZED = 4401;

export interface SyncClientOptions {
  /** Адрес вида ws://host:4000/sync/<id доски>. */
  url: string;
  WebSocket?: WebSocketCtor;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Подключиться сразу (по умолчанию да). */
  connect?: boolean;
  /** Сколько ждать открытия соединения, прежде чем считать хаб недоступным (по умолчанию 8 с). */
  connectTimeoutMs?: number;
}

const OPEN = 1;

export class SyncClient {
  status: SyncStatus = 'offline';
  /** Причина последнего разрыва или неудачной попытки. */
  lastError: SyncError | null = null;
  private ws: WebSocketLike | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private stopped = false;
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private readonly Ctor: WebSocketCtor;

  constructor(
    readonly doc: Y.Doc,
    private readonly opts: SyncClientOptions,
  ) {
    const Ctor = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error('WebSocket недоступен: передайте его в опции WebSocket');
    this.Ctor = Ctor;
    this.delay = opts.minDelayMs ?? 500;
    doc.on('update', this.onDocUpdate);
    if (opts.connect !== false) this.connect();
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Дождаться статуса (для тестов и для «подождать первую синхронизацию»). */
  waitFor(status: SyncStatus, timeoutMs = 5000): Promise<void> {
    if (this.status === status) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Не дождались статуса ${status}, сейчас ${this.status}`));
      }, timeoutMs);
      const off = this.onStatus((s) => {
        if (s === status) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  connect(): void {
    this.stopped = false;
    if (this.ws) return;
    this.clearRetry();
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = new this.Ctor(this.opts.url);
    } catch {
      // Например, адрес с ошибкой или ws:// со страницы по HTTPS — браузер отказывает сразу.
      this.lastError = 'invalid-url';
      this.setStatus('offline');
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let timedOut = false;
    this.connectTimer = setTimeout(() => {
      // Пакеты могут молча теряться (файрвол, изоляция в сети) — тогда браузер ждёт минутами.
      timedOut = true;
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
      if (this.ws === ws) {
        this.ws = null;
        this.lastError = 'timeout';
        this.setStatus('offline');
        this.scheduleReconnect();
      }
    }, this.opts.connectTimeoutMs ?? 8000);
    ws.onopen = () => {
      this.clearConnectTimer();
      this.delay = this.opts.minDelayMs ?? 500;
      this.lastError = null;
      this.setStatus('connected');
      ws.send(step1Message(this.doc));
    };
    ws.onmessage = (ev) => {
      const data = toBytes(ev.data);
      if (!data) return;
      try {
        const { reply, type } = handleMessage(this.doc, data, this);
        if (reply && ws.readyState === OPEN) ws.send(reply);
        if (type === MSG_STEP2 && this.status !== 'synced') this.setStatus('synced');
      } catch (err) {
        console.error('[sync] не удалось обработать сообщение', err);
      }
    };
    ws.onclose = (ev) => {
      this.clearConnectTimer();
      if (this.ws !== ws) return; // это соединение уже заменено или отменено по таймауту
      this.ws = null;
      if (this.stopped) return;
      if (ev?.code === CLOSE_UNAUTHORIZED) {
        this.lastError = 'unauthorized';
        this.setStatus('unauthorized');
        return;
      }
      this.lastError = timedOut ? 'timeout' : 'closed';
      this.setStatus('offline');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose придёт следом */
    };
  }

  /** Отключиться и не переподключаться, пока не вызовут connect(). */
  disconnect(): void {
    this.stopped = true;
    this.clearRetry();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    }
    this.setStatus('stopped');
  }

  destroy(): void {
    this.disconnect();
    this.doc.off('update', this.onDocUpdate);
    this.listeners.clear();
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return; // пришло с хаба — не отсылаем обратно
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) ws.send(updateMessage(update));
  };

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of [...this.listeners]) cb(s);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (
    data instanceof ArrayBuffer ||
    Object.prototype.toString.call(data) === '[object ArrayBuffer]'
  ) {
    return new Uint8Array(data as ArrayBuffer);
  }
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // ws без binaryType может прислать массив буферов
  if (Array.isArray(data)) {
    const parts = data.filter((d): d is Uint8Array => ArrayBuffer.isView(d));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
  return null;
}
