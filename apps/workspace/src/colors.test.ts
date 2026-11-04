import { describe, expect, it } from 'vitest';
import {
  hexToHsv,
  hsvToHex,
  isLight,
  sizeToSlider,
  sliderToSize,
  wheelPick,
  wheelPoint,
} from './colors';

describe('цвет', () => {
  it('HSV ↔ hex туда и обратно', () => {
    for (const hex of ['#e5484d', '#30a46c', '#3e63dd', '#000000', '#ffffff', '#f5d90a']) {
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
    }
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00ff00');
    expect(hsvToHex({ h: 240, s: 1, v: 0.5 })).toBe('#000080');
    expect(hexToHsv('нет')).toBeNull();
  });

  it('круг: угол — тон, радиус — насыщенность, за краем — полная', () => {
    expect(wheelPick(1, 0)).toEqual({ h: 0, s: 1 });
    expect(wheelPick(0, 0.5).h).toBeCloseTo(90);
    expect(wheelPick(0, 2).s).toBe(1);
    const p = wheelPoint(200, 0.4);
    const back = wheelPick(p.x, p.y);
    expect(back.h).toBeCloseTo(200);
    expect(back.s).toBeCloseTo(0.4);
  });

  it('светлый фон или тёмный', () => {
    expect(isLight('#ffe58a')).toBe(true);
    expect(isLight('#3e63dd')).toBe(false);
  });
});

describe('ползунок толщины', () => {
  it('логарифмическая шкала, края и шаг 0,5', () => {
    expect(sliderToSize(0, 0.5, 48)).toBe(0.5);
    expect(sliderToSize(1, 0.5, 48)).toBe(48);
    expect(sliderToSize(0.5, 1, 64)).toBe(8);
    expect(sliderToSize(sizeToSlider(3, 0.5, 48), 0.5, 48)).toBe(3);
    expect(sizeToSlider(1000, 1, 10)).toBe(1);
  });
});
