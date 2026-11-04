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
