import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitBounds,
  normalizeAngle,
  panBy,
  rotateAt,
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

describe('поворот вида', () => {
  const cam = { x: 100, y: 50, zoom: 2, rotation: 0.7 };

  it('перевод координат туда и обратно с поворотом', () => {
    const w = screenToWorld(cam, 40, 20);
    const s = worldToScreen(cam, w.x, w.y);
    expect(s.x).toBeCloseTo(40, 9);
    expect(s.y).toBeCloseTo(20, 9);
  });

  it('зум и поворот оставляют точку под пальцами на месте', () => {
    const before = screenToWorld(cam, 300, 200);
    for (const c of [zoomAt(cam, 300, 200, 1.7), rotateAt(cam, 300, 200, 0.4)]) {
      const after = screenToWorld(c, 300, 200);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
    expect(rotateAt(cam, 0, 0, -0.7).rotation ?? 0).toBe(0);
  });

  it('сдвиг пальцем двигает бумагу вслед за пальцем и при повороте', () => {
    const w = screenToWorld(cam, 100, 100);
    const p = panBy(cam, 30, -10);
    const s = worldToScreen(p, w.x, w.y);
    expect(s.x).toBeCloseTo(130, 9);
    expect(s.y).toBeCloseTo(90, 9);
  });

  it('угол нормализуется, вписывание учитывает поворот', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 9);
    const c = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, 600, 1100, 50, Math.PI / 2);
    expect(c.zoom).toBeCloseTo(1, 6); // повёрнутая на 90° полоса 1000 влезает в высоту 1000
    const mid = worldToScreen(c, 500, 50);
    expect(mid.x).toBeCloseTo(300, 6);
    expect(mid.y).toBeCloseTo(550, 6);
    const v = viewBounds(c, 600, 1100);
    expect(v.minX).toBeLessThan(0);
  });
});
