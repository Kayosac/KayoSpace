/**
 * HTTP-сервер хаба:
 *   GET  /health        — жив ли хаб (без авторизации)
 *   GET  /api/boards    — список досок
 *   …    /api/devices   — подключение устройств по коду, список, отключение (devices-api.ts)
 *   POST /mcp           — MCP (Streamable HTTP) для агентов
 *   WS   /sync/<id>     — синхронизация доски
 *
 * Доступ — см. auth.ts: без токена только локально, с токеном можно выставлять в интернет за HTTPS.
 * Устройства входят своими токенами (devices.ts), HUB_TOKEN — ключ администратора и исполнителя ИИ.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { bearerToken, hostAllowed, originAllowed, requestToken, tokenMatches } from './auth';
import { MCP_ORIGIN, agentContext, agentNameFor, createMcp } from './mcp';
import { DeviceRegistry, isDeviceToken } from './devices';
import { handleClaim, handleDevices, type Access } from './devices-api';
import { join } from 'node:path';
import { AssetStore, handleAsset, readBody } from './assets';
import { handleRender } from './mcp-pages';
import { DocThumbs, handleDocExport } from './doc-export';
import { Backups, handleBackups } from './backups';
import { handleSearch } from './search';
import { Trash, handleTrash } from './trash';
import { OAuthServer, publicBase } from './oauth';
import { AiQueue, handleAi } from './ai';
import { BoardStore } from './store';
import { reapDeletedBoards } from './deleted-boards';
import { History, handleHistory } from './history';
import { Handwriting } from './handwriting';
import { handleTasks } from './tasks';
import { ChatStore } from './chat';
import { MAX_VOICE_BYTES, OpenAi, OpenAiError, type OpenAiConfig } from './openai';
import { loadImages } from './render';
import { attachSync, type SyncServer } from './sync-server';

export const HUB_VERSION = '0.15.0';

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
  /**
   * Внешний адрес хаба для ссылок подключения (QR), например https://1-2-3-4.sslip.io:8443.
   * Без него — адрес, по которому пришёл запрос.
   */
  publicUrl?: string;
  /** Как часто снимать резервную копию досок, мс (0 — не снимать). По умолчанию — 6 часов. */
  backupIntervalMs?: number;
  /** Только для тестов: агенты могут класть картинки по ссылкам на этот компьютер. */
  allowPrivateImageUrls?: boolean;
  /** OpenAI (решение 0018): генерация картинок и голос; null — выключено. */
  openai?: OpenAiConfig | null;
  /** Рукописное: через сколько затишья распознавать, мс (для тестов). */
  handwritingQuietMs?: number;
  /** История версий: затишье и минимальный промежуток между версиями, мс (для тестов). */
  historyQuietMs?: number;
  historyGapMs?: number;
}

export interface Hub {
  port: number;
  store: BoardStore;
  ai: AiQueue;
  devices: DeviceRegistry;
  sync: SyncServer;
  backups: Backups;
  trash: Trash;
  history: History;
  handwriting: Handwriting;
  /** Стереть доски, удалённые больше 7 дней назад (раз в час — само). */
  reap(now?: number): Promise<string[]>;
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
  const devices = new DeviceRegistry(join(opts.dataDir, 'devices.json'));
  await devices.init();
  const ai = new AiQueue(store, new ChatStore(opts.dataDir));
  const trash = new Trash(opts.dataDir, { agentOrigin: MCP_ORIGIN, saveDelayMs: opts.saveDelayMs });
  store.onLoad((id, doc) => trash.attach(id, doc));
  // История версий (решение 0018).
  const openai = opts.openai
    ? new OpenAi({
        usageFile: join(opts.dataDir, 'openai-usage.json'),
        settingsFile: join(opts.dataDir, 'openai-settings.json'),
        ...opts.openai,
      })
    : null;
  await openai?.init();
  const history = new History(store, {
    quietMs: opts.historyQuietMs,
    minGapMs: opts.historyGapMs,
  });
  store.onLoad((id, doc) => history.attach(id, doc));
  // Распознавание рукописного (решение 0018) — только с ключом OpenAI.
  const handwriting = new Handwriting(opts.dataDir, store, openai, {
    quietMs: opts.handwritingQuietMs,
  });
  store.onLoad((id, doc) => handwriting.attach(id, doc));
  // Миниатюры документов и таблиц для карточек на досках (решение 0022).
  const docThumbs = new DocThumbs(store, assets);
  const backups = new Backups(store, { intervalMs: opts.backupIntervalMs ?? 6 * 3_600_000 });
  backups.start();
  /** MCP черновиков ИИ: по обработчику на задачу. */
  const draftMcp = new Map<string, ReturnType<typeof toNodeHandler>>();

  const mcp = createMcp(store.live(), {
    assets,
    trash,
    allowPrivateImageUrls: opts.allowPrivateImageUrls,
    history,
    openai,
    handwriting: handwriting.enabled ? handwriting : null,
  });
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

