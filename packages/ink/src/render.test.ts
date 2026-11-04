import { describe, expect, it } from 'vitest';
import {
  StrokeBuilder,
  boundsIntersect,
  defaultStrokeStyle,
  hullQuad,
  samplesBounds,
  signedArea,
  strokeSamples,
} from './render';

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

  it('при любом зуме штрих — тот же, только в другом масштабе (unit)', () => {
    for (const u of [0.025, 0.5, 4]) {
      const scaled = wave.map((p) => ({ ...p, x: p.x * u, y: p.y * u }));
      for (const simulatePressure of [false, true]) {
        const base = strokeSamples(wave, { ...style, simulatePressure });
        const got = strokeSamples(scaled, {
          ...style,
          simulatePressure,
          size: style.size * u,
          unit: u,
        });
        expect(got).toHaveLength(base.length);
        got.forEach((s, i) => {
          const b = base[i]!;
          expect(s.x / u).toBeCloseTo(b.x, 6);
          expect(s.y / u).toBeCloseTo(b.y, 6);
          expect(s.r / u).toBeCloseTo(b.r, 6);
        });
      }
    }
  });
});

describe('samplesBounds', () => {
  it('учитывает радиус', () => {
    expect(
      samplesBounds([
        { x: 0, y: 0, r: 2 },
        { x: 10, y: 5, r: 1 },
      ]),
    ).toEqual({ minX: -2, minY: -2, maxX: 11, maxY: 6 });
  });

  it('пустой набор даёт null', () => {
    expect(samplesBounds([])).toBeNull();
  });

  it('пересечение рамок', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(boundsIntersect(a, { minX: 5, minY: 5, maxX: 20, maxY: 20 })).toBe(true);
    expect(boundsIntersect(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
  });
});

describe('скошенный наконечник (маркер)', () => {
  const nib = { ...style, thinning: 0, nib: { angle: -Math.PI / 4, ratio: 0.25 } };
  const line = (dx: number, dy: number) =>
    Array.from({ length: 40 }, (_, i) => ({ x: i * dx, y: i * dy, p: 0.5, t: i * 8 }));
  const mid = (pts: { x: number; y: number; p: number }[]) => {
    const s = strokeSamples(pts, nib);
    return s[Math.floor(s.length / 2)]!.r;
  };

  it('вдоль узкой кромки — тонко, поперёк — толсто, нажим не влияет', () => {
    const thin = mid(line(3, -3)); // «/» — вдоль кромки
    const thick = mid(line(3, 3)); // «\» — поперёк
    expect(thin).toBeCloseTo((nib.size / 2) * 0.25, 1);
    expect(thick).toBeCloseTo(nib.size / 2, 1);
    const pressed = line(3, 3).map((p) => ({ ...p, p: 1 }));
    expect(mid(pressed)).toBeCloseTo(thick, 6);
  });

  it('построение остаётся причинным', () => {
    const b = new StrokeBuilder(nib);
    wave.slice(0, 30).forEach((p) => b.add(p));
    const snapshot = b.samples.map((s) => ({ ...s }));
    wave.slice(30).forEach((p) => b.add(p));
    snapshot.forEach((s, i) => expect(b.samples[i]).toEqual(s));
  });

  it('толщина меняется плавно, без зубцов от дрожи', () => {
    const shaky = Array.from({ length: 80 }, (_, i) => ({
      x: i * 3,
      y: (i % 2) * 0.4,
      p: 0.5,
      t: i * 8,
    }));
    const s = strokeSamples(shaky, nib);
    for (let i = 1; i < s.length; i++) {
      expect(Math.abs(s[i]!.r - s[i - 1]!.r)).toBeLessThan(nib.size * 0.1);
    }
  });
});
