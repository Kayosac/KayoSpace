/**
 * Выравнивание и распределение выделенных элементов по их рамкам (мировые координаты).
 * Возвращает сдвиг для каждого элемента; применяет его вызывающий (transformElement со сдвигом).
 */

export type AlignMode =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  /** Равные промежутки по горизонтали / вертикали (нужно хотя бы три элемента). */
  | 'distribute-x'
  | 'distribute-y';

export interface Box {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function alignDeltas(
  boxes: readonly Box[],
  mode: AlignMode,
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  if (boxes.length < 2) return out;
  const minX = Math.min(...boxes.map((b) => b.minX));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxY = Math.max(...boxes.map((b) => b.maxY));
  const set = (b: Box, dx: number, dy: number): void => {
    if (dx !== 0 || dy !== 0) out.set(b.id, { dx, dy });
  };
  if (mode === 'distribute-x' || mode === 'distribute-y') {
    if (boxes.length < 3) return out;
    const horiz = mode === 'distribute-x';
    const lo = (b: Box): number => (horiz ? b.minX : b.minY);
    const size = (b: Box): number => (horiz ? b.maxX - b.minX : b.maxY - b.minY);
    const sorted = [...boxes].sort((a, b) => lo(a) + size(a) / 2 - (lo(b) + size(b) / 2));
    const span = (horiz ? maxX - minX : maxY - minY) - sorted.reduce((s, b) => s + size(b), 0);
    const gap = span / (sorted.length - 1);
    let at = horiz ? minX : minY;
    for (const b of sorted) {
      const d = at - lo(b);
      set(b, horiz ? d : 0, horiz ? 0 : d);
      at += size(b) + gap;
    }
    return out;
  }
  for (const b of boxes) {
    switch (mode) {
      case 'left':
        set(b, minX - b.minX, 0);
        break;
      case 'right':
        set(b, maxX - b.maxX, 0);
        break;
      case 'center':
        set(b, (minX + maxX) / 2 - (b.minX + b.maxX) / 2, 0);
        break;
      case 'top':
        set(b, 0, minY - b.minY);
        break;
      case 'bottom':
        set(b, 0, maxY - b.maxY);
        break;
      case 'middle':
        set(b, 0, (minY + maxY) / 2 - (b.minY + b.maxY) / 2);
        break;
    }
  }
  return out;
}
