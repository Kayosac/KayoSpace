import { describe, expect, it } from 'vitest';
import { decodeStroke, encodeStroke, strokeBounds, type StrokePoint } from './stroke-codec';

const sample: StrokePoint[] = [
  { x: 0, y: 0, p: 0.1, tx: 0, ty: 0, t: 0 },
  { x: 10.5, y: -3.25, p: 0.5, tx: 12, ty: -8, t: 4 },
  { x: 20, y: 7, p: 0.9, tx: 30, ty: 2, t: 8.5 },
];

describe('stroke codec', () => {
  it('переживает кодирование и декодирование', () => {
    const decoded = decodeStroke(encodeStroke(sample));
    expect(decoded).toHaveLength(sample.length);
    decoded.forEach((pt, i) => {
      const src = sample[i]!;
      expect(pt.x).toBeCloseTo(src.x, 4);
      expect(pt.y).toBeCloseTo(src.y, 4);
      expect(pt.p).toBeCloseTo(src.p, 4);
      expect(pt.t).toBeCloseTo(src.t, 4);
    });
  });

  it('занимает 24 байта на точку плюс заголовок', () => {
    expect(encodeStroke(sample).byteLength).toBe(6 + 3 * 24);
  });

  it('работает с подмассивом (byteOffset ≠ 0)', () => {
    const bytes = encodeStroke(sample);
    const padded = new Uint8Array(bytes.byteLength + 8);
    padded.set(bytes, 8);
    expect(decodeStroke(padded.subarray(8))).toHaveLength(3);
  });

  it('отвергает обрезанные данные', () => {
    const bytes = encodeStroke(sample);
    expect(() => decodeStroke(bytes.subarray(0, 20))).toThrow(/обрезан/);
  });

  it('считает рамку', () => {
    expect(strokeBounds(sample)).toEqual({ minX: 0, minY: -3.25, maxX: 20, maxY: 7 });
  });
});
