/**
 * Камера бесконечного холста.
 * (x, y) — мировые координаты левого верхнего угла экрана, zoom — во сколько раз мир увеличен.
 * Экранные координаты — CSS-пиксели относительно холста.
 */

import type { Bounds } from '@kayospace/ink';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 40;

export const defaultCamera = (): Camera => ({ x: 0, y: 0, zoom: 1 });

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / c.zoom + c.x, y: sy / c.zoom + c.y };
}

export function worldToScreen(c: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - c.x) * c.zoom, y: (wy - c.y) * c.zoom };
}

/** Масштабировать вокруг экранной точки: точка под курсором остаётся на месте. */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  const w = screenToWorld(c, sx, sy);
  return { zoom, x: w.x - sx / zoom, y: w.y - sy / zoom };
}

/** Сдвинуть на экранные пиксели (палец/трекпад двигают «бумагу»). */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom };
}

/** Видимая область мира для экрана размером w × h CSS-пикселей. */
export function viewBounds(c: Camera, w: number, h: number): Bounds {
  return { minX: c.x, minY: c.y, maxX: c.x + w / c.zoom, maxY: c.y + h / c.zoom };
}

/** Камера, при которой область мира целиком помещается в экран с отступом. */
export function fitBounds(b: Bounds, w: number, h: number, padding = 48): Camera {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const zoom = clampZoom(Math.min((w - padding * 2) / bw, (h - padding * 2) / bh, 2));
  return {
    zoom,
    x: b.minX - (w / zoom - bw) / 2,
    y: b.minY - (h / zoom - bh) / 2,
  };
}
