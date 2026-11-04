import { describe, expect, it } from 'vitest';
import { decodeStroke, type Actor } from '@kayospace/model';
import { estimateNoteHeight, makeArrow, makeShape, makeSticky, makeStroke } from './factory';
import {
  STICKY_FONT_SIZE,
  applyTransform,
  cloneElements,
  fontSizeOf,
  isIdentity,
  rotateAbout,
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

describe('фигуры и стрелки', () => {
  it('стрелка: концы двигаются и масштабируются, рамка тоже', () => {
    const a = makeArrow({ x: 0, y: 10 }, { x: 100, y: 60 }, { size: 2, actor: me });
    expect([a.x, a.y, a.w, a.h]).toEqual([0, 10, 100, 50]);
    const m = transformElement(a, scaleAbout(0, 0, 2), me);
    if (m.type !== 'arrow') throw new Error('не стрелка');
    expect(m.props.start).toEqual({ kind: 'point', x: 0, y: 20 });
    expect(m.props.end).toEqual({ kind: 'point', x: 200, y: 120 });
    expect([m.x, m.y, m.w, m.h, m.style.size]).toEqual([0, 20, 200, 100, 4]);
    const copy = cloneElements([a], 5, 5, me)[0]!;
    if (copy.type !== 'arrow') throw new Error('не стрелка');
    expect(copy.props.start).toEqual({ kind: 'point', x: 5, y: 15 });
  });

  it('фигура: толщина линии масштабируется вместе с рамкой', () => {
    const r = makeShape('rect', { x: 0, y: 0, w: 10, h: 20 }, { size: 3, actor: me });
    const m = transformElement(r, scaleAbout(0, 0, 3), me);
    expect([m.w, m.h, m.style.size]).toEqual([30, 60, 9]);
  });
});

describe('высота заметки без измерения шрифта', () => {
  it('короткий стикер — квадрат, длинный — выше; текст — по строкам', () => {
    expect(estimateNoteHeight('привет', 200, { sticky: true })).toBe(200);
    expect(estimateNoteHeight('слово '.repeat(80), 200, { sticky: true })).toBeGreaterThan(200);
    expect(estimateNoteHeight('a\nb\nc', 320, { sticky: false })).toBeCloseTo(3 * 20 * 1.3, 6);
  });
});

describe('поворот элементов', () => {
  it('стикер поворачивается вокруг точки: центр едет по кругу, угол копится', () => {
    const st = makeSticky('x', { x: 0, y: 0, actor: me }); // центр (100, 100)
    const m = transformElement(st, rotateAbout(0, 0, Math.PI / 2), me);
    expect(m.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(m.x + m.w / 2).toBeCloseTo(-100, 9);
    expect(m.y + m.h / 2).toBeCloseTo(100, 9);
    const back = transformElement(m, rotateAbout(0, 0, -Math.PI / 2), me);
    expect(back.rotation).toBe(0);
  });

  it('штрих: поворот запекается в точки, рамка пересчитывается', () => {
    const s = makeStroke(pts, { hasPressure: true, actor: me });
    const m = transformElement(s, rotateAbout(10, 20, Math.PI / 2), me);
    if (m.type !== 'stroke') throw new Error('не штрих');
    expect(m.rotation).toBe(0);
    const world = decodeStroke(m.props.points).map((p) => [p.x + m.x, p.y + m.y]);
    // (30, 60) вокруг (10, 20) на 90° → (−30, 40)
    expect(world[1]![0]).toBeCloseTo(-30, 4);
    expect(world[1]![1]).toBeCloseTo(40, 4);
    expect(m.w).toBeCloseTo(40, 4);
  });

  it('применение преобразования к точке', () => {
    const t = rotateAbout(5, 5, Math.PI);
    const p = applyTransform(t, 10, 5);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(5, 9);
  });
});

describe('копии рисунков на стикере', () => {
  it('ребёнок указывает на копию стикера; без стикера — сам по себе', () => {
    const st = makeSticky('', { x: 0, y: 0, actor: me, now: 1 });
    const child = { ...makeStroke(pts, { hasPressure: true, actor: me, now: 2 }), parentId: st.id };
    const [cs, cc] = cloneElements([st, child], 10, 10, me, 9);
    expect(cc!.parentId).toBe(cs!.id);
    expect(cloneElements([child], 0, 0, me)[0]!.parentId).toBeUndefined();
  });
});
