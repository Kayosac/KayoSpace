/**
 * Фреймы: именованные области доски. Без DOM — покрыто тестами.
 *
 * Фрейм всегда ровный (без поворота) и лежит под остальными элементами. Заголовок — над верхней
 * стороной; его высота входит в рамку фрейма, чтобы перерисовка и выбор его задевали.
 * Внутри фрейма — элементы, чей центр попадает в его прямоугольник: они едут, копируются
 * и удаляются вместе с фреймом. Размер фрейма меняется без содержимого.
 */

import { FRAME_TITLE_SIZE } from '@kayospace/board';
import type { Bounds } from '@kayospace/ink';
import type { CanvasElement, FrameElement } from '@kayospace/model';

/** Высота полосы заголовка над фреймом (мировые единицы). */
export function frameTitleBand(el: FrameElement): number {
  return (el.style.size ?? FRAME_TITLE_SIZE) * 1.8;
}

/** Рамка фрейма вместе с заголовком. */
export function frameBounds(el: FrameElement): Bounds {
  return { minX: el.x, minY: el.y - frameTitleBand(el), maxX: el.x + el.w, maxY: el.y + el.h };
}

/** Прямоугольник фрейма без заголовка. */
export function frameBox(el: FrameElement): Bounds {
  return { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
}

/**
 * Попадает ли точка во фрейм для выбора: по заголовку или по краю (в пределах r).
 * Пустая середина фрейма не выбирает его — там работают рамка и лассо, как на пустой доске.
 */
export function frameHit(el: FrameElement, x: number, y: number, r: number): boolean {
  const band = frameTitleBand(el);
  if (x >= el.x - r && x <= el.x + el.w + r && y >= el.y - band && y <= el.y + r) return true;
  const inX = x >= el.x - r && x <= el.x + el.w + r;
  const inY = y >= el.y - r && y <= el.y + el.h + r;
  const nearX = Math.abs(x - el.x) <= r || Math.abs(x - (el.x + el.w)) <= r;
  const nearY = Math.abs(y - el.y) <= r || Math.abs(y - (el.y + el.h)) <= r;
  return (nearX && inY) || (nearY && inX);
}

/** Лежит ли элемент во фрейме: центр его рамки — внутри прямоугольника фрейма. */
export function insideFrame(frame: FrameElement, b: Bounds): boolean {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
}

export const isFrame = (el: CanvasElement | undefined): el is FrameElement => el?.type === 'frame';

/** Название нового фрейма: «Фрейм N», N — на единицу больше самого большого среди существующих. */
export function nextFrameName(existing: Iterable<string>): string {
  let max = 0;
  for (const name of existing) {
    const m = /^Фрейм (\d+)$/.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Фрейм ${max + 1}`;
}

/**
 * Слайды презентации (решение 0017): фреймы в порядке чтения — сверху вниз, в ряду слева направо
 * (как страницы PDF), без вложенных — они видны на слайде своего фрейма.
 */
export function presentationSlides<T extends { id: string; bounds: Bounds }>(
  frames: readonly T[],
): T[] {
  const inside = (a: Bounds, b: Bounds): boolean =>
    a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;
  const top = frames.filter(
    (f) =>
      !frames.some(
        (g) => g.id !== f.id && inside(f.bounds, g.bounds) && !inside(g.bounds, f.bounds),
      ),
  );
  // Ряд — фреймы, чьи верхние края ближе половины высоты первого в ряду.
  const sorted = [...top].sort((a, b) => a.bounds.minY - b.bounds.minY);
  const rows: T[][] = [];
  for (const f of sorted) {
    const row = rows.at(-1);
    const head = row?.[0];
    if (head && f.bounds.minY - head.bounds.minY < (head.bounds.maxY - head.bounds.minY) / 2)
      row.push(f);
    else rows.push([f]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.bounds.minX - b.bounds.minX));
}

/** Ширина страницы PDF на доске (мировые единицы): A4 — 800×1131. */
export const PDF_PAGE_WIDTH = 800;

/**
 * Страницы импортированного PDF (решение 0017): столбцом, каждая — во фрейме своего размера,
 * начиная с точки origin. Возвращает прямоугольники страниц.
 */
export function layoutPages(
  pages: readonly { w: number; h: number }[],
  origin: { x: number; y: number },
  opts: { width?: number; gap?: number } = {},
): { x: number; y: number; w: number; h: number }[] {
  const width = opts.width ?? PDF_PAGE_WIDTH;
  const gap = opts.gap ?? 80;
  let y = origin.y;
  return pages.map((p) => {
    const h = Math.round((width * p.h) / Math.max(1, p.w));
    const box = { x: origin.x, y, w: width, h };
    y += h + gap;
    return box;
  });
}
