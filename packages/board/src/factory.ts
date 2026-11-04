/** Создание элементов с заполненными служебными полями. */

import {
  encodeStroke,
  strokeBounds,
  type Actor,
  type StickyElement,
  type StrokeElement,
  type StrokePoint,
  type StrokeTool,
  type Style,
  type TextElement,
} from '@kayospace/model';
import { newId } from './ids';

const base = (actor: Actor, now: number) => ({
  id: newId(now),
  rotation: 0,
  z: zIndexFor(now),
  createdBy: actor,
  updatedBy: actor,
  createdAt: now,
  updatedAt: now,
});

/**
 * Порядок слоёв. Пока — время создания в base36 фиксированной длины: новые элементы ложатся сверху.
 * Перестановка слоёв (дробные индексы между соседями) появится вместе с командами «выше/ниже».
 */
export function zIndexFor(now: number): string {
  return Math.floor(now).toString(36).padStart(10, '0');
}

/**
 * Штрих из точек в мировых координатах. Точки переводятся в координаты относительно
 * угла рамки и упаковываются бинарно.
 */
export function makeStroke(
  points: readonly StrokePoint[],
  opts: {
    tool?: StrokeTool;
    style?: Style;
    hasPressure: boolean;
    actor: Actor;
    now?: number;
    /** Мировых единиц на экранный пиксель (1 / zoom), см. StrokeProps.unit. */
    unit?: number;
  },
): StrokeElement {
  const now = opts.now ?? Date.now();
  const b = strokeBounds(points);
  const t0 = points[0]?.t ?? 0;
  const local = points.map((p) => ({ ...p, x: p.x - b.minX, y: p.y - b.minY, t: p.t - t0 }));
  return {
    ...base(opts.actor, now),
    type: 'stroke',
    x: b.minX,
    y: b.minY,
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    style: opts.style ?? {},
    props: {
      tool: opts.tool ?? 'pen',
      points: encodeStroke(local),
      hasPressure: opts.hasPressure,
      ...(opts.unit !== undefined && opts.unit !== 1 ? { unit: opts.unit } : {}),
    },
  };
}

export const STICKY_SIZE = 200;

export function makeSticky(
  text: string,
  opts: { x: number; y: number; color?: string; actor: Actor; now?: number },
): StickyElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'sticky',
    x: opts.x,
    y: opts.y,
    w: STICKY_SIZE,
    h: STICKY_SIZE,
    style: { color: opts.color ?? '#ffe58a' },
    props: { content: text, autoSize: true },
  };
}

export function makeText(
  text: string,
  opts: { x: number; y: number; w?: number; actor: Actor; now?: number },
): TextElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'text',
    x: opts.x,
    y: opts.y,
    w: opts.w ?? 320,
    h: 40,
    style: {},
    props: { content: text },
  };
}
