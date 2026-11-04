import { describe, expect, it } from 'vitest';
import { addElement, createBoardDoc, makeSticky, makeStroke } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { Scene } from './scene';
import {
  handleAt,
  itemInLasso,
  itemInRect,
  pointInPolygon,
  rectFromPoints,
  scaleFromHandle,
  transformBounds,
  unionBounds,
} from './selection';

const me: Actor = { kind: 'human', name: 'test' };
const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
const hline = (x0: number, x1: number, y: number) =>
  Array.from({ length: 21 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / 20,
    y,
    p: 0.5,
    tx: 0,
    ty: 0,
    t: i * 8,
  }));

function sceneWith(...els: Parameters<typeof addElement>[1][]) {
  const doc = createBoardDoc();
  for (const el of els) addElement(doc, el);
  return new Scene(doc);
}

describe('выделение', () => {
  it('точка в многоугольнике', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
    expect(pointInPolygon(-1, -1, square)).toBe(false);
  });

  it('лассо берёт штрих, если внутри хотя бы половина, и не берёт, если меньше', () => {
    const mostly = makeStroke(hline(10, 130, 50), { hasPressure: true, actor: me });
    const barely = makeStroke(hline(80, 300, 60), { hasPressure: true, actor: me });
    const scene = sceneWith(mostly, barely);
    expect(itemInLasso(scene.items.get(mostly.id)!, square)).toBe(true);
    expect(itemInLasso(scene.items.get(barely.id)!, square)).toBe(false);
  });

  it('лассо берёт стикер по центру', () => {
    const st = makeSticky('x', { x: -50, y: -50, actor: me }); // центр (50, 50)
    const scene = sceneWith(st);
    expect(itemInLasso(scene.items.get(st.id)!, square)).toBe(true);
  });

  it('рамка берёт штрих, если задевает саму линию, а не только её рамку', () => {
    const diag = makeStroke(
      Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: i * 10, p: 0.5, tx: 0, ty: 0, t: i })),
      { hasPressure: true, actor: me },
    );
    const scene = sceneWith(diag);
    const item = scene.items.get(diag.id)!;
    expect(itemInRect(item, rectFromPoints({ x: 90, y: 90 }, { x: 110, y: 110 }))).toBe(true);
    // Угол рамки штриха, далеко от самой диагонали.
    expect(itemInRect(item, rectFromPoints({ x: 170, y: 0 }, { x: 200, y: 30 }))).toBe(false);
  });

  it('объединение и преобразование рамок', () => {
    const b = unionBounds([
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 5, minY: -5, maxX: 20, maxY: 8 },
    ])!;
    expect(b).toEqual({ minX: 0, minY: -5, maxX: 20, maxY: 10 });
    expect(unionBounds([])).toBeNull();
    expect(transformBounds(b, { s: 2, tx: 1, ty: 1 })).toEqual({
      minX: 1,
      minY: -9,
      maxX: 41,
      maxY: 21,
    });
  });

  it('ручки и масштаб от угла', () => {
    const b = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    expect(handleAt(b, 98, 52, 6)).toBe(2);
    expect(handleAt(b, 50, 25, 6)).toBe(-1);
    const anchor = { x: 0, y: 0 };
    const corner = { x: 100, y: 50 };
    expect(scaleFromHandle(anchor, corner, { x: 200, y: 100 })).toBeCloseTo(2, 9);
    expect(scaleFromHandle(anchor, corner, { x: 50, y: 25 })).toBeCloseTo(0.5, 9);
    expect(scaleFromHandle(anchor, corner, { x: -50, y: -50 })).toBe(0.02);
  });
});
