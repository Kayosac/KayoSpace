import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitBounds,
  panBy,
  screenToWorld,
  viewBounds,
  worldToScreen,
  zoomAt,
} from './camera';

describe('камера', () => {
  const cam = { x: 100, y: 50, zoom: 2 };

  it('переводит координаты туда и обратно', () => {
    const w = screenToWorld(cam, 40, 20);
    expect(w).toEqual({ x: 120, y: 60 });
    expect(worldToScreen(cam, w.x, w.y)).toEqual({ x: 40, y: 20 });
  });

  it('зум оставляет точку под курсором на месте', () => {
    const before = screenToWorld(cam, 300, 200);
    const z = zoomAt(cam, 300, 200, 1.5);
    expect(z.zoom).toBe(3);
    const after = screenToWorld(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('ограничивает зум', () => {
    expect(zoomAt(cam, 0, 0, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 0, 0, 0.0001).zoom).toBe(MIN_ZOOM);
  });

  it('сдвиг двигает «бумагу» вслед за пальцем', () => {
    const p = panBy(cam, 20, -10);
    expect(p).toEqual({ x: 90, y: 55, zoom: 2 });
  });

  it('видимая область', () => {
    expect(viewBounds(cam, 800, 600)).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 350 });
  });

  it('вписывает область в экран по центру', () => {
    const c = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 1096, 596, 48);
    expect(c.zoom).toBeCloseTo(1, 9);
    const v = viewBounds(c, 1096, 596);
    expect((v.minX + v.maxX) / 2).toBeCloseTo(500, 6);
    expect((v.minY + v.maxY) / 2).toBeCloseTo(250, 6);
  });
});
