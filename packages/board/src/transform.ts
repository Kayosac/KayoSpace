/**
 * Перемещение, масштаб и копирование элементов. Чистые функции: возвращают новый элемент,
 * а записывает его в доску вызывающий код (одной транзакцией на жест).
 */

import { decodeStroke, encodeStroke, type Actor, type CanvasElement } from '@kayospace/model';
import { newId } from './ids';
import { zIndexFor } from './factory';

/** Размер шрифта по умолчанию: у стикера и текста его можно менять масштабом (style.size). */
export const STICKY_FONT_SIZE = 18;
export const TEXT_FONT_SIZE = 20;

export function fontSizeOf(el: CanvasElement): number {
  return el.style.size ?? (el.type === 'sticky' ? STICKY_FONT_SIZE : TEXT_FONT_SIZE);
}

/** Преобразование мира: x' = s·x + tx, y' = s·y + ty (s > 0 — равномерный масштаб). */
export interface Transform {
  s: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Transform = { s: 1, tx: 0, ty: 0 };

export function isIdentity(t: Transform): boolean {
  return t.s === 1 && t.tx === 0 && t.ty === 0;
}

/** Масштаб s вокруг неподвижной точки (ax, ay). */
export function scaleAbout(ax: number, ay: number, s: number): Transform {
  return { s, tx: ax * (1 - s), ty: ay * (1 - s) };
}

export function transformElement(
  el: CanvasElement,
  t: Transform,
  actor: Actor,
  now: number = Date.now(),
): CanvasElement {
  const meta = { updatedBy: actor, updatedAt: now };
  const x = el.x * t.s + t.tx;
  const y = el.y * t.s + t.ty;
  if (t.s === 1) return { ...el, ...meta, x, y };
  const w = el.w * t.s;
  const h = el.h * t.s;
  if (el.type === 'stroke') {
    // Точки хранятся относительно угла рамки — масштабируются вместе с ней.
    const points = decodeStroke(el.props.points).map((p) => ({ ...p, x: p.x * t.s, y: p.y * t.s }));
    const unit = (el.props.unit ?? 1) * t.s;
    return {
      ...el,
      ...meta,
      x,
      y,
      w,
      h,
      style: { ...el.style, size: (el.style.size ?? 4) * t.s },
      props: { ...el.props, points: encodeStroke(points), unit },
    };
  }
  if (el.type === 'sticky' || el.type === 'text') {
    return { ...el, ...meta, x, y, w, h, style: { ...el.style, size: fontSizeOf(el) * t.s } };
  }
  return { ...el, ...meta, x, y, w, h };
}

/**
 * Копии элементов со сдвигом (dx, dy): новые id, слой — поверх всего, порядок между копиями сохраняется.
 */
export function cloneElements(
  elements: readonly CanvasElement[],
  dx: number,
  dy: number,
  actor: Actor,
  now: number = Date.now(),
): CanvasElement[] {
  const ordered = [...elements].sort((a, b) =>
    a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1,
  );
  const base = zIndexFor(now);
  return ordered.map((el, i) => ({
    ...el,
    id: newId(now),
    x: el.x + dx,
    y: el.y + dy,
    // Суффикс держит порядок копий; строка длиннее — всё равно выше всех, созданных раньше.
    z: base + i.toString(36).padStart(4, '0'),
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  }));
}
