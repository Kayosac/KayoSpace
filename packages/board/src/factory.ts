/** Создание элементов с заполненными служебными полями. */

import {
  encodeStroke,
  strokeBounds,
  type Actor,
  type ArrowElement,
  type FrameElement,
  type ImageElement,
  type DocElement,
  type ShapeElement,
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
  opts: { x: number; y: number; w?: number; color?: string; actor: Actor; now?: number },
): TextElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'text',
    x: opts.x,
    y: opts.y,
    w: opts.w ?? 320,
    h: 40,
    style: opts.color ? { color: opts.color } : {},
    props: { content: text },
  };
}

/** Прямоугольник или эллипс по рамке (мировые координаты); size — толщина линии. */
export function makeShape(
  shape: 'rect' | 'ellipse',
  box: { x: number; y: number; w: number; h: number },
  opts: { color?: string; size: number; actor: Actor; now?: number },
): ShapeElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'shape',
    ...box,
    style: { size: opts.size, ...(opts.color ? { color: opts.color } : {}) },
    props: { shape },
  };
}

/** Линия или стрелка между двумя точками (мировые координаты). */
export function makeArrow(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: {
    heads?: 'none' | 'end' | 'both';
    color?: string;
    size: number;
    actor: Actor;
    now?: number;
  },
): ArrowElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'arrow',
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
    style: { size: opts.size, ...(opts.color ? { color: opts.color } : {}) },
    props: {
      start: { kind: 'point', x: from.x, y: from.y },
      end: { kind: 'point', x: to.x, y: to.y },
      heads: opts.heads ?? 'end',
    },
  };
}

/**
 * Примерная высота стикера или текста под содержимое — там, где нечем измерить шрифт
 * (хаб, агенты). Устройство при правке пересчитывает высоту точно.
 */
export function estimateNoteHeight(
  text: string,
  w: number,
  opts: { sticky: boolean; fontSize?: number },
): number {
  const font = opts.fontSize ?? (opts.sticky ? 18 : 20);
  const pad = opts.sticky ? font * (16 / 18) : 0;
  const perLine = Math.max(1, Math.floor((w - pad * 2) / (font * 0.55)));
  let lines = 0;
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / perLine));
  const h = lines * font * 1.3 + pad * 2;
  return opts.sticky ? Math.max(w, h) : h;
}

/** Картинка: рамка в мировых координатах, содержимое — по id (SHA-256 файла). */
export function makeImage(
  assetId: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { naturalW: number; naturalH: number; alt?: string; actor: Actor; now?: number },
): ImageElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'image',
    ...box,
    style: {},
    props: {
      assetId,
      naturalW: opts.naturalW,
      naturalH: opts.naturalH,
      ...(opts.alt ? { alt: opts.alt } : {}),
    },
  };
}

/** Размер карточки документа по умолчанию. */
export const DOC_CARD_SIZE = { w: 320, h: 200 } as const;

/** Карточка документа или таблицы (решение 0021): по касанию документ открывается поверх доски. */
export function makeDocCard(
  doc: string,
  at: { x: number; y: number; w?: number; h?: number },
  opts: { title?: string; excerpt?: string; actor: Actor; now?: number },
): DocElement {
  const now = opts.now ?? Date.now();
  return {
    ...base(opts.actor, now),
    type: 'doc',
    x: at.x,
    y: at.y,
    w: at.w ?? DOC_CARD_SIZE.w,
    h: at.h ?? DOC_CARD_SIZE.h,
    style: {},
    props: {
      doc,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.excerpt ? { excerpt: opts.excerpt } : {}),
    },
  };
}

/** Размер шрифта заголовка фрейма при масштабе 100%. */
export const FRAME_TITLE_SIZE = 14;

/**
 * Слой фреймов — ниже всех остальных элементов: '!' меньше любой цифры и буквы,
 * а среди фреймов порядок — по времени создания.
 */
export const FRAME_Z_PREFIX = '!';

/** Фрейм: именованная область, внутри которой лежат элементы. title — размер шрифта заголовка. */
export function makeFrame(
  name: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { actor: Actor; now?: number; titleSize?: number },
): FrameElement {
  const now = opts.now ?? Date.now();
  const b = base(opts.actor, now);
  return {
    ...b,
    z: FRAME_Z_PREFIX + b.z,
    type: 'frame',
    ...box,
    style: { size: opts.titleSize ?? FRAME_TITLE_SIZE },
    props: { name },
  };
}
