import { describe, expect, it } from 'vitest';
import { RateMeter, RollingSamples } from './stats';

describe('RollingSamples', () => {
  it('держит не больше capacity значений', () => {
    const s = new RollingSamples(3);
    [1, 2, 3, 4].forEach((v) => s.push(v));
    expect(s.count).toBe(3);
    expect(s.mean()).toBe(3);
  });

  it('считает перцентиль', () => {
    const s = new RollingSamples(100);
    for (let i = 1; i <= 100; i++) s.push(i);
    expect(s.percentile(0.95)).toBe(95);
    expect(s.percentile(0.5)).toBe(50);
  });

  it('пустой набор даёт NaN', () => {
    expect(new RollingSamples(5).mean()).toBeNaN();
  });
});

describe('RateMeter', () => {
  it('считает события в окне', () => {
    const r = new RateMeter(1000);
    for (let t = 0; t < 1000; t += 4) r.mark(t); // 250 событий за секунду
    expect(r.rate(999)).toBe(250);
  });

  it('забывает старые события', () => {
    const r = new RateMeter(1000);
    r.mark(0);
    r.mark(10);
    expect(r.rate(2000)).toBe(0);
  });
});
