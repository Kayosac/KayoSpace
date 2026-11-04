/** Геометрия выделения: лассо, рамка, ручки масштаба. Без DOM — покрыто тестами. */

import type { Bounds } from '@kayospace/ink';
import type { Transform } from '@kayospace/board';
import type { SceneItem } from './scene';

export interface Pt {
  x: number;
  y: number;
}

/** Точка внутри многоугольника (правило чёт-нечет). */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const center = (b: Bounds): Pt => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

/** Попал ли элемент в лассо: штрих — если внутри хотя бы половина его длины, остальное — по центру. */
export function itemInLasso(item: SceneItem, poly: readonly Pt[]): boolean {
  if (poly.length < 3) return false;
  const el = item.element;
  if (el.type === 'frame') {
    // Фрейм — только если обведён целиком (иначе лассо внутри фрейма выделяло бы и его).
    return (
      [
        [el.x, el.y],
        [el.x + el.w, el.y],
        [el.x + el.w, el.y + el.h],
        [el.x, el.y + el.h],
      ] as const
    ).every(([x, y]) => pointInPolygon(x, y, poly));
  }
  const s = item.samples;
  if (item.element.type !== 'stroke' || s.length === 0) {
    const c = center(item.bounds);
    return pointInPolygon(c.x, c.y, poly);
  }
  const step = Math.max(1, Math.floor(s.length / 64));
  let inside = 0;
  let total = 0;
  for (let i = 0; i < s.length; i += step) {
    total++;
    if (pointInPolygon(s[i]!.x, s[i]!.y, poly)) inside++;
  }
  return inside * 2 >= total;
}

/** Задевает ли элемент рамку: штрих — если хоть кусок линии внутри, остальное — по рамке элемента. */
export function itemInRect(item: SceneItem, r: Bounds): boolean {
  const b = item.bounds;
  if (b.maxX < r.minX || b.minX > r.maxX || b.maxY < r.minY || b.minY > r.maxY) return false;
  const el = item.element;
  if (el.type === 'frame') {
    // Фрейм — только если рамка охватывает его целиком.
    return el.x >= r.minX && el.x + el.w <= r.maxX && el.y >= r.minY && el.y + el.h <= r.maxY;
  }
  if (item.element.type !== 'stroke') return true;
  return item.samples.some(
    (s) => s.x + s.r >= r.minX && s.x - s.r <= r.maxX && s.y + s.r >= r.minY && s.y - s.r <= r.maxY,
  );
}

export function rectFromPoints(a: Pt, b: Pt): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function unionBounds(list: Iterable<Bounds>): Bounds | null {
  let out: Bounds | null = null;
  for (const b of list) {
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : { ...b };
  }
  return out;
}

export function transformBounds(b: Bounds, t: Transform): Bounds {
  return {
    minX: b.minX * t.s + t.tx,
    minY: b.minY * t.s + t.ty,
    maxX: b.maxX * t.s + t.tx,
    maxY: b.maxY * t.s + t.ty,
  };
}

/** Углы рамки по часовой стрелке от левого верхнего. */
export function corners(b: Bounds): [Pt, Pt, Pt, Pt] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/** Номер угла, на который попала точка (все в одних координатах), или -1. */
export function handleAt(b: Bounds, x: number, y: number, radius: number): number {
  const cs = corners(b);
  let best = -1;
  let bestD = radius;
  cs.forEach((c, i) => {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * Масштаб при перетаскивании угла: anchor неподвижен, corner — где схватили ручку; масштаб равномерный —
 * по проекции курсора на диагональ. Не меньше minScale.
 */
export function scaleFromHandle(anchor: Pt, corner: Pt, pointer: Pt, minScale = 0.02): number {
  const dx = corner.x - anchor.x;
  const dy = corner.y - anchor.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 1;
  const s = ((pointer.x - anchor.x) * dx + (pointer.y - anchor.y) * dy) / len2;
  return Math.max(minScale, s);
}
