import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { buildPrompt } from './ai';
import { claudeArgs, parseClaudeOutput, workLoop } from './worker';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type * as Y from 'yjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  WORKSPACE_ID,
  addElement,
  addProject,
  createBoardDoc,
  listElements,
  makeSticky,
  setBoardProject,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { SyncClient, type WebSocketCtor } from '@kayospace/sync';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'test' };

let dir: string;
let hub: Hub;
const clients: SyncClient[] = [];

async function start(): Promise<Hub> {
  return startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 20 });
}

function connect(board: string): { doc: Y.Doc; client: SyncClient } {
  const doc = createBoardDoc();
  const client = new SyncClient(doc, {
    url: `ws://127.0.0.1:${hub.port}/sync/${board}`,
    WebSocket: WebSocket as unknown as WebSocketCtor,
    minDelayMs: 30,
    maxDelayMs: 200,
  });
  clients.push(client);
  return { doc, client };
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const texts = (doc: Y.Doc): string[] =>
  listElements(doc)
    .map((e) => (e.type === 'sticky' ? e.props.content : ''))
    .sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kayospace-hub-'));
  hub = await start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await hub.close();
  await rm(dir, { recursive: true, force: true });
});

describe('синхронизация', () => {
  it('правка с одного устройства доезжает до другого', async () => {
    const tablet = connect('board1');
    const mac = connect('board1');
    await tablet.client.waitFor('synced');
    await mac.client.waitFor('synced');
    addElement(tablet.doc, makeSticky('с планшета', { x: 0, y: 0, actor: me }));
    await until(() => texts(mac.doc).includes('с планшета'), 'стикер на маке');
  });

  it('офлайн-правки обеих сторон сливаются после переподключения', async () => {
    const tablet = connect('board2');
    const mac = connect('board2');
    await tablet.client.waitFor('synced');
    await mac.client.waitFor('synced');

    mac.client.disconnect();
    addElement(tablet.doc, makeSticky('онлайн', { x: 0, y: 0, actor: me }));
    addElement(mac.doc, makeSticky('офлайн', { x: 0, y: 300, actor: me }));

    mac.client.connect();
    await mac.client.waitFor('synced');
    await until(
      () => texts(mac.doc).length === 2 && texts(tablet.doc).length === 2,
      'обе правки на обоих устройствах',
    );
    expect(texts(mac.doc)).toEqual(['онлайн', 'офлайн']);
    expect(texts(tablet.doc)).toEqual(['онлайн', 'офлайн']);
  });

  it('доски разные — правки не смешиваются', async () => {
    const a = connect('alpha');
    const b = connect('beta');
    await a.client.waitFor('synced');
    await b.client.waitFor('synced');
    addElement(a.doc, makeSticky('только в alpha', { x: 0, y: 0, actor: me }));
    await new Promise((r) => setTimeout(r, 200));
    expect(texts(b.doc)).toEqual([]);
  });

  it('доска переживает перезапуск хаба', async () => {
    const tablet = connect('persist');
    await tablet.client.waitFor('synced');
    addElement(tablet.doc, makeSticky('сохранись', { x: 0, y: 0, actor: me }));
    await until(() => hub.sync.clients('persist') === 1, 'клиент подключён');
    await new Promise((r) => setTimeout(r, 200)); // изменение доехало до хаба
    for (const c of clients.splice(0)) c.destroy();
    await hub.close();

    hub = await start();
    const mac = connect('persist');
    await mac.client.waitFor('synced');
    expect(texts(mac.doc)).toEqual(['сохранись']);
  });

  it('отвергает недопустимый id доски', async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/boards`);
    expect(res.status).toBe(200);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/sync/..%2Fetc`);
        ws.on('open', () => resolve('open'));
        ws.on('error', reject);
      }),
    ).rejects.toThrow();
  });
});