  /**
   * Кто обращается: HUB_TOKEN — администратор, токен устройства — устройство. null — доступа нет.
   * Хаб без токена открыт всем (локальная разработка), но отозванный токен устройства и там не проходит —
   * чтобы отключённое устройство узнало, что его отключили.
   */
  function identify(given: string | undefined): Access | null {
    if (token && tokenMatches(given, token)) return { admin: true, device: null };
    const device = devices.verify(given);
    if (device) return { admin: false, device };
    if (!token && !isDeviceToken(given)) return { admin: true, device: null };
    return null;
  }

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
        if (!identify(given) && !oauth?.validAccessToken(given)) {
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
          handler = toNodeHandler(
            createMcp(ai.draftSource(task), {
              actorName: 'kayospace-ai',
              assets,
              openai,
              handwriting: handwriting.enabled ? handwriting : null,
            }),
          );
          draftMcp.set(task.id, handler);
        }
        await handler(req, res);
        return;
      }
      // Кто пишет — для подписи правок: приложение по OAuth («Claude», «ChatGPT»), иначе клиент по User-Agent.
      await agentContext.run(agentNameFor(req, oauth?.clientName(bearerToken(req)) ?? null), () =>
        mcpNode(req, res),
      );
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
      return json(res, 200, {
        ok: true,
        version: HUB_VERSION,
        auth: Boolean(token),
        devices: true,
      });
    }
    if (url.pathname === '/api/devices/claim' && req.method === 'POST') {
      return handleClaim(req, res, devices);
    }
    const access = identify(requestToken(req, url));
    if (!access) return unauthorized(res);
    if (await handleDevices(req, res, url, devices, access, opts.publicUrl ?? publicBase(req))) {
      return;
    }
    // Что умеет хаб сверх обычного: генерация картинок и голос — только с ключом OpenAI.
    if (url.pathname === '/api/features' && req.method === 'GET') {
      return json(res, 200, {
        imageGen: Boolean(openai),
        voice: Boolean(openai),
        handwriting: Boolean(openai?.handwritingEnabled),
        ...(openai ? { usage: await openai.usageToday() } : {}),
      });
    }
    // Лимиты OpenAI и рукописное — из приложения (решение 0019), без правки сервера.
    if (url.pathname === '/api/openai' && (req.method === 'GET' || req.method === 'PUT')) {
      if (!openai) return json(res, 404, { error: 'На хабе нет ключа OpenAI' });
      if (req.method === 'PUT') {
        const body = await readBody(req, 4096);
        let patch: Record<string, unknown>;
        try {
          patch = JSON.parse(body?.toString('utf8') ?? '{}') as Record<string, unknown>;
        } catch {
          return json(res, 400, { error: 'Нужен JSON' });
        }
        try {
          await openai.update(patch as Parameters<OpenAi['update']>[0]);
        } catch (err) {
          if (err instanceof OpenAiError) return json(res, 400, { error: err.message });
          throw err;
        }
      }
      return json(res, 200, { ...openai.settings(), usage: await openai.usageToday() });
    }
    if (url.pathname === '/api/voice' && req.method === 'POST') {
      if (!openai) return json(res, 501, { error: 'Голос не настроен: на хабе нет ключа OpenAI' });
      const audio = await readBody(req, MAX_VOICE_BYTES);
      if (!audio) return json(res, 413, { error: 'Запись слишком длинная' });
      if (audio.length < 200) return json(res, 400, { error: 'Пустая запись' });
      try {
        const text = await openai.transcribe(audio, String(req.headers['content-type'] ?? ''));
        return json(res, 200, { text });
      } catch (err) {
        if (err instanceof OpenAiError) return json(res, 502, { error: err.message });
        throw err;
      }
    }
    if (await handleAi(req, res, url, ai)) {
      for (const id of draftMcp.keys()) if (!ai.tasks.has(id)) draftMcp.delete(id);
      return;
    }
    if (url.pathname === '/api/boards' && req.method === 'GET') {
      return json(res, 200, await store.list());
    }
    if (await handleBackups(req, res, url, backups, access)) return;
    if (await handleSearch(req, res, url, store, handwriting.enabled ? handwriting : null)) return;
    // «Очистить корзину» (решение 0022): удалённое с досок и удалённые доски — насовсем.
    if (url.pathname === '/api/trash/clear' && req.method === 'POST') {
      for (const b of await trash.boardIds()) await trash.purge(b);
      const boards = await reap(undefined, true);
      return json(res, 200, { boards: boards.length });
    }
    if (await handleTrash(req, res, url, trash, store)) return;
    if (
      await handleTasks(req, res, url, store, {
        kind: 'human',
        name: access.device?.name ?? 'хаб',
      })
    )
      return;
    if (await handleHistory(req, res, url, history, (els) => loadImages(els, assets))) return;
    if (await handleRender(req, res, url, store, assets)) return;
    if (await handleDocExport(req, res, url, store, assets, docThumbs)) return;
    const asset = /^\/api\/assets\/([^/]+)$/.exec(url.pathname);
    if (asset) return handleAsset(req, res, assets, asset[1]!);
    json(res, 404, { error: 'Не найдено' });
  }

  const sync = attachSync(server, store, {
    authorize: (given) => {
      const a = identify(given);
      return a ? { device: a.device?.id ?? null } : null;
    },
    gone: (id) => store.isPurged(id),
  });
  // Отключили устройство — его открытые соединения закрываются сразу.
  devices.onRevoke((id) => sync.dropDevice(id));

  const reap = (now?: number, all = false): Promise<string[]> =>
    reapDeletedBoards(
      store,
      {
        purge: async (id) => {
          sync.dropBoard(id);
          await trash.purge(id);
          await history.purge(id);
          await handwriting.purge(id);
        },
      },
      now,
      all,
    );
  const reaper = setInterval(
    () => void reap().catch((err) => console.error('[hub] не стёрлись удалённые доски', err)),
    3_600_000,
  );
  reaper.unref();
  void reap().catch((err) => console.error('[hub] не стёрлись удалённые доски', err));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4000, opts.host ?? '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    store,
    ai,
    devices,
    sync,
    backups,
    trash,
    history,
    handwriting,
    reap,
    async close() {
      clearInterval(reaper);
      handwriting.close();
      backups.stop();
      ai.close();
      await sync.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await mcp.close?.();
      await history.flush();
      await store.close();
      await trash.flush();
      await oauth?.flush();
      await devices.flush();
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
