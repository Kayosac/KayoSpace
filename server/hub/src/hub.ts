/**
 * HTTP-сервер хаба:
 *   GET  /health        — жив ли хаб (без авторизации)
 *   GET  /api/boards    — список досок
 *   POST /mcp           — MCP (Streamable HTTP) для агентов
 *   WS   /sync/<id>     — синхронизация доски
 *
 * Доступ — см. auth.ts: без токена только локально, с токеном можно выставлять в интернет за HTTPS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { bearerToken, hostAllowed, originAllowed, requestToken, tokenMatches } from './auth';
import { createMcp } from './mcp';
import { join } from 'node:path';
import { AssetStore, handleAsset } from './assets';
import { OAuthServer, publicBase } from './oauth';
import { AiQueue, handleAi } from './ai';
import { BoardStore } from './store';
import { attachSync, type SyncServer } from './sync-server';

export const HUB_VERSION = '0.2.0';

export interface HubOptions {
  dataDir: string;
  port?: number;
  /** 0.0.0.0 — доступен планшету в локальной сети; 127.0.0.1 — только этому компьютеру. */
  host?: string;
  saveDelayMs?: number;
  /** Токен доступа. Без него MCP принимает запросы только с этого компьютера. */
  token?: string;
  /** Публичный домен хаба (для проверки Host/Origin в MCP), например 1-2-3-4.sslip.io. */
  publicHost?: string;
  /** Внутренние имена хаба (например, «hub» в сети Docker) — для исполнителя ИИ на том же сервере. */
  internalHosts?: string[];
}

export interface Hub {
  port: number;
  store: BoardStore;
  ai: AiQueue;
  sync: SyncServer;
  close(): Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const store = new BoardStore(opts.dataDir, opts.saveDelayMs);
  await store.init();
  const assets = new AssetStore(join(opts.dataDir, 'assets'));
  await assets.init();
  // Вход по OAuth — только когда хаб закрыт токеном (в интернете); локально MCP открыт и так.
  const oauth = opts.token ? new OAuthServer(join(opts.dataDir, 'oauth.json'), opts.token) : null;
  await oauth?.init();
  const ai = new AiQueue(store);
  /** MCP черновиков ИИ: по обработчику на задачу. */
  const draftMcp = new Map<string, ReturnType<typeof toNodeHandler>>();

  const mcp = createMcp(store);
  const mcpNode = toNodeHandler(mcp);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      console.error('[hub] ошибка запроса', err);
      if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка хаба' });
    });
  });

  const token = opts.token || undefined;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (oauth && (await oauth.handle(req, res, url))) return;
    const draft = /^\/mcp\/draft\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (url.pathname === '/mcp' || draft) {
      if (token) {
        if (
          !hostAllowed(req, opts.publicHost, opts.internalHosts) ||
          !originAllowed(req, opts.publicHost)
        ) {
          return json(res, 403, { error: 'Недопустимый Host или Origin' });
        }
        const given = bearerToken(req);
        if (!tokenMatches(given, token) && !oauth?.validAccessToken(given)) {
          // Указатель на метаданные — по нему приложение Claude находит вход по OAuth.
          res.setHeader(
            'WWW-Authenticate',
            `Bearer realm="kayospace", resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource"`,
          );
          return json(res, 401, { error: 'Нужен токен доступа' });
        }
      } else if (!validateHost(req, res) || !validateOrigin(req, res)) {
        return;
      }
      if (draft) {
        // Исполнитель ИИ работает с копией доски — черновиком задачи.
        const task = ai.tasks.get(draft[1]!);
        if (!task || task.status !== 'running') return json(res, 404, { error: 'Задачи нет' });
        let handler = draftMcp.get(task.id);
        if (!handler) {
          handler = toNodeHandler(createMcp(ai.draftSource(task), { actorName: 'kayospace-ai' }));
          draftMcp.set(task.id, handler);
        }
        await handler(req, res);
        return;
      }
      await mcpNode(req, res);
      return;
    }
    // Остальное API читают клиенты с других адресов (дев-сервер Pen Lab) — разрешаем CORS.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, version: HUB_VERSION, auth: Boolean(token) });
    }
    if (token && !tokenMatches(requestToken(req, url), token)) return unauthorized(res);
    if (await handleAi(req, res, url, ai)) {
      for (const id of draftMcp.keys()) if (!ai.tasks.has(id)) draftMcp.delete(id);
      return;
    }
    if (url.pathname === '/api/boards' && req.method === 'GET') {
      return json(res, 200, await store.list());
    }
    const asset = /^\/api\/assets\/([^/]+)$/.exec(url.pathname);
    if (asset) return handleAsset(req, res, assets, asset[1]!);
    json(res, 404, { error: 'Не найдено' });
  }

  const sync = attachSync(server, store, { token });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4000, opts.host ?? '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    store,
    ai,
    sync,
    async close() {
      ai.close();
      await sync.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await mcp.close?.();
      await store.close();
      await oauth?.flush();
    },
  };
}

function unauthorized(res: ServerResponse): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="kayospace"');
  json(res, 401, { error: 'Нужен токен доступа' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
