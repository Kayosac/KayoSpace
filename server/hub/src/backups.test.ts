import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_ID,
  addElement,
  addProject,
  boardProject,
  getBoardName,
  listElements,
  makeSticky,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { Backups, backupId, keepBackups } from './backups';
import { BoardStore } from './store';
import { startHub } from './hub';

const me: Actor = { kind: 'human', name: 'test' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('какие копии хранить', () => {
  it('двое суток — все, потом по одной в день две недели, потом по одной в неделю', () => {
    const now = Date.UTC(2026, 10, 5, 12);
    // Каждые 6 часов за 90 дней.
    const times = Array.from({ length: 90 * 4 }, (_, i) => now - i * 6 * HOUR);
    const keep = [...keepBackups(times, now)].sort((a, b) => b - a);
    expect(keep[0]).toBe(now);
    const ages = keep.map((t) => (now - t) / DAY);
    expect(ages.filter((a) => a < 2).length).toBe(8);
    expect(ages.filter((a) => a >= 2 && a < 14).length).toBeGreaterThanOrEqual(11);
    expect(ages.filter((a) => a >= 14 && a < 56).length).toBeGreaterThanOrEqual(5);
    expect(ages.every((a) => a < 56)).toBe(true);
    expect(keep.length).toBeLessThan(35);
  });

  it('самая свежая копия остаётся, даже если она старая', () => {
    const now = Date.UTC(2026, 10, 5);
    expect([...keepBackups([now - 400 * DAY], now)]).toEqual([now - 400 * DAY]);
  });

  it('имя папки — время без двоеточий', () => {
    expect(backupId(Date.UTC(2026, 10, 5, 3, 4, 5, 678))).toBe('2026-11-05T03-04-05Z');
  });
});

describe('резервные копии', () => {
  let dir: string;
  let store: BoardStore;
  let now: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-backups-'));
    store = new BoardStore(dir, 10);
    await store.init();
    now = Date.UTC(2026, 10, 5, 3);
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('снимок только при изменениях; восстановление — новой доской в том же проекте', async () => {
    const backups = new Backups(store, { intervalMs: 6 * HOUR, now: () => now });
    const plan = await store.get('plan');
    setBoardName(plan, 'План');
    addElement(plan, makeSticky('Было', { x: 0, y: 0, actor: me }));
    const ws = await store.get(WORKSPACE_ID);
    const project = addProject(ws, 'Работа');
    setBoardProject(ws, 'plan', project);

    const first = await backups.snapshot();
    expect(first?.boards).toEqual([{ id: 'plan', name: 'План', elements: 1 }]);
    now += HOUR;
    expect(await backups.snapshot()).toBeNull(); // ничего не изменилось
    expect(await backups.maybeSnapshot()).toBeNull(); // и рано

    // Доску испортили — восстанавливаем копию рядом.
    for (const el of listElements(plan)) plan.getMap('elements').delete(el.id);
    addElement(plan, makeSticky('Стало', { x: 0, y: 0, actor: me }));
    const made = await backups.restore(first!.id, 'plan');
    expect(made).toEqual({ id: 'plan-copy-20261105', name: 'План (копия от 5 ноября)' });
    const copy = await store.get(made!.id);
    expect(getBoardName(copy)).toBe(made!.name);
    expect(listElements(copy).map((e) => (e.type === 'sticky' ? e.props.content : ''))).toEqual([
      'Было',
    ]);
    expect(boardProject(ws, made!.id)).toBe(project);
    // Исходная доска не тронута; вторая копия того же дня — с номером.
    expect(listElements(plan)).toHaveLength(1);
    expect((await backups.restore(first!.id, 'plan'))?.id).toBe('plan-copy-20261105-2');

    // Через 6 часов изменения попадают в новый снимок.
    now += 6 * HOUR;
    const second = await backups.maybeSnapshot();
    expect(second).not.toBeNull();
    expect((await backups.list()).map((b) => b.id)).toEqual([second!.id, first!.id]);
    expect(await readdir(backups.dir)).not.toContain(expect.stringMatching(/^\.tmp/));
  });

  it('чужие имена не проходят: ни копии, ни служебные документы', async () => {
    const backups = new Backups(store, { intervalMs: HOUR, now: () => now });
    await store.get('plan');
    const b = await backups.snapshot();
    expect(await backups.restore('../../etc', 'plan')).toBeNull();
    expect(await backups.restore(b!.id, '../x')).toBeNull();
    expect(await backups.restore(b!.id, WORKSPACE_ID)).toBeNull();
    expect(await backups.restore(b!.id, 'missing')).toBeNull();
    expect(await backups.get('nope')).toBeNull();
  });
});

describe('REST резервных копий', () => {
  it('список, доски в копии, восстановление; вручную — только администратор', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kayospace-backups-hub-'));
    const hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', token: 'admin-secret' });
    try {
      const base = `http://127.0.0.1:${hub.port}`;
      const admin = { Authorization: 'Bearer admin-secret' };
      const doc = await hub.store.get('notes');
      addElement(doc, makeSticky('Идея', { x: 0, y: 0, actor: me }));
      expect((await fetch(`${base}/api/backups`)).status).toBe(401);

      const made = await (
        await fetch(`${base}/api/backups`, { method: 'POST', headers: admin })
      ).json();
      expect(made.created).toBe(true);
      const list = await (await fetch(`${base}/api/backups`, { headers: admin })).json();
      expect(list.backups).toHaveLength(1);
      const id = list.backups[0].id as string;
      const one = await (await fetch(`${base}/api/backups/${id}`, { headers: admin })).json();
      expect(one.boards).toEqual([{ id: 'notes', name: null, elements: 1 }]);

      const restored = await fetch(`${base}/api/backups/${id}/restore`, {
        method: 'POST',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'notes' }),
      });
      expect(restored.status).toBe(200);
      const { id: copy } = (await restored.json()) as { id: string };
      const boards = (await (await fetch(`${base}/api/boards`, { headers: admin })).json()) as {
        id: string;
      }[];
      expect(boards.map((b) => b.id)).toContain(copy);

      // Устройство видит копии, но снять вручную не может.
      const pairing = await (
        await fetch(`${base}/api/devices/register`, {
          method: 'POST',
          headers: { ...admin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Планшет', platform: 'android' }),
        })
      ).json();
      const device = { Authorization: `Bearer ${pairing.token as string}` };
      expect((await fetch(`${base}/api/backups`, { headers: device })).status).toBe(200);
      expect((await fetch(`${base}/api/backups`, { method: 'POST', headers: device })).status).toBe(
        403,
      );
    } finally {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
