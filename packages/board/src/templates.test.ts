import { describe, expect, it } from 'vitest';
import type { Actor } from '@kayospace/model';
import { BOARD_TEMPLATES, templateElements } from './templates';

const me: Actor = { kind: 'human', name: 'я' };
const overlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('шаблоны досок', () => {
  it('у каждого шаблона есть фреймы; фреймы не налезают друг на друга; id уникальны', () => {
    for (const t of BOARD_TEMPLATES) {
      const els = templateElements(t.id, me);
      const frames = els.filter((e) => e.type === 'frame');
      expect(frames.length, t.id).toBeGreaterThan(1);
      for (const a of frames)
        for (const b of frames) if (a !== b) expect(overlap(a, b), t.id).toBe(false);
      expect(new Set(els.map((e) => e.id)).size).toBe(els.length);
      // Подсказки лежат внутри своих колонок.
      for (const s of els.filter((e) => e.type === 'sticky'))
        expect(frames.some((f) => s.x >= f.x && s.x + s.w <= f.x + f.w)).toBe(true);
    }
  });

  it('канбан — три колонки по порядку', () => {
    const names = templateElements('kanban', me)
      .filter((e) => e.type === 'frame')
      .sort((a, b) => a.x - b.x)
      .map((e) => (e.type === 'frame' ? e.props.name : ''));
    expect(names).toEqual(['Сделать', 'В работе', 'Готово']);
  });
});
