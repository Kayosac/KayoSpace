/**
 * Порядок слоёв: «на передний план» и «на задний план».
 *
 * z — строка, элементы рисуются по возрастанию (сравнение строк). Новые элементы получают
 * z по времени создания (zIndexFor), поэтому всегда ложатся сверху. Фреймы — с префиксом '!',
 * ниже всего остального (см. makeFrame); порядок слоёв их не трогает.
 */

import type { CanvasElement } from '@kayospace/model';
import { FRAME_Z_PREFIX, zIndexFor } from './factory';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const digit = (i: number): string => DIGITS[i]!;
const index = (ch: string | undefined): number => (ch === undefined ? 0 : DIGITS.indexOf(ch));

/**
 * Ключ строго между a и b (a < b; '' — «минус бесконечность», null — «плюс бесконечность»).
 * Ключи из цифр и латиницы в нижнем регистре; результат не оканчивается на '0',
 * поэтому между ним и соседями всегда найдётся место.
 */
export function keyBetween(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  // Общий префикс (у a недостающие цифры считаются нулями).
  let n = 0;
  while (b !== null && n < b.length && (a[n] ?? '0') === b[n]) n++;
  const prefix = b === null ? '' : b.slice(0, n);
  const ra = a.slice(n);
  const rb = b === null ? null : b.slice(n);
  const da = index(ra[0]);
  const db = rb === null || rb.length === 0 ? DIGITS.length : index(rb[0]);
  if (db - da > 1) return prefix + digit(Math.round((da + db) / 2));
  // Цифры соседние: если у b есть продолжение, подходит его первая цифра без продолжения.
  if (rb !== null && rb.length > 1) return prefix + rb[0];
  // Иначе берём цифру a и ищем место за ней.
  return prefix + digit(da) + keyBetween(ra.slice(1), null);
}

const byZ = (a: CanvasElement, b: CanvasElement): number =>
  a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1;
const isFrame = (el: CanvasElement): boolean => el.type === 'frame';

/**
 * Новые z для выделенных элементов, чтобы они легли поверх всех остальных (или под все),
 * сохраняя порядок между собой. Фреймы пропускаются. all — все элементы доски.
 */
export function reorder(
  selected: readonly CanvasElement[],
  all: Iterable<CanvasElement>,
  where: 'front' | 'back',
  now: number = Date.now(),
): Map<string, string> {
  const moving = selected.filter((el) => !isFrame(el)).sort(byZ);
  const out = new Map<string, string>();
  if (moving.length === 0) return out;
  const ids = new Set(moving.map((el) => el.id));
  let min: string | null = null;
  let max: string | null = null;
  for (const el of all) {
    if (ids.has(el.id) || isFrame(el)) continue;
    if (min === null || el.z < min) min = el.z;
    if (max === null || el.z > max) max = el.z;
  }
  if (where === 'front') {
    // Ниже элементов, которые появятся позже (их z — по времени), но выше всех нынешних.
    const time = zIndexFor(now);
    const base = max !== null && max >= time ? max : time;
    moving.forEach((el, i) => out.set(el.id, base + 'i' + i.toString(36).padStart(4, '0')));
    return out;
  }
  // Под все: ключи между «минус бесконечностью» и нижним элементом, снизу вверх.
  // Ниже фреймов не опускаемся: ключ из цифр всегда больше префикса фреймов '!'.
  let upper = min ?? zIndexFor(now);
  const keys: string[] = [];
  for (let i = moving.length - 1; i >= 0; i--) {
    upper = keyBetween('', upper);
    keys.unshift(upper);
  }
  moving.forEach((el, i) => out.set(el.id, keys[i]!));
  if (FRAME_Z_PREFIX >= keys[0]!) throw new Error('reorder: ключ ниже фреймов');
  return out;
}