describe('проекты', () => {
  it('список досок: проект у каждой доски, служебного документа воркспейса в списке нет', async () => {
    // Устройство создаёт проект и кладёт в него доску — через синхронизацию документа воркспейса.
    const ws = createBoardDoc();
    const c = new SyncClient(ws, {
      url: `ws://127.0.0.1:${hub.port}/sync/${WORKSPACE_ID}`,
      WebSocket: WebSocket as unknown as WebSocketCtor,
      minDelayMs: 30,
    });
    clients.push(c);
    await c.waitFor('synced');
    const pid = addProject(ws, 'Работа');
    setBoardProject(ws, 'plan', pid);
    addElement(await hub.store.get('plan'), makeSticky('x', { x: 0, y: 0, actor: me }));
    addElement(await hub.store.get('free'), makeSticky('y', { x: 0, y: 0, actor: me }));
    let list: { id: string; project: { name: string } | null }[] = [];
    await until(() => {
      void fetch(`http://127.0.0.1:${hub.port}/api/boards`)
        .then((r) => r.json())
        .then((j) => (list = j as typeof list))
        // Хаб закрывается после теста — запоздавший запрос не должен ронять прогон.
        .catch(() => {});
      return list.some((b) => b.id === 'plan' && b.project?.name === 'Работа');
    }, 'проект в списке досок');
    expect(list.map((b) => b.id)).toEqual(['free', 'plan']);
    expect(list.find((b) => b.id === 'free')!.project).toBeNull();
    await hub.store.flush();
  });
});

describe('MCP', () => {
  async function mcp(): Promise<Client> {
    const client = new Client({ name: 'hub-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    return client;
  }

  const textOf = (r: unknown): string =>
    ((r as { content: { type: string; text?: string }[] }).content ?? [])
      .map((c) => c.text ?? '')
      .join('\n');

  it('показывает инструменты', async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_arrow',
      'add_elements',
      'add_frame',
      'add_image_file',
      'add_images',
      'add_shape',
      'add_sticky',
      'add_text',
      'arrange_elements',
      'create_board',
      'create_project',
      'delete_board',
      'delete_elements',
      'fetch',
      'get_changes',
      'get_image',
      'list_boards',
      'list_deleted_boards',
      'list_projects',
      'list_trash',
      'move_board',
      'move_elements',
      'read_board',
      'restore_board',
      'restore_elements',
      'search',
      'update_element',
      'view_board',
    ]);
    await client.close();
  });

  it('агент пишет на доску — устройство видит это сразу; агент читает и ищет', async () => {
    const tablet = connect('plan');
    await tablet.client.waitFor('synced');
    addElement(tablet.doc, makeSticky('Идея с планшета', { x: 0, y: 0, actor: me }));
    await new Promise((r) => setTimeout(r, 150));

    const client = await mcp();
    const added = await client.callTool({
      name: 'add_sticky',
      arguments: { board: 'plan', text: 'Ответ агента' },
    });
    expect(textOf(added)).toContain('Стикер добавлен');
    await until(() => texts(tablet.doc).includes('Ответ агента'), 'стикер агента на планшете');
    const agentSticky = listElements(tablet.doc).find(
      (e) => e.type === 'sticky' && e.props.content === 'Ответ агента',
    )!;
    expect(agentSticky.createdBy.kind).toBe('agent');
    expect(agentSticky.x).toBeGreaterThan(0); // встал справа от занятой области

    const md = textOf(await client.callTool({ name: 'read_board', arguments: { board: 'plan' } }));
    expect(md).toContain('Идея с планшета');
    expect(md).toContain('добавил агент');

    const found = textOf(await client.callTool({ name: 'search', arguments: { query: 'идея' } }));
    expect(found).toContain('plan');

    const list = textOf(await client.callTool({ name: 'list_boards', arguments: {} }));
    expect(list).toContain('"id": "plan"');

    const missing = await client.callTool({ name: 'read_board', arguments: { board: 'nope' } });
    expect((missing as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });
});

describe('ИИ: очередь, исполнитель, черновик', () => {
  it('задача уходит исполнителю, ИИ пишет в черновик, доска не меняется до «Вставить»', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    const board = 'ai-board';
    const real = await hub.store.get(board);
    addElement(real, makeSticky('Исходный', { x: 0, y: 0, actor: me }));

    const fake = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url));
    await chmod(fake, 0o755);
    const ctrl = new AbortController();
    const loop = workLoop({
      hubUrl: base,
      token: '',
      name: 'тест',
      claudeBin: fake,
      signal: ctrl.signal,
      log: () => {},
    });

    const created = await fetch(`${base}/api/ai/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board,
        action: 'brainstorm',
        area: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let task: {
      status: string;
      message: string | null;
      draft?: { elements: { type: string; props: { content?: string } }[]; deleted: string[] };
    } = { status: '', message: null };
    for (let i = 0; i < 100 && task.status !== 'done' && task.status !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      task = (await (await fetch(`${base}/api/ai/tasks/${id}`)).json()) as typeof task;
    }
    expect(task.status).toBe('done');
    expect(task.message).toBe('Добавил стикер.');
    expect(task.draft!.elements.map((e) => e.props.content)).toEqual(['Черновик от ИИ']);
    expect(task.draft!.deleted).toEqual([]);
    // В настоящей доске — только исходный стикер: черновик изолирован.
    expect(listElements(real).map((e) => (e.type === 'sticky' ? e.props.content : ''))).toEqual([
      'Исходный',
    ]);

    const status = (await (await fetch(`${base}/api/ai/status`)).json()) as {
      workers: { name: string }[];
    };
    expect(status.workers.map((w) => w.name)).toContain('тест');
    expect((await fetch(`${base}/api/ai/tasks/${id}`, { method: 'DELETE' })).status).toBe(200);
    ctrl.abort();
    await loop.catch(() => {});
  });

  it('«вставь картинку сюда» из приложения: ИИ рисует картинку в черновик, файл — на хабе', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    const board = 'ai-image';
    await hub.store.get(board);
    const fake = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url));
    await chmod(fake, 0o755);
    const ctrl = new AbortController();
    const loop = workLoop({
      hubUrl: base,
      token: '',
      name: 'картинки',
      claudeBin: fake,
      signal: ctrl.signal,
      log: () => {},
    });
    const created = await fetch(`${base}/api/ai/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board,
        action: 'prompt',
        prompt: 'вставь картинку солнца над морем сюда',
        area: { minX: 0, minY: 0, maxX: 400, maxY: 300 },
      }),
    });
    const { id } = (await created.json()) as { id: string };
    let task: {
      status: string;
      message: string | null;
      draft?: { elements: { type: string; props: { assetId?: string; alt?: string } }[] };
    } = { status: '', message: null };
    for (let i = 0; i < 100 && task.status !== 'done' && task.status !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      task = (await (await fetch(`${base}/api/ai/tasks/${id}`)).json()) as typeof task;
    }
    expect(task.status, task.message ?? '').toBe('done');
    const [img] = task.draft!.elements;
    expect(img).toMatchObject({ type: 'image', props: { alt: 'Солнце над морем' } });
    // Файл лежит в общем хранилище: устройство покажет предпросмотр и после «Вставить».
    const file = await fetch(`${base}/api/assets/${img!.props.assetId}`);
    expect(file.headers.get('content-type')).toBe('image/png');
    // Доска не меняется до «Вставить».
    expect(listElements(await hub.store.get(board))).toEqual([]);
    ctrl.abort();
    await loop.catch(() => {});
  });

  it('задание для Claude называет доску, выделение и место для новых элементов', () => {
    const text = buildPrompt({
      board: 'b1',
      action: 'recognize',
      prompt: '',
      selection: ['A', 'B'],
      area: { minX: 0, minY: 10, maxX: 100, maxY: 50 },
      image: Buffer.from([1]),
    });
    expect(text).toContain('Доска: b1.');
    expect(text).toContain('A, B');
    expect(text).toContain('x = 160');
    expect(text).toContain('selection.png');
  });

  it('аргументы Claude Code и разбор ответа', () => {
    const args = claudeArgs('привет', '/tmp/mcp.json', 'sonnet');
    expect(args.slice(0, 2)).toEqual(['-p', 'привет']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('mcp__kayospace');
    // Найти картинку в интернете можно, а команд и записи файлов нет.
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,WebSearch,WebFetch');
    expect(args).toContain('WebSearch');
    expect(args).not.toContain('Bash');
    expect(parseClaudeOutput('{"result":"ok","is_error":false,"subtype":"success"}')).toEqual({
      message: 'ok',
    });
    expect(parseClaudeOutput('{"result":"нет","is_error":true}').error).toBe('нет');
    expect(parseClaudeOutput('').error).toBeTruthy();
  });
});

