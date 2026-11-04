import { describe, expect, it } from 'vitest';
import { makeArrow, makeShape } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import {
  arrowEnds,
  arrowHead,
  boxFromDrag,
  clipToBounds,
  outlineDistance,
  shapeBounds,
  snapAngle,
} from './shapes';

const me: Actor = { kind: 'human', name: 'test' };

describe('фигуры', () => {
  it('расстояние до контура прямоугольника и эллипса', () => {
    const r = makeShape('rect', { x: 0, y: 0, w: 100, h: 50 }, { size: 2, actor: me });
    expect(outlineDistance(r, 50, 0)).toBeCloseTo(0, 9);
    expect(outlineDistance(r, 50, 25)).toBeCloseTo(25, 9); // центр — далеко от линии
    const e = makeShape('ellipse', { x: 0, y: 0, w: 100, h: 100 }, { size: 2, actor: me });
    expect(outlineDistance(e, 100, 50)).toBeLessThan(0.5);
    expect(outlineDistance(e, 50, 50)).toBeCloseTo(50, 0);
  });

  it('стрелка: расстояние до линии и рамка с наконечником', () => {
    const a = makeArrow({ x: 0, y: 0 }, { x: 100, y: 0 }, { size: 2, actor: me });
    expect(outlineDistance(a, 50, 7)).toBeCloseTo(7, 9);
    const b = shapeBounds(a);
    expect(b.maxX).toBeGreaterThan(100);
    expect(b.maxY).toBeGreaterThan(1); // полуширина наконечника
    const line = makeArrow({ x: 0, y: 0 }, { x: 100, y: 0 }, { size: 2, heads: 'none', actor: me });
    expect(shapeBounds(line).maxY).toBe(1);
  });

  it('наконечник направлен по линии и не длиннее её большей части', () => {
    const h = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)!;
    expect(h[0]).toEqual({ x: 100, y: 0 });
    expect(h[1].x).toBeLessThan(100);
    expect(h[1].y).toBeCloseTo(-h[2].y, 9);
    const short = arrowHead({ x: 0, y: 0 }, { x: 5, y: 0 }, 2)!;
    expect(short[1].x).toBeGreaterThanOrEqual(2);
    expect(arrowHead({ x: 1, y: 1 }, { x: 1, y: 1 }, 2)).toBeNull();
  });

  it('рамка по перетаскиванию в любую сторону и квадрат с Shift', () => {
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 30 })).toEqual({ x: 0, y: 10, w: 10, h: 20 });
    expect(boxFromDrag({ x: 0, y: 0 }, { x: -10, y: 30 }, true)).toEqual({
      x: -30,
      y: 0,
      w: 30,
      h: 30,
    });
  });

  it('угол линии привязывается к 45°', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(p.y).toBeCloseTo(0, 9);
    const d = snapAngle({ x: 0, y: 0 }, { x: 50, y: 45 });
    expect(d.x).toBeCloseTo(d.y, 9);
  });
});

describe('стрелки, привязанные к элементам', () => {
  const boxes: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {
    a: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    b: { minX: 300, minY: 0, maxX: 400, maxY: 100 },
  };
  const resolve = (id: string) => boxes[id];

  it('концы — на краях элементов по линии между центрами', () => {
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 1, y: 1 }, { size: 2, actor: me });
    arrow.props.start = { kind: 'element', id: 'a' };
    arrow.props.end = { kind: 'element', id: 'b' };
    const [p, q] = arrowEnds(arrow, resolve);
    expect(p).toEqual({ x: 106, y: 50 });
    expect(q).toEqual({ x: 294, y: 50 });
  });

  it('элемента нет — конец по рамке стрелки', () => {
    const arrow = makeArrow({ x: 10, y: 20 }, { x: 50, y: 60 }, { size: 2, actor: me });
    arrow.props.end = { kind: 'element', id: 'нет' };
    expect(arrowEnds(arrow, resolve)[1]).toEqual({ x: 50, y: 60 });
  });

  it('край рамки по лучу', () => {
    expect(clipToBounds(boxes.a!, { x: 50, y: 500 }, 0)).toEqual({ x: 50, y: 100 });
    expect(clipToBounds(boxes.a!, { x: 60, y: 50 }, 0)).toEqual({ x: 50, y: 50 }); // цель внутри
  });
});
