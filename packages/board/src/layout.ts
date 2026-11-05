/**
 * Раскладка группы элементов для агентов (решение 0015): сетка, ряд или столбец с ровными промежутками.
 * Чистые функции: позиции считаются здесь, записывает их вызывающий код одной транзакцией.
 */

export type Layout = 'grid' | 'row' | 'column';

export interface LayoutOptions {
  layout: Layout;
  /** Колонок в сетке; по умолчанию — почти квадрат (ceil(√n)). */
  columns?: number;
  /** Промежуток между элементами, по умолчанию 24. */
  gap?: number;
  /** Левый верхний угол раскладки. */
  origin: { x: number; y: number };
}

export interface LayoutResult {
  /** Левые верхние углы — в том же порядке, что и размеры. */
  positions: { x: number; y: number }[];
  /** Сколько заняла раскладка целиком. */
  width: number;
  height: number;
}

/** Ширина колонки — по самому широкому в ней, высота ряда — по самому высокому. */
export function layoutBoxes(
  sizes: readonly { w: number; h: number }[],
  opts: LayoutOptions,
): LayoutResult {
  const n = sizes.length;
  if (n === 0) return { positions: [], width: 0, height: 0 };
  const gap = opts.gap ?? 24;
  const cols =
    opts.layout === 'row'
      ? n
      : opts.layout === 'column'
        ? 1
        : Math.max(1, Math.min(n, Math.floor(opts.columns ?? Math.ceil(Math.sqrt(n)))));
  const rows = Math.ceil(n / cols);
  const colW = Array.from({ length: cols }, () => 0);
  const rowH = Array.from({ length: rows }, () => 0);
  sizes.forEach((s, i) => {
    colW[i % cols] = Math.max(colW[i % cols]!, s.w);
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)]!, s.h);
  });
  const colX = colW.map((_, c) => colW.slice(0, c).reduce((a, w) => a + w + gap, 0));
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((a, h) => a + h + gap, 0));
  return {
    positions: sizes.map((_, i) => ({
      x: opts.origin.x + colX[i % cols]!,
      y: opts.origin.y + rowY[Math.floor(i / cols)]!,
    })),
    width: colW.reduce((a, w) => a + w, 0) + gap * (cols - 1),
    height: rowH.reduce((a, h) => a + h, 0) + gap * (rows - 1),
  };
}
