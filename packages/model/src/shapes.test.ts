import { describe, expect, it } from 'vitest';
import { CLOSED_SHAPES, shapePolygon } from './shapes';

describe('контуры фигур', () => {
  it('каждая фигура лежит в своей рамке и касается всех её сторон', () => {
    for (const s of CLOSED_SHAPES) {
      const pts = shapePolygon(s, 10, 20, 200, 100);
      expect(pts.length, s).toBeGreaterThanOrEqual(3);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.min(...xs), s).toBeCloseTo(10, 0);
      expect(Math.max(...xs), s).toBeCloseTo(210, 0);
      expect(Math.min(...ys), s).toBeCloseTo(20, 0);
      expect(Math.max(...ys), s).toBeCloseTo(120, 0);
    }
  });
});
