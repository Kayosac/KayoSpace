/**
 * Перемещение, масштаб и копирование элементов. Чистые функции: возвращают новый элемент,
 * а записывает его в доску вызывающий код (одной транзакцией на жест).
 */

import {
  decodeStroke,
  encodeStroke,
  strokeBounds,
  type Actor,
  type ArrowEnd,
  type CanvasElement,
} from '@kayospace/model';
import { newId } from './ids';
import { zIndexFor } from './factory';

/** Размер шрифта по умолчанию: у стикера и текста его можно менять масштабом (style.size). */
export const STICKY_FONT_SIZE = 18;
export const TEXT_FONT_SIZE = 20;

export function fontSizeOf(el: CanvasElement): number {
  return el.style.size ?? (el.type === 'sticky' ? STICKY_FONT_SIZE : TEXT_FONT_SIZE);
}

/**
 * Преобразование мира: p' = s·R(r)·p + t — равномерный масштаб s > 0, поворот r (радианы), сдвиг.
 * r нет — 0.
 */
export interface Transform {
  s: number;
  tx: number;
  ty: number;
  r?: number;
}

export const IDENTITY: Transform = { s: 1, tx: 0, ty: 0 };

export function isIdentity(t: Transform): boolean {
  return t.s === 1 && t.tx === 0 && t.ty === 0 && !t.r;
}

/** Применить преобразование к точке. */
export function applyTransform(t: Transform, x: number, y: number): { x: number; y: number } {
  const r = t.r ?? 0;
  if (r === 0) return { x: x * t.s + t.tx, y: y * t.s + t.ty };
  const c = Math.cos(r) * t.s;
  const n = Math.sin(r) * t.s;
  return { x: x * c - y * n + t.tx, y: x * n + y * c + t.ty };
}

/** Масштаб s вокруг неподвижной точки (ax, ay). */
export function scaleAbout(ax: number, ay: number, s: number): Transform {
  return { s, tx: ax * (1 - s), ty: ay * (1 - s) };
}

/** Поворот на r вокруг неподвижной точки (ax, ay). */
export function rotateAbout(ax: number, ay: number, r: number): Transform {
  const c = Math.cos(r);
  const n = Math.sin(r);
  return { s: 1, r, tx: ax - (ax * c - ay * n), ty: ay - (ax * n + ay * c) };
}

const normAngle = (a: number): number => {
  let v = a % (Math.PI * 2);
  if (v <= -Math.PI) v += Math.PI * 2;
  if (v > Math.PI) v -= Math.PI * 2;
  return Math.abs(v) < 1e-9 ? 0 : v;
};

export function transformElement(
  el: CanvasElement,
  t: Transform,
  actor: Actor,
  now: number = Date.now(),
): CanvasElement {
  const meta = { updatedBy: actor, updatedAt: now };
  const r = t.r ?? 0;
  if (el.type === 'arrow') {
    // Концы-точки — в мировых координатах, преобразуются сами; привязка к элементу остаётся.
    const end = (e: ArrowEnd): ArrowEnd =>
      e.kind === 'point' ? { kind: 'point', ...applyTransform(t, e.x, e.y) } : e;
    const start = end(el.props.start);
    const finish = end(el.props.end);
    const pts = [start, finish].filter((e) => e.kind === 'point') as { x: number; y: number }[];
    const corner = applyTransform(t, el.x, el.y);
    const minX = pts.length ? Math.min(...pts.map((p) => p.x)) : corner.x;
    const minY = pts.length ? Math.min(...pts.map((p) => p.y)) : corner.y;
    return {
      ...el,
      ...meta,
      x: minX,
      y: minY,
      w: pts.length === 2 ? Math.abs(pts[0]!.x - pts[1]!.x) : el.w * t.s,
      h: pts.length === 2 ? Math.abs(pts[0]!.y - pts[1]!.y) : el.h * t.s,
      style: t.s === 1 ? el.style : { ...el.style, size: (el.style.size ?? 2) * t.s },
      props: { ...el.props, start, end: finish },
    };
  }
  if (el.type === 'stroke') {
    if (t.s === 1 && r === 0) return { ...el, ...meta, x: el.x + t.tx, y: el.y + t.ty };
    // Поворот и масштаб штриха «запекаются» в точки: rotation у штриха всегда 0.
    const world = decodeStroke(el.props.points).map((p) => {
      const q = applyTransform(t, p.x + el.x, p.y + el.y);
      return { ...p, x: q.x, y: q.y };
    });
    const b = strokeBounds(world);
    const local = world.map((p) => ({ ...p, x: p.x - b.minX, y: p.y - b.minY }));
    return {
      ...el,
      ...meta,
      x: b.minX,
      y: b.minY,
      w: b.maxX - b.minX,
      h: b.maxY - b.minY,
      style: t.s === 1 ? el.style : { ...el.style, size: (el.style.size ?? 4) * t.s },
      props: { ...el.props, points: encodeStroke(local), unit: (el.props.unit ?? 1) * t.s },
    };
  }
  // Элементы-рамки (стикер, текст, фигура, картинка, фрейм): двигается центр, поворот копится.
  const c = applyTransform(t, el.x + el.w / 2, el.y + el.h / 2);
  const w = el.w * t.s;
  const h = el.h * t.s;
  const box = {
    ...meta,
    x: c.x - w / 2,
    y: c.y - h / 2,
    w,
    h,
    rotation: normAngle((el.rotation ?? 0) + r),
  };
  if (t.s === 1) return { ...el, ...box };
  if (el.type === 'sticky' || el.type === 'text') {
    return { ...el, ...box, style: { ...el.style, size: fontSizeOf(el) * t.s } };
  }
  if (el.type === 'shape') {
    return { ...el, ...box, style: { ...el.style, size: (el.style.size ?? 2) * t.s } };
  }
  return { ...el, ...box };
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
  // Рисунок на стикере копируется вместе со стикером и указывает на копию.
  const ids = new Map(ordered.map((el) => [el.id, newId(now)]));
  return ordered.map((el, i) => ({
    ...transformElement(el, { s: 1, tx: dx, ty: dy }, actor, now),
    id: ids.get(el.id)!,
    parentId: el.parentId ? (ids.get(el.parentId) ?? undefined) : undefined,
    // Суффикс держит порядок копий; строка длиннее — всё равно выше всех, созданных раньше.
    z: base + i.toString(36).padStart(4, '0'),
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  }));
}
