import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from './store';
import { addElement, makeSticky } from '@kayospace/board';

describe('хранилище досок', () => {
  it('параллельные сохранения одной доски не падают', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const store = new BoardStore(dir, 1);
    await store.init();
    const doc = await store.get('race');
    for (let i = 0; i < 20; i++)
      addElement(doc, makeSticky('x' + i, { x: i, y: 0, actor: { kind: 'human', name: 't' } }));
    await Promise.all(Array.from({ length: 10 }, () => store.save('race')));
    await store.close();
    expect(readdirSync(dir)).toEqual(['race.ydoc']);
  });
});
