import { describe, expect, it } from 'vitest';
import {
  GRID_STEP,
  closeCamera,
  gridStepFor,
  samplesWorldBounds,
  snappedCamera,
  unionRect,
  wrapText,
} from './renderer';
import { worldToScreen } from './camera';

describe('отрисовка: вспомогательная геометрия', () => {
  it('шаг сетки укрупняется при отдалении и мельчает при приближении', () => {
    expect(gridStepFor(1)).toBe(GRID_STEP);
    for (const z of [0.05, 0.1, 0.3, 1, 2, 5, 40]) {
      const gap = gridStepFor(z) * z; // расстояние между точками на экране
      expect(gap).toBeGreaterThanOrEqual(14);
      expect(gap).toBeLessThan(14 * 4 + 1e-9);
    }
  });

  it('рамка сэмплов учитывает радиус и начальный индекс', () => {
    const s = [
      { x: 0, y: 0, r: 1 },
      { x: 10, y: 5, r: 2 },
      { x: 20, y: -5, r: 0.5 },
    ];
    expect(samplesWorldBounds(s)).toEqual({ minX: -1, minY: -5.5, maxX: 20.5, maxY: 7 });
    expect(samplesWorldBounds(s, 1)).toEqual({ minX: 8, minY: -5.5, maxX: 20.5, maxY: 7 });
    expect(samplesWorldBounds(s, 3)).toBeNull();
  });

  it('объединение прямоугольников', () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(unionRect(null, a)).toBe(a);
    expect(unionRect(a, { x0: -5, y0: 5, x1: 3, y1: 20 })).toEqual({
      x0: -5,
      y0: 0,
      x1: 10,
      y1: 20,
    });
  });
});

describe('перенос текста', () => {
  // Моноширинная «метрика»: 10 единиц на символ.
  const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) };

  it('по словам и по переводам строк', () => {
    expect(wrapText(ctx, 'один два три четыре', 100)).toEqual(['один два', 'три четыре']);
    expect(wrapText(ctx, 'а\nб в', 100)).toEqual(['а', 'б в']);
  });

  it('длинное слово режется', () => {
    expect(wrapText(ctx, 'абвгдежзик', 40)).toEqual(['абвг', 'дежз', 'ик']);
  });
});

describe('сдвиг картинки на целые пиксели', () => {
  it('камера картинки сдвинута на остаток — любой точке мира, с поворотом и без', () => {
    for (const rotation of [0, 0.7]) {
      const cam = { x: 10.3, y: -4.1, zoom: 1.6, rotation };
      const img = snappedCamera(cam, 0.3, -0.2);
      for (const [wx, wy] of [
        [0, 0],
        [120, -40],
        [-7, 300],
      ] as const) {
        const a = worldToScreen(cam, wx, wy);
        const b = worldToScreen(img, wx, wy);
        expect(b.x).toBeCloseTo(a.x - 0.3, 9);
        expect(b.y).toBeCloseTo(a.y + 0.2, 9);
      }
      expect(closeCamera(img, cam, 1.25)).toBe(true);
    }
  });

  it('другая камера — не «та же картинка»', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(closeCamera(cam, { ...cam, x: 3 }, 1)).toBe(false);
    expect(closeCamera(cam, { ...cam, zoom: 1.01 }, 1)).toBe(false);
    expect(closeCamera(cam, { ...cam, rotation: 0.1 }, 1)).toBe(false);
  });
});
