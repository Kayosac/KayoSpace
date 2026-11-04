import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type * as Y from 'yjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElement, createBoardDoc, listElements, makeSticky } from '@kayospace/board';
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
      'add_shape',
      'add_sticky',
      'add_text',
      'delete_elements',
      'list_boards',
      'read_board',
      'search',
      'update_element',
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
    await client.close();
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

    const client = new Client({ name: 'auth-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBe(4);
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
