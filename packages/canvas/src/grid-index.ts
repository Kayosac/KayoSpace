/**
 * Пространственный индекс: мир разбит на квадратные ячейки, элемент записан во все ячейки,
 * которые задевает его рамка. Поиск видимых элементов — по ячейкам видимой области.
 * Проще R-дерева и для рукописных досок не хуже: элементы небольшие и равномерно разбросаны.
 */

import type { Bounds } from '@kayospace/ink';

export class GridIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, Bounds>();

  constructor(readonly cellSize = 512) {}

  get size(): number {
    return this.entries.size;
  }

  bounds(id: string): Bounds | undefined {
    return this.entries.get(id);
  }

  insert(id: string, b: Bounds): void {
    this.remove(id);
    this.entries.set(id, b);
    this.forCells(b, (key) => {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = new Set()));
      cell.add(id);
    });
  }

  remove(id: string): void {
    const b = this.entries.get(id);
    if (!b) return;
    this.entries.delete(id);
    this.forCells(b, (key) => {
      const cell = this.cells.get(key);
      if (!cell) return;
      cell.delete(id);
      if (cell.size === 0) this.cells.delete(key);
    });
  }

  /** id элементов, чьи рамки пересекают область. */
  query(b: Bounds): string[] {
    const out = new Set<string>();
    this.forCells(b, (key) => {
      const cell = this.cells.get(key);
      if (!cell) return;
      for (const id of cell) {
        const e = this.entries.get(id)!;
        if (e.minX <= b.maxX && e.maxX >= b.minX && e.minY <= b.maxY && e.maxY >= b.minY)
          out.add(id);
      }
    });
    return [...out];
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
  }

  private forCells(b: Bounds, fn: (key: string) => void): void {
    const s = this.cellSize;
    const x0 = Math.floor(b.minX / s);
    const x1 = Math.floor(b.maxX / s);
    const y0 = Math.floor(b.minY / s);
    const y1 = Math.floor(b.maxY / s);
    // Очень большая рамка (например, при огромном отдалении) — ограничиваем перебор.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 40_000) {
      for (const key of this.cells.keys()) fn(key);
      return;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(`${x}:${y}`);
  }
}
