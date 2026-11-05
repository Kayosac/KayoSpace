import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_ID,
  addElements,
  deleteElements,
  deletedBoards,
  makeSticky,
  markBoardDeleted,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };

describe('«Очистить корзину» (решение 0022)', () => {
  let dir: string;
  let hub: Hub;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-clear-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
  });
  afterEach(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('стирает удалённое с досок и удалённые доски сразу', async () => {
    const doc = await hub.store.get('notes');
    const s = makeSticky('Лишнее', { x: 0, y: 0, actor: me });
    addElements(doc, [s]);
    deleteElements(doc, [s.id], 'device');
    await hub.store.get('old');
    markBoardDeleted(await hub.store.get(WORKSPACE_ID), 'old', 'Старая');
    const base = `http://127.0.0.1:${hub.port}`;
    await expect.poll(async () => (await hub.trash.groups('notes')).length).toBe(1);
    const r = await fetch(`${base}/api/trash/clear`, { method: 'POST' });
    expect(await r.json()).toEqual({ boards: 1 });
    expect(await hub.trash.groups('notes')).toEqual([]);
    expect(deletedBoards(await hub.store.get(WORKSPACE_ID)).get('old')?.purged).toBe(true);
    expect(await hub.store.has('old')).toBe(false);
  });
});
