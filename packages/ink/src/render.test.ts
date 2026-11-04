import { describe, expect, it } from 'vitest';
import { StrokeBuilder, defaultStrokeStyle, hullQuad, signedArea, strokeSamples } from './render';

const style = { ...defaultStrokeStyle, size: 8, thinning: 0.5, streamline: 0.3 };

const wave = Array.from({ length: 60 }, (_, i) => ({
  x: i * 4,
  y: Math.sin(i / 6) * 30,
  p: 0.2 + (i / 60) * 0.7,
  t: i * 4,
}));

describe('hullQuad', () => {
  it('ориентирован так же, как дуги (положительная площадь)', () => {
    const q = hullQuad({ x: 0, y: 0, r: 3 }, { x: 10, y: 5, r: 2 });
    expect(q).not.toBeNull();
    expect(signedArea(q!)).toBeGreaterThan(0);
    const back = hullQuad({ x: 10, y: 5, r: 2 }, { x: 0, y: 0, r: 3 });
    expect(signedArea(back!)).toBeGreaterThan(0);
  });

  it('возвращает null, если один круг внутри другого', () => {
    expect(hullQuad({ x: 0, y: 0, r: 10 }, { x: 1, y: 0, r: 2 })).toBeNull();
  });
});

describe('StrokeBuilder', () => {
  it('не меняет уже выпущенные сэмплы при добавлении точек', () => {
    const b = new StrokeBuilder(style);
    wave.slice(0, 30).forEach((p) => b.add(p));
    const snapshot = b.samples.map((s) => ({ ...s }));
    wave.slice(30).forEach((p) => b.add(p));
    expect(b.samples.length).toBeGreaterThan(snapshot.length);
    snapshot.forEach((s, i) => expect(b.samples[i]).toEqual(s));
  });

  it('держит радиус в пределах, заданных толщиной и чувствительностью', () => {
    const samples = strokeSamples(wave, style);
    const max = (style.size / 2) * (1 + style.thinning);
    for (const s of samples) {
      expect(s.r).toBeGreaterThan(0);
      expect(s.r).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it('законченный штрих доходит до последней точки пера', () => {
    const samples = strokeSamples(wave, style);
    const last = samples[samples.length - 1]!;
    const end = wave[wave.length - 1]!;
    expect(last.x).toBeCloseTo(end.x, 5);
    expect(last.y).toBeCloseTo(end.y, 5);
  });

  it('разбивает кривую на частые сэмплы (не реже 2 пикселей)', () => {
    const samples = strokeSamples(wave, style);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(2);
    }
  });

  it('одно касание даёт точку', () => {
    expect(strokeSamples([{ x: 5, y: 5, p: 0.5 }], style)).toHaveLength(1);
  });

  it('хвост продолжает стабильную часть без разрыва', () => {
    const b = new StrokeBuilder(style);
    wave.forEach((p) => b.add(p));
    const lastStable = b.samples[b.samples.length - 1]!;
    const tail = b.tail();
    expect(tail.length).toBeGreaterThan(0);
    const first = tail[0]!;
    expect(Math.hypot(first.x - lastStable.x, first.y - lastStable.y)).toBeLessThanOrEqual(2);
  });
});
