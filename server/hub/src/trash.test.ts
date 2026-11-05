import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  addElement,
  deleteElements,
  elementsMap,
  listElements,
  makeFrame,
  makeSticky,
  makeStroke,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { Trash, groupTrash } from './trash';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'test' };
const DAY = 86_400_000;

describe('корзина', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-trash-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('удалённое попадает в корзину пачкой, возвращается, через 7 дней пропадает', async () => {
    let now = 1_000_000_000;
    const trash = new Trash(dir, { agentOrigin: 'mcp', now: () => now, saveDelayMs: 5 });
    const doc = new Y.Doc();
    trash.attach('plan', doc);
    const a = makeSticky('Купить молоко', { x: 0, y: 0, actor: me });
    const pts = [0, 1, 2].map((i) => ({ x: i, y: i, p: 0.5, tx: 0, ty: 0, t: i }));
    const s = makeStroke(pts, { hasPressure: false, actor: me });
    addElement(doc, a);
    addElement(doc, s);
    deleteElements(doc, [a.id, s.id], 'mcp');
    await new Promise((r) => setTimeout(r, 10));
    const groups = await trash.groups('plan');
    expect(groups).toEqual([
      {
        at: now,
        by: 'agent',
        ids: expect.arrayContaining([a.id, s.id]),
        preview: 'стикер «Купить молоко» и ещё 1',
      },
    ]);
    // Штрих переживает запись на диск и чтение: точки — бинарные.
    await trash.flush();
    const again = new Trash(dir, { agentOrigin: 'mcp', now: () => now });
    const stroke = (await again.list('plan')).find((i) => i.element.id === s.id)!.element;
    expect(stroke.type === 'stroke' && stroke.props.points).toBeInstanceOf(Uint8Array);

    expect(await trash.restore('plan', doc, [a.id])).toBe(1);
    expect(listElements(doc).map((e) => e.id)).toEqual([a.id]);
    expect((await trash.list('plan')).map((i) => i.element.id)).toEqual([s.id]);

    now += 8 * DAY;
    expect(await trash.list('plan')).toEqual([]);
    await trash.flush();
  });

  it('удаление отменили на устройстве — из корзины убирается', async () => {
    const trash = new Trash(dir, { agentOrigin: 'mcp' });
    const doc = new Y.Doc();
    trash.attach('plan', doc);
    const a = makeSticky('x', { x: 0, y: 0, actor: me });
    addElement(doc, a);
    deleteElements(doc, [a.id]);
    await new Promise((r) => setTimeout(r, 5));
    expect((await trash.list('plan')).length).toBe(1);
    elementsMap(doc).set(a.id, a); // «Отменить» на устройстве
    await new Promise((r) => setTimeout(r, 5));
    expect(await trash.list('plan')).toEqual([]);
    await trash.flush();
  });

  it('пачки — по действию и автору', () => {
    const el = (id: string) => makeFrame(id, { x: 0, y: 0, w: 1, h: 1 }, { actor: me });
    const g = groupTrash([
      { element: el('a'), deletedAt: 10_000, by: 'device' },
      { element: el('b'), deletedAt: 10_500, by: 'device' },
      { element: el('c'), deletedAt: 10_500, by: 'agent' },
      { element: el('d'), deletedAt: 50_000, by: 'device' },
    ]);
    expect(g.map((x) => [x.by, x.ids.length])).toEqual([
      ['device', 1],
      ['device', 2],
      ['agent', 1],
    ]);
  });
});

