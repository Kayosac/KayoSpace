/**
 * Камера бесконечного холста.
 * (x, y) — мировая точка в левом верхнем углу экрана, zoom — во сколько раз мир увеличен,
 * rotation — поворот вида (радианы, по часовой стрелке на экране).
 * Экран = R(rotation) · (мир − (x, y)) · zoom. Экранные координаты — CSS-пиксели относительно холста.
 */

import type { Bounds } from '@kayospace/ink';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** Поворот вида, радианы. Нет — 0 (старые сохранённые виды). */
  rotation?: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 40;

export const defaultCamera = (): Camera => ({ x: 0, y: 0, zoom: 1 });

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Угол в диапазоне (−π, π]. */
export function normalizeAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  const r = c.rotation ?? 0;
  if (r === 0) return { x: sx / c.zoom + c.x, y: sy / c.zoom + c.y };
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const ux = sx / c.zoom;
  const uy = sy / c.zoom;
  // R(−r) · u
  return { x: c.x + ux * cos + uy * sin, y: c.y - ux * sin + uy * cos };
}

export function worldToScreen(c: Camera, wx: number, wy: number): { x: number; y: number } {
  const r = c.rotation ?? 0;
  const dx = (wx - c.x) * c.zoom;
  const dy = (wy - c.y) * c.zoom;
  if (r === 0) return { x: dx, y: dy };
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** Камера, при которой мировая точка w оказывается в экранной точке (sx, sy). */
function anchor(
  w: { x: number; y: number },
  sx: number,
  sy: number,
  zoom: number,
  rotation: number,
): Camera {
  const base: Camera = { x: 0, y: 0, zoom, ...(rotation ? { rotation } : {}) };
  const o = screenToWorld(base, sx, sy); // смещение экранной точки при начале в (0, 0)
  return { ...base, x: w.x - o.x, y: w.y - o.y };
}

/** Масштабировать вокруг экранной точки: точка под курсором остаётся на месте. */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number): Camera {
  return anchor(screenToWorld(c, sx, sy), sx, sy, clampZoom(c.zoom * factor), c.rotation ?? 0);
}

/** Повернуть вид вокруг экранной точки на угол da (радианы). */
export function rotateAt(c: Camera, sx: number, sy: number, da: number): Camera {
  const rotation = normalizeAngle((c.rotation ?? 0) + da);
  return anchor(screenToWorld(c, sx, sy), sx, sy, c.zoom, Math.abs(rotation) < 1e-9 ? 0 : rotation);
}

/** Поставить точный угол вида, не сдвигая экранную точку (sx, sy). */
export function setRotationAt(c: Camera, sx: number, sy: number, rotation: number): Camera {
  return rotateAt(c, sx, sy, rotation - (c.rotation ?? 0));
}

/** Сдвинуть на экранные пиксели (палец/трекпад двигают «бумагу»). */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  const o = screenToWorld({ x: 0, y: 0, zoom: c.zoom, rotation: c.rotation ?? 0 }, dx, dy);
  return { ...c, x: c.x - o.x, y: c.y - o.y };
}

/** Видимая область мира (рамка, описанная вокруг повёрнутого экрана) для экрана w × h. */
export function viewBounds(c: Camera, w: number, h: number): Bounds {
  if (!c.rotation) return { minX: c.x, minY: c.y, maxX: c.x + w / c.zoom, maxY: c.y + h / c.zoom };
  const pts = [
    screenToWorld(c, 0, 0),
    screenToWorld(c, w, 0),
    screenToWorld(c, w, h),
    screenToWorld(c, 0, h),
  ];
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Камера, при которой область мира целиком помещается в экран с отступом (поворот вида сохраняется). */
export function fitBounds(b: Bounds, w: number, h: number, padding = 48, rotation = 0): Camera {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  // Размер повёрнутой области на экране при zoom = 1.
  const rw = bw * cos + bh * sin;
  const rh = bw * sin + bh * cos;
  const zoom = clampZoom(Math.min((w - padding * 2) / rw, (h - padding * 2) / rh, 2));
  const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  return anchor(center, w / 2, h / 2, zoom, rotation);
}
