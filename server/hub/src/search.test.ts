import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addElement, makeFrame, makeSticky, makeText, setBoardName } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { searchBoards } from './search';
import { BoardStore } from './store';
import { startHub } from './hub';

const me: Actor = { kind: 'human', name: 'test' };

describe('поиск по доскам', () => {
  it('стикеры, тексты и фреймы на всех досках; начало слова — выше', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kayospace-search-'));
    const store = new BoardStore(dir, 10);
    await store.init();
    try {
      const a = await store.get('plan');
      setBoardName(a, 'План');
      addElement(a, makeSticky('Позвонить в банк', { x: 0, y: 0, actor: me }));
      addElement(a, makeText('Небанковский вопрос', { x: 0, y: 0, w: 100, actor: me }));
      const b = await store.get('home');
      addElement(b, makeFrame('Банк и счета', { x: 0, y: 0, w: 100, h: 100 }, { actor: me }));
      const hits = await searchBoards(store, 'БАНК');
      expect(hits.map((h) => [h.board, h.text])).toEqual([
        ['home', 'Банк и счета'],
        ['plan', 'Позвонить в банк'],
        ['plan', 'Небанковский вопрос'],
      ]);
      expect(hits[1]!.boardName).toBe('План');
      expect(await searchBoards(store, '   ')).toEqual([]);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/search — с токеном, от двух букв', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kayospace-search-hub-'));
    const hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', token: 'secret' });
    try {
      const doc = await hub.store.get('notes');
      addElement(doc, makeSticky('Идея для отпуска', { x: 0, y: 0, actor: me }));
      const base = `http://127.0.0.1:${hub.port}/api/search`;
      expect((await fetch(`${base}?q=идея`)).status).toBe(401);
      const auth = { headers: { Authorization: 'Bearer secret' } };
      const r = await (await fetch(`${base}?q=${encodeURIComponent('отпуск')}`, auth)).json();
      expect(r.hits).toEqual([
        {
          board: 'notes',
          boardName: null,
          id: expect.any(String),
          type: 'sticky',
          text: 'Идея для отпуска',
        },
      ]);
      expect((await (await fetch(`${base}?q=и`, auth)).json()).hits).toEqual([]);
    } finally {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
