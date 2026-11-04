import { describe, expect, it } from 'vitest';
import { decodeStroke, type Actor } from '@kayospace/model';
import { makeSticky, makeStroke } from './factory';
import {
  STICKY_FONT_SIZE,
  cloneElements,
  fontSizeOf,
  isIdentity,
  scaleAbout,
  transformElement,
} from './transform';

const me: Actor = { kind: 'human', name: 'test' };
const pts = [
  { x: 10, y: 20, p: 0.5, tx: 0, ty: 0, t: 0 },
  { x: 30, y: 60, p: 0.6, tx: 0, ty: 0, t: 8 },
];

describe('преобразование элементов', () => {
  it('сдвиг меняет только положение', () => {
    const s = makeStroke(pts, { hasPressure: true, style: { size: 4 }, actor: me });
    const m = transformElement(s, { s: 1, tx: 5, ty: -7 }, me);
    expect([m.x, m.y, m.w, m.h]).toEqual([15, 13, 20, 40]);
    expect(m.type === 'stroke' && m.props.points).toBe(s.props.points);
  });

  it('масштаб штриха: точки, толщина и unit — пропорционально', () => {
    const s = makeStroke(pts, { hasPressure: true, style: { size: 4 }, actor: me, unit: 0.5 });
    const t = scaleAbout(10, 20, 2); // вокруг первой точки
    const m = transformElement(s, t, me);
    if (m.type !== 'stroke') throw new Error('не штрих');
    expect([m.x, m.y, m.w, m.h]).toEqual([10, 20, 40, 80]);
    expect(m.style.size).toBe(8);
    expect(m.props.unit).toBe(1);
    const world = decodeStroke(m.props.points).map((p) => [p.x + m.x, p.y + m.y]);
    expect(world).toEqual([
      [10, 20],
      [50, 100],
    ]);
  });

  it('масштаб стикера увеличивает и шрифт', () => {
    const st = makeSticky('x', { x: 0, y: 0, actor: me });
    expect(fontSizeOf(st)).toBe(STICKY_FONT_SIZE);
    const m = transformElement(st, scaleAbout(0, 0, 0.5), me);
    expect([m.w, m.h, fontSizeOf(m)]).toEqual([100, 100, STICKY_FONT_SIZE / 2]);
  });

  it('тождественное преобразование', () => {
    expect(isIdentity({ s: 1, tx: 0, ty: 0 })).toBe(true);
    expect(isIdentity(scaleAbout(5, 5, 1.01))).toBe(false);
  });

  it('копии: новые id, сдвиг, порядок слоёв сохранён и выше оригиналов', () => {
    const a = makeStroke(pts, { hasPressure: true, actor: me, now: 1000 });
    const b = makeSticky('b', { x: 0, y: 0, actor: me, now: 2000 });
    const copies = cloneElements([b, a], 24, 24, me, 5000);
    expect(copies).toHaveLength(2);
    expect(copies.map((c) => c.type)).toEqual(['stroke', 'sticky']);
    expect(copies[0]!.id).not.toBe(a.id);
    expect(copies[0]!.x).toBe(a.x + 24);
    expect(copies[0]!.z < copies[1]!.z).toBe(true);
    expect(copies[0]!.z > b.z).toBe(true);
  });
});
