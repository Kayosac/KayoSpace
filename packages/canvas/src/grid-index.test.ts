import { describe, expect, it } from 'vitest';
import { GridIndex } from './grid-index';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('сеточный индекс', () => {
  it('находит элементы в области и не находит за её пределами', () => {
    const idx = new GridIndex(100);
    idx.insert('a', box(10, 10, 20, 20));
    idx.insert('b', box(500, 500, 520, 520));
    idx.insert('big', box(-1000, -1000, 1000, 1000));
    expect(idx.query(box(0, 0, 50, 50)).sort()).toEqual(['a', 'big']);
    expect(idx.query(box(490, 490, 600, 600)).sort()).toEqual(['b', 'big']);
    expect(idx.query(box(2000, 2000, 2100, 2100))).toEqual([]);
  });

  it('учитывает точное пересечение рамок, а не только ячейку', () => {
    const idx = new GridIndex(100);
    idx.insert('a', box(10, 10, 20, 20));
    expect(idx.query(box(30, 30, 40, 40))).toEqual([]);
  });

  it('обновляет и удаляет', () => {
    const idx = new GridIndex(100);
    idx.insert('a', box(0, 0, 10, 10));
    idx.insert('a', box(300, 300, 310, 310));
    expect(idx.query(box(0, 0, 50, 50))).toEqual([]);
    expect(idx.query(box(290, 290, 320, 320))).toEqual(['a']);
    idx.remove('a');
    expect(idx.size).toBe(0);
    expect(idx.query(box(290, 290, 320, 320))).toEqual([]);
  });

  it('работает с отрицательными координатами', () => {
    const idx = new GridIndex(64);
    idx.insert('n', box(-150, -150, -140, -140));
    expect(idx.query(box(-160, -160, -100, -100))).toEqual(['n']);
  });
});