describe('корзина, изменения и проекты через хаб', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-trash-hub-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'trash-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError };
  };

  it('агент удалил — в корзине REST и MCP, восстановление возвращает на доску', async () => {
    const doc = await hub.store.get('notes');
    const s = makeSticky('Важное', { x: 0, y: 0, actor: me });
    addElement(doc, s);
    await call('delete_elements', { board: 'notes', ids: [s.id] });
    await new Promise((r) => setTimeout(r, 20));
    const base = `http://127.0.0.1:${hub.port}/api/trash/notes`;
    const rest = (await (await fetch(base)).json()) as {
      groups: { by: string; ids: string[] }[];
      keepDays: number;
    };
    expect(rest.keepDays).toBe(7);
    expect(rest.groups[0]).toMatchObject({ by: 'agent', ids: [s.id] });
    expect(JSON.parse((await call('list_trash', { board: 'notes' })).text).groups).toHaveLength(1);
    // Корзина всех досок — для отдельной панели «Корзина».
    const all = (await (await fetch(`http://127.0.0.1:${hub.port}/api/trash`)).json()) as {
      boards: { board: string; groups: unknown[] }[];
    };
    expect(all.boards.map((b) => [b.board, b.groups.length])).toEqual([['notes', 1]]);

    const r = await fetch(`${base}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [s.id] }),
    });
    expect(await r.json()).toEqual({ restored: 1 });
    expect(listElements(doc).map((e) => e.id)).toEqual([s.id]);
    expect((await call('restore_elements', { board: 'notes', ids: [s.id] })).text).toContain('нет');
  });

  it('get_changes: новое, изменённое и удалённое с указанного времени', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const doc = await hub.store.get('week');
    const a = makeSticky('Пн', { x: 0, y: 0, actor: me });
    const b = makeSticky('Вт', { x: 0, y: 0, actor: me });
    addElement(doc, a);
    addElement(doc, b);
    deleteElements(doc, [b.id]);
    await new Promise((r) => setTimeout(r, 20));
    const out = JSON.parse((await call('get_changes', { since })).text) as {
      boards: {
        board: string;
        changed: { id: string; created: boolean }[];
        deleted: { id: string }[];
      }[];
    };
    const week = out.boards.find((x) => x.board === 'week')!;
    expect(week.changed).toEqual([expect.objectContaining({ id: a.id, created: true })]);
    expect(week.deleted.map((d) => d.id)).toEqual([b.id]);
    expect(
      (await call('get_changes', { since: new Date(Date.now() + 60_000).toISOString() })).text,
    ).toBe('Изменений нет.');
    expect((await call('get_changes', { since: 'вчера' })).isError).toBe(true);
  });

  it('проекты: создать, доска в проекте, переложить, список', async () => {
    const created = (await call('create_project', { name: 'Ремонт' })).text;
    const pid = /: (\S+)\.$/.exec(created)![1]!;
    expect((await call('create_project', { name: 'ремонт' })).text).toContain('уже есть');
    expect(
      (await call('create_board', { board: 'smeta', name: 'Смета', project: 'Ремонт' })).text,
    ).toContain('kayospace://board/smeta');
    await call('create_board', { board: 'loose', name: 'Разное' });
    // Из шаблона — сразу с колонками.
    await call('create_board', { board: 'kanban', name: 'Задачи', template: 'retro' });
    expect(
      listElements(await hub.store.get('kanban')).filter((e) => e.type === 'frame'),
    ).toHaveLength(3);
    let list = JSON.parse((await call('list_projects')).text) as {
      projects: { id: string; boards: { id: string; name: string }[] }[];
      withoutProject: { id: string }[];
    };
    expect(list.projects).toEqual([
      { id: pid, name: 'Ремонт', boards: [{ id: 'smeta', name: 'Смета' }] },
    ]);
    expect(list.withoutProject.map((b) => b.id)).toContain('loose');
    await call('move_board', { board: 'loose', project: pid });
    await call('move_board', { board: 'smeta', project: null });
    list = JSON.parse((await call('list_projects')).text);
    expect(list.projects[0]!.boards.map((b) => b.id)).toEqual(['loose']);
    expect((await call('move_board', { board: 'loose', project: 'Нет такого' })).isError).toBe(
      true,
    );
  });
});
