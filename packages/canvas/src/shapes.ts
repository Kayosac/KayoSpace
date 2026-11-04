/** Геометрия фигур и стрелок: рамки, расстояние до контура, наконечники. */

import type { Bounds } from '@kayospace/ink';
import type { ArrowElement, CanvasElement, ShapeElement } from '@kayospace/model';
import { distToSegment, type Pt } from './erase';

export const DEFAULT_LINE = 2;

/** Точка в системе координат элемента-рамки: поворот вокруг центра снят. */
export function toLocal(el: CanvasElement, px: number, py: number): Pt {
  const r = el.rotation ?? 0;
  if (!r) return { x: px, y: py };
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const c = Math.cos(-r);
  const s = Math.sin(-r);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Рамка повёрнутого прямоугольника элемента (с запасом pad), описанная по осям. */
export function boxBounds(el: CanvasElement, pad = 0): Bounds {
  const r = el.rotation ?? 0;
  const hw = el.w / 2 + pad;
  const hh = el.h / 2 + pad;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  return { minX: cx - ex, minY: cy - ey, maxX: cx + ex, maxY: cy + ey };
}

/** Точка внутри повёрнутого прямоугольника элемента. */
export function insideBox(el: CanvasElement, px: number, py: number, pad = 0): boolean {
  const p = toLocal(el, px, py);
  return (
    p.x >= el.x - pad && p.x <= el.x + el.w + pad && p.y >= el.y - pad && p.y <= el.y + el.h + pad
  );
}

/** Длина и полуширина наконечника для линии толщиной size. */
export function headSize(size: number): { len: number; half: number } {
  return { len: size * 4 + 6 * Math.min(1, size), half: size * 2.6 + 3 * Math.min(1, size) };
}

/** Где найти рамку элемента, к которому привязан конец стрелки. */
export type ResolveBounds = (id: string) => Bounds | undefined;

/** Отступ конца стрелки от края элемента, к которому она привязана. */
const ATTACH_GAP = 6;

/** Точка на краю рамки b по лучу из её центра к точке toward (с отступом gap наружу). */
export function clipToBounds(b: Bounds, toward: Pt, gap = ATTACH_GAP): Pt {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  const hw = (b.maxX - b.minX) / 2 + gap;
  const hh = (b.maxY - b.minY) / 2 + gap;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(
    dx !== 0 ? hw / Math.abs(dx) : Infinity,
    dy !== 0 ? hh / Math.abs(dy) : Infinity,
  );
  return t >= 1 ? { x: cx, y: cy } : { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Концы стрелки в мировых координатах. Конец, привязанный к элементу, — на краю его рамки
 * по линии между центрами; элемента нет — по рамке самой стрелки.
 */
export function arrowEnds(el: ArrowElement, resolve?: ResolveBounds): [Pt, Pt] {
  const s = el.props.start;
  const e = el.props.end;
  const sb = s.kind === 'element' ? resolve?.(s.id) : undefined;
  const eb = e.kind === 'element' ? resolve?.(e.id) : undefined;
  const center = (b: Bounds): Pt => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  let a: Pt = s.kind === 'point' ? { x: s.x, y: s.y } : sb ? center(sb) : { x: el.x, y: el.y };
  let b: Pt =
    e.kind === 'point' ? { x: e.x, y: e.y } : eb ? center(eb) : { x: el.x + el.w, y: el.y + el.h };
  const a0 = a;
  if (sb) a = clipToBounds(sb, b);
  if (eb) b = clipToBounds(eb, a0);
  return [a, b];
}

/** Треугольник наконечника в точке tip, направленный от from к tip. */
export function arrowHead(from: Pt, tip: Pt, size: number): [Pt, Pt, Pt] | null {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  const { len: hl, half } = headSize(size);
  const l = Math.min(hl, len * 0.6);
  const h = (half * l) / hl;
  const bx = tip.x - ux * l;
  const by = tip.y - uy * l;
  return [tip, { x: bx - uy * h, y: by + ux * h }, { x: bx + uy * h, y: by - ux * h }];
}

/** Рамка фигуры или стрелки с учётом толщины линии и наконечников. */
export function shapeBounds(el: ShapeElement | ArrowElement, resolve?: ResolveBounds): Bounds {
  const size = el.style.size ?? DEFAULT_LINE;
  if (el.type === 'arrow') {
    const [a, b] = arrowEnds(el, resolve);
    const pad = size / 2 + (el.props.heads === 'none' ? 0 : headSize(size).half);
    return {
      minX: Math.min(a.x, b.x) - pad,
      minY: Math.min(a.y, b.y) - pad,
      maxX: Math.max(a.x, b.x) + pad,
      maxY: Math.max(a.y, b.y) + pad,
    };
  }
  return boxBounds(el, size / 2);
}

/** Многоугольник, приближающий эллипс (для расстояния до контура). */
export function ellipsePolygon(x: number, y: number, w: number, h: number, n = 48): Pt[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + (Math.cos(a) * w) / 2, y: cy + (Math.sin(a) * h) / 2 };
  });
}

function polygonDistance(poly: readonly Pt[], px: number, py: number): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distToSegment(px, py, poly[i]!, poly[(i + 1) % poly.length]!));
  }
  return d;
}

/** Расстояние от точки до линии фигуры или стрелки (до оси линии, без толщины). */
export function outlineDistance(
  el: CanvasElement,
  px: number,
  py: number,
  resolve?: ResolveBounds,
): number {
  if (el.type === 'arrow') {
    const [a, b] = arrowEnds(el, resolve);
    return distToSegment(px, py, a, b);
  }
  if (el.type === 'shape') {
    ({ x: px, y: py } = toLocal(el, px, py));
    if (el.props.shape === 'ellipse') {
      return polygonDistance(ellipsePolygon(el.x, el.y, el.w, el.h), px, py);
    }
    return polygonDistance(
      [
        { x: el.x, y: el.y },
        { x: el.x + el.w, y: el.y },
        { x: el.x + el.w, y: el.y + el.h },
        { x: el.x, y: el.y + el.h },
      ],
      px,
      py,
    );
  }
  return Infinity;
}

/** Прямоугольник по двум углам; square — сделать квадратом (Shift). */
export function boxFromDrag(
  a: Pt,
  b: Pt,
  square = false,
): { x: number; y: number; w: number; h: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  return {
    x: Math.min(a.x, a.x + dx),
    y: Math.min(a.y, a.y + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  };
}

/** Конец линии с привязкой к углу, кратному 45° (Shift). */
export function snapAngle(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}