describe('файлы (картинки)', () => {
  it('сохраняет по SHA-256, отдаёт обратно, проверяет содержимое', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const id = createHash('sha256').update(data).digest('hex');
    const base = `http://127.0.0.1:${hub.port}/api/assets`;
    const put = await fetch(`${base}/${id}`, { method: 'PUT', body: data });
    expect(put.status).toBe(201);
    const got = await fetch(`${base}/${id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(data);
    const wrong = await fetch(`${base}/${'0'.repeat(64)}`, { method: 'PUT', body: data });
    expect(wrong.status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(400);
    expect((await fetch(`${base}/${'1'.repeat(64)}`)).status).toBe(404);
  });
});

describe('MCP: схемы для агентов', () => {
  it('агент рисует схему: стикеры, стрелка между ними, правка и удаление', async () => {
    const client = new Client({ name: 'hub-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    const idOf = (r: unknown): string =>
      /: ([0-9A-Z]{26})/.exec(
        ((r as { content: { text?: string }[] }).content[0]?.text ?? '') as string,
      )![1]!;
    const a = idOf(
      await client.callTool({
        name: 'add_sticky',
        arguments: { board: 'flow', text: 'Начало', x: 0, y: 0 },
      }),
    );
    const b = idOf(
      await client.callTool({
        name: 'add_sticky',
        arguments: { board: 'flow', text: 'Конец', x: 400, y: 0 },
      }),
    );
    const arrow = idOf(
      await client.callTool({ name: 'add_arrow', arguments: { board: 'flow', from: a, to: b } }),
    );
    await client.callTool({
      name: 'add_text',
      arguments: { board: 'flow', text: 'Схема', x: 0, y: -60 },
    });
    await client.callTool({
      name: 'add_shape',
      arguments: { board: 'flow', shape: 'rect', x: -20, y: -20, w: 640, h: 260 },
    });
    const bad = await client.callTool({
      name: 'add_arrow',
      arguments: { board: 'flow', from: a, to: 'нет-такого' },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);

    await client.callTool({
      name: 'update_element',
      arguments: { board: 'flow', id: b, text: 'Готово', x: 500 },
    });
    const doc = await hub.store.get('flow');
    const sticky = listElements(doc).find((e) => e.id === b)!;
    expect(sticky.x).toBe(500);
    expect(sticky.type === 'sticky' && sticky.props.content).toBe('Готово');
    const link = listElements(doc).find((e) => e.id === arrow)!;
    expect(link.type === 'arrow' && link.props.end).toEqual({ kind: 'element', id: b });

    const del = await client.callTool({
      name: 'delete_elements',
      arguments: { board: 'flow', ids: [arrow, 'нет'] },
    });
    expect((del as { content: { text: string }[] }).content[0]!.text).toContain('1 из 2');
    expect(listElements(doc)).toHaveLength(4);

    // Фрейм: под всеми элементами, название меняется тем же update_element.
    const frame = idOf(
      await client.callTool({
        name: 'add_frame',
        arguments: { board: 'flow', name: 'Схема процесса', x: -60, y: -120, w: 760, h: 400 },
      }),
    );
    await client.callTool({
      name: 'update_element',
      arguments: { board: 'flow', id: frame, text: 'Процесс' },
    });
    const f = listElements(doc).find((e) => e.id === frame)!;
    expect(f.type === 'frame' && f.props.name).toBe('Процесс');
    expect(listElements(doc).every((e) => e.id === frame || e.z > f.z)).toBe(true);
    await client.close();
    await hub.store.flush(); // дождаться записи на диск, пока папка теста ещё на месте
  });
});

describe('доступ по токену', () => {
  const TOKEN = 'test-token-123';

  beforeEach(async () => {
    await hub.close();
    hub = await startHub({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      saveDelayMs: 20,
      token: TOKEN,
    });
  });

  function connectWith(board: string, token?: string): { doc: Y.Doc; client: SyncClient } {
    const doc = createBoardDoc();
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const client = new SyncClient(doc, {
      url: `ws://127.0.0.1:${hub.port}/sync/${board}${q}`,
      WebSocket: WebSocket as unknown as WebSocketCtor,
      minDelayMs: 30,
    });
    clients.push(client);
    return { doc, client };
  }

  it('health открыт, REST требует токен', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toMatchObject({ ok: true, auth: true });
    expect((await fetch(`${base}/api/boards`)).status).toBe(401);
    const ok = await fetch(`${base}/api/boards`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it('синхронизация без токена получает отказ и не переподключается', async () => {
    const bad = connectWith('secure', 'wrong');
    await bad.client.waitFor('unauthorized');
    expect(bad.client.lastError).toBe('unauthorized');
    const good = connectWith('secure', TOKEN);
    await good.client.waitFor('synced');
  });

  it('MCP требует Bearer-токен', async () => {
    const url = new URL(`http://127.0.0.1:${hub.port}/mcp`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    // По этому указателю приложение Claude находит вход по OAuth.
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');

    const client = new Client({ name: 'auth-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBe(28);
    await client.close();
  });

  it('коннектор входит по OAuth и получает доступ к MCP', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = {
      response_type: 'code',
      client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const allow = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      body: new URLSearchParams({ ...params, hub_token: TOKEN, decision: 'allow' }),
      redirect: 'manual',
    });
    const code = new URL(allow.headers.get('location')!).searchParams.get('code')!;
    const tok = (await (
      await fetch(`${base}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id,
          redirect_uri: params.redirect_uri,
          code_verifier: verifier,
        }),
      })
    ).json()) as { access_token: string };
    const client = new Client({ name: 'oauth-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
      }),
    );
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
  });

  it('MCP отвергает чужой Host', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: hub.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'evil.example.com',
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});

describe('устройства: подключение по коду', () => {
  const TOKEN = 'admin-token-xyz';
  let base: string;

  beforeEach(async () => {
    await hub.close();
    hub = await startHub({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      saveDelayMs: 20,
      token: TOKEN,
      publicUrl: 'https://hub.example.com:8443',
    });
    base = `http://127.0.0.1:${hub.port}`;
  });

  afterEach(async () => {
    await hub.devices.flush();
  });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  async function pair(token: string): Promise<{ code: string; link: string; hub: string }> {
    const res = await post('/api/devices/pair', {}, token);
    expect(res.status).toBe(200);
    return (await res.json()) as { code: string; link: string; hub: string };
  }

  async function claim(code: string, name: string): Promise<{ token: string; id: string }> {
    const res = await post('/api/devices/claim', { code, name, platform: 'android' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { token: string; device: { id: string } };
    return { token: j.token, id: j.device.id };
  }

  function syncWith(board: string, token: string): { doc: Y.Doc; client: SyncClient } {
    const doc = createBoardDoc();
    const client = new SyncClient(doc, {
      url: `ws://127.0.0.1:${hub.port}/sync/${board}?token=${encodeURIComponent(token)}`,
      WebSocket: WebSocket as unknown as WebSocketCtor,
      minDelayMs: 30,
    });
    clients.push(client);
    return { doc, client };
  }

  it('код без токена не выдаётся; ссылка несёт внешний адрес хаба и код', async () => {
    expect((await post('/api/devices/pair', {})).status).toBe(401);
    const p = await pair(TOKEN);
    expect(p.code).toMatch(/^\d{6}$/);
    expect(p.hub).toBe('https://hub.example.com:8443');
    const link = new URL(p.link);
    expect(link.protocol).toBe('kayospace:');
    expect(link.searchParams.get('hub')).toBe('https://hub.example.com:8443');
    expect(link.searchParams.get('code')).toBe(p.code);
  });

  it('подключение по коду: токен устройства открывает синхронизацию и REST', async () => {
    const { code } = await pair(TOKEN);
    const tablet = await claim(code, 'Планшет');
    expect(tablet.token.startsWith('kd_')).toBe(true);

    const boards = await fetch(`${base}/api/boards`, {
      headers: { Authorization: `Bearer ${tablet.token}` },
    });
    expect(boards.status).toBe(200);

    const a = syncWith('paired', tablet.token);
    const b = syncWith('paired', TOKEN);
    await a.client.waitFor('synced');
    await b.client.waitFor('synced');
    addElement(a.doc, makeSticky('с планшета', { x: 0, y: 0, actor: me }));
    await until(() => texts(b.doc).includes('с планшета'), 'правка с планшета');

    // Подключённое устройство само выдаёт коды для следующих.
    const next = await pair(tablet.token);
    const mac = await claim(next.code, 'Mac');
    const list = (await (
      await fetch(`${base}/api/devices`, { headers: { Authorization: `Bearer ${mac.token}` } })
    ).json()) as { devices: { id: string; name: string; addedBy: string }[]; current: string };
    expect(list.current).toBe(mac.id);
    expect(list.devices.map((d) => d.name)).toEqual(['Планшет', 'Mac']);
    expect(list.devices[1]!.addedBy).toBe(tablet.id);
  });

  it('повторно использованный код получает отказ', async () => {
    const { code } = await pair(TOKEN);
    await claim(code, 'Первое');
    const again = await post('/api/devices/claim', { code, name: 'Второе' });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain('не подошёл');
  });

  it('истёкший код получает отказ', async () => {
    const { code } = await pair(TOKEN);
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60 * 1000 + 1;
    try {
      const res = await post('/api/devices/claim', { code, name: 'Опоздавшее' });
      expect(res.status).toBe(400);
    } finally {
      Date.now = realNow;
    }
  });

  it('перебор кода упирается в ограничение', async () => {
    let status = 0;
    for (let i = 0; i < 12; i++) {
      status = (await post('/api/devices/claim', { code: '000000' })).status;
    }
    expect(status).toBe(429);
  });

  it('отключение: открытое соединение закрывается, REST отвечает 401, остальные работают', async () => {
    const tablet = await claim((await pair(TOKEN)).code, 'Планшет');
    const mac = await claim((await pair(TOKEN)).code, 'Mac');
    const t = syncWith('revoke', tablet.token);
    const m = syncWith('revoke', mac.token);
    await t.client.waitFor('synced');
    await m.client.waitFor('synced');

    const del = await fetch(`${base}/api/devices/${tablet.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mac.token}` },
    });
    expect(del.status).toBe(204);
    await t.client.waitFor('unauthorized');
    expect(t.client.lastError).toBe('unauthorized');

    const rest = await fetch(`${base}/api/boards`, {
      headers: { Authorization: `Bearer ${tablet.token}` },
    });
    expect(rest.status).toBe(401);
    const again = syncWith('revoke', tablet.token);
    await again.client.waitFor('unauthorized');

    // Mac на месте и синхронизируется дальше.
    expect(m.client.status).toBe('synced');
    addElement(m.doc, makeSticky('жив', { x: 0, y: 0, actor: me }));
    const check = syncWith('revoke', TOKEN);
    await until(() => texts(check.doc).includes('жив'), 'правка с мака');
  });

  it('переход со старых настроек: HUB_TOKEN меняется на токен устройства', async () => {
    const res = await post('/api/devices/register', { name: 'Старый планшет' }, TOKEN);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token.startsWith('kd_')).toBe(true);
    // Токен устройства так не может — только ключ администратора.
    expect((await post('/api/devices/register', {}, token)).status).toBe(403);
  });

  it('устройства переживают перезапуск хаба', async () => {
    const tablet = await claim((await pair(TOKEN)).code, 'Планшет');
    await hub.close();
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', token: TOKEN });
    base = `http://127.0.0.1:${hub.port}`;
    const res = await fetch(`${base}/api/boards`, {
      headers: { Authorization: `Bearer ${tablet.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('pnpm pair печатает QR и код, который принимает хаб', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/pair-main.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, HUB_LOCAL_URL: base, HUB_TOKEN: TOKEN },
      });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve(text) : reject(new Error(`pair: ${code}\n${text}`)),
      );
    });
    expect(out).toContain('▀');
    expect(out).toContain('https://hub.example.com:8443');
    const code = /Код:\s+(\d{3}) (\d{3})/.exec(out);
    expect(code).not.toBeNull();
    await claim(code![1]! + code![2]!, 'Из терминала');
  });

  it('pnpm pair без ключа администратора — понятная ошибка', async () => {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/pair-main.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, HUB_LOCAL_URL: base, HUB_TOKEN: 'wrong' },
      });
      let text = '';
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      child.on('exit', (code) => resolve({ code, text }));
    });
    expect(out.code).toBe(1);
    expect(out.text).toContain('HUB_TOKEN');
  });
});

describe('устройства на открытом хабе (разработка)', () => {
  it('без токена всё открыто, но отозванный токен устройства не проходит', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    expect((await fetch(`${base}/api/boards`)).status).toBe(200);
    const p = (await (await fetch(`${base}/api/devices/pair`, { method: 'POST' })).json()) as {
      code: string;
    };
    const r = (await (
      await fetch(`${base}/api/devices/claim`, {
        method: 'POST',
        body: JSON.stringify({ code: p.code, platform: 'macos' }),
      })
    ).json()) as { token: string; device: { id: string } };
    const auth = { Authorization: `Bearer ${r.token}` };
    expect((await fetch(`${base}/api/boards`, { headers: auth })).status).toBe(200);
    await fetch(`${base}/api/devices/${r.device.id}`, { method: 'DELETE' });
    expect((await fetch(`${base}/api/boards`, { headers: auth })).status).toBe(401);
    await hub.devices.flush();
  });
});

describe('клиент синхронизации', () => {
  it('не висит вечно, если хаб не отвечает', async () => {
    // TCP-сервер, который принимает соединение и молчит — как файрвол, глотающий пакеты.
    const sockets: Socket[] = [];
    const silent = createTcpServer((socket) => sockets.push(socket));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as AddressInfo).port;
    const client = new SyncClient(createBoardDoc(), {
      url: `ws://127.0.0.1:${port}/sync/x`,
      WebSocket: WebSocket as unknown as WebSocketCtor,
      connectTimeoutMs: 300,
      minDelayMs: 5000,
    });
    clients.push(client);
    await client.waitFor('offline', 3000);
    expect(client.lastError).toBe('timeout');
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  });
});
