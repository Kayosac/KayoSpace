import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SyncClient, type WebSocketCtor } from '@kayospace/sync';
import {
  DELETED_BOARD_KEEP_MS,
  WORKSPACE_ID,
  addElement,
  deletedBoards,
  makeSticky,
  markBoardDeleted,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };
const exists = (f: string) =>
  access(f).then(
    () => true,
    () => false,
  );

describe('удаление досок', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-deleted-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'deleted-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError };
  };
  const boards = async () =>
    (JSON.parse((await call('list_boards')).text) as { id: string }[]).map((b) => b.id);

  it('агент удаляет и возвращает доску; удалённой для агентов нет', async () => {
    await call('create_board', { board: 'plan', name: 'План' });
    addElement(await hub.store.get('plan'), makeSticky('Пункт', { x: 0, y: 0, actor: me }));
    expect(await boards()).toEqual(['plan']);

    expect((await call('delete_board', { board: 'plan' })).text).toContain('удалена');
    expect(await boards()).toEqual([]);
    expect((await call('read_board', { board: 'plan' })).isError).toBe(true);
    expect((await call('add_sticky', { board: 'plan', text: 'ещё' })).isError).toBe(true);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/boards`);
    expect(await res.json()).toEqual([]);
    expect((await call('list_deleted_boards')).text).toContain('План');

    expect((await call('restore_board', { board: 'plan' })).text).toContain('возвращена');
    expect(await boards()).toEqual(['plan']);
    expect((await call('read_board', { board: 'plan' })).text).toContain('Пункт');
    expect((await call('restore_board', { board: 'plan' })).isError).toBe(true);
  });

  it('через 7 дней хаб стирает доску насовсем', async () => {
    const doc = await hub.store.get('old');
    addElement(doc, makeSticky('Старое', { x: 0, y: 0, actor: me }));
    await hub.store.flush();
    const file = join(dir, 'old.ydoc');
    expect(await exists(file)).toBe(true);
    const ws = await hub.store.get(WORKSPACE_ID);
    markBoardDeleted(ws, 'old', 'Старое', undefined, 1000);

    expect(await hub.reap(1000 + DELETED_BOARD_KEEP_MS - 1)).toEqual([]);
    expect(await hub.reap(1000 + DELETED_BOARD_KEEP_MS)).toEqual(['old']);
    expect(await exists(file)).toBe(false);
    expect(deletedBoards(ws).get('old')?.purged).toBe(true);
    expect((await call('restore_board', { board: 'old' })).isError).toBe(true);
    expect(await hub.reap(Date.now() + DELETED_BOARD_KEEP_MS * 2)).toEqual([]);
  });

  it('к стёртой доске синхронизация не подключается и её не создаёт', async () => {
    const ws = await hub.store.get(WORKSPACE_ID);
    markBoardDeleted(ws, 'gone', null, undefined, 0);
    await hub.reap();
    const doc = new Y.Doc();
    const client = new SyncClient(doc, {
      url: `ws://127.0.0.1:${hub.port}/sync/gone`,
      WebSocket: WebSocket as unknown as WebSocketCtor,
      minDelayMs: 20,
    });
    const status: string[] = [];
    client.onStatus((s) => status.push(s));
    await new Promise((r) => setTimeout(r, 300));
    const seen = [...status];
    client.destroy();
    expect(seen).not.toContain('synced');
    expect(seen.filter((s) => s === 'connecting').length).toBeLessThanOrEqual(1);
    expect(seen.at(-1)).toBe('offline');
    expect(await hub.store.has('gone')).toBe(false);
  });
});
