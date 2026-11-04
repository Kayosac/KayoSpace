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
import { BoardStore } from './store';
import { attachSync, type SyncServer } from './sync-server';

export const HUB_VERSION = '0.1.0';

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
}

export interface Hub {
  port: number;
  store: BoardStore;
  sync: SyncServer;
  close(): Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const store = new BoardStore(opts.dataDir, opts.saveDelayMs);
  await store.init();

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
    if (url.pathname === '/mcp') {
      if (token) {
        if (!hostAllowed(req, opts.publicHost) || !originAllowed(req, opts.publicHost)) {
          return json(res, 403, { error: 'Недопустимый Host или Origin' });
        }
        if (!tokenMatches(bearerToken(req), token)) return unauthorized(res);
      } else if (!validateHost(req, res) || !validateOrigin(req, res)) {
        return;
      }
      await mcpNode(req, res);
      return;
    }
    // Остальное API читают клиенты с других адресов (дев-сервер Pen Lab) — разрешаем CORS.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, version: HUB_VERSION, auth: Boolean(token) });
    }
    if (token && !tokenMatches(requestToken(req, url), token)) return unauthorized(res);
    if (url.pathname === '/api/boards' && req.method === 'GET') {
      return json(res, 200, await store.list());
    }
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
    sync,
    async close() {
      await sync.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await mcp.close?.();
      await store.close();
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
