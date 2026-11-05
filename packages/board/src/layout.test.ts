import { describe, expect, it } from 'vitest';
import { layoutBoxes } from './layout';

const box = { w: 200, h: 200 };

describe('раскладка для агентов', () => {
  it('сетка: почти квадрат, ровные промежутки, размер всей раскладки', () => {
    const r = layoutBoxes(Array(5).fill(box), { layout: 'grid', origin: { x: 10, y: 20 } });
    expect(r.positions).toEqual([
      { x: 10, y: 20 },
      { x: 234, y: 20 },
      { x: 458, y: 20 },
      { x: 10, y: 244 },
      { x: 234, y: 244 },
    ]);
    expect([r.width, r.height]).toEqual([648, 424]);
  });

  it('ряд и столбец; разные размеры — колонка по самому широкому, ряд по самому высокому', () => {
    const sizes = [
      { w: 100, h: 50 },
      { w: 300, h: 80 },
      { w: 120, h: 40 },
    ];
    expect(
      layoutBoxes(sizes, { layout: 'row', gap: 10, origin: { x: 0, y: 0 } }).positions,
    ).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 420, y: 0 },
    ]);
    const col = layoutBoxes(sizes, { layout: 'column', gap: 10, origin: { x: 0, y: 0 } });
    expect(col.positions.map((p) => p.y)).toEqual([0, 60, 150]);
    expect(col.width).toBe(300);
    const grid = layoutBoxes(sizes, {
      layout: 'grid',
      columns: 2,
      gap: 10,
      origin: { x: 0, y: 0 },
    });
    expect(grid.positions[2]).toEqual({ x: 0, y: 90 });
  });

  it('пусто и неверное число колонок', () => {
    expect(layoutBoxes([], { layout: 'grid', origin: { x: 0, y: 0 } }).positions).toEqual([]);
    const r = layoutBoxes(Array(3).fill(box), {
      layout: 'grid',
      columns: 99,
      origin: { x: 0, y: 0 },
    });
    expect(r.positions.every((p) => p.y === 0)).toBe(true);
  });
});
