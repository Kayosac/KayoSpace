import { describe, expect, it } from 'vitest';
import {
  addElement,
  cloneElements,
  createBoardDoc,
  makeFrame,
  makeSticky,
  makeStroke,
  transformElement,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { frameBounds, frameHit, insideFrame, nextFrameName } from './frames';
import { Scene, strokeAlpha, strokeStyleFor } from './scene';
import { itemInLasso, itemInRect } from './selection';

const me: Actor = { kind: 'human', name: 'test' };
const frame = makeFrame('План', { x: 0, y: 0, w: 1000, h: 600 }, { actor: me });

describe('фреймы', () => {
  it('лежат под всеми элементами, в том числе после копирования', () => {
    const sticky = makeSticky('x', { x: 10, y: 10, actor: me });
    expect(frame.z < sticky.z).toBe(true);
    const [copy] = cloneElements([frame], 10, 10, me);
    expect(copy!.z < sticky.z).toBe(true);
    expect(copy!.z.startsWith('!')).toBe(true);
  });

  it('выбираются за заголовок и край, но не за пустую середину', () => {
    expect(frameHit(frame, 30, -10, 4)).toBe(true); // заголовок
    expect(frameHit(frame, 0, 300, 4)).toBe(true); // левый край
    expect(frameHit(frame, 998, 599, 4)).toBe(true); // угол
    expect(frameHit(frame, 500, 300, 4)).toBe(false); // середина
    expect(frameHit(frame, 500, -60, 4)).toBe(false); // выше заголовка
    const b = frameBounds(frame);
    expect(b.minY).toBeLessThan(0);
    expect(b.maxY).toBe(600);
  });

  it('содержимое — элементы, чей центр внутри; вложенные фреймы тоже', () => {
    const doc = createBoardDoc();
    addElement(doc, frame);
    const inside = makeSticky('внутри', { x: 100, y: 100, actor: me });
    const edge = makeSticky('на краю', { x: 900, y: 500, actor: me }); // центр 1000, 600 — на границе
    const outside = makeSticky('снаружи', { x: 950, y: 550, actor: me }); // центр 1050, 650
    const inner = makeFrame('Вложенный', { x: 300, y: 300, w: 200, h: 200 }, { actor: me });
    const line = Array.from({ length: 10 }, (_, i) => ({
      x: 400 + i,
      y: 400,
      p: 0.5,
      tx: 0,
      ty: 0,
      t: i,
    }));
    const stroke = makeStroke(line, { hasPressure: true, actor: me });
    for (const el of [inside, edge, outside, inner, stroke]) addElement(doc, el);
    const scene = new Scene(doc);
    const ids = new Set(scene.frameContents(frame.id));
    expect(ids.has(inside.id)).toBe(true);
    expect(ids.has(edge.id)).toBe(true);
    expect(ids.has(outside.id)).toBe(false);
    expect(ids.has(inner.id)).toBe(true);
    expect(ids.has(stroke.id)).toBe(true);
    expect(ids.has(frame.id)).toBe(false);
    expect(scene.frameContents(inner.id)).toEqual([stroke.id]);
    expect(scene.frames().map((f) => f.name)).toEqual(['План', 'Вложенный']);
    // Пустая середина — не выбор фрейма, а пусто (рамка и лассо работают как на доске).
    expect(scene.pick(700, 100, 4)).toBeNull();
    expect(scene.pick(20, -8, 4)).toBe(frame.id);
    expect(insideFrame(frame, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(true);
  });

  it('рамка и лассо выделяют фрейм, только если он внутри целиком', () => {
    const doc = createBoardDoc();
    addElement(doc, frame);
    const item = new Scene(doc).items.get(frame.id)!;
    expect(itemInRect(item, { minX: 10, minY: 10, maxX: 200, maxY: 200 })).toBe(false);
    expect(itemInRect(item, { minX: -10, minY: -40, maxX: 1010, maxY: 610 })).toBe(true);
    const square = (a: number, b: number) => [
      { x: a, y: a },
      { x: b, y: a },
      { x: b, y: b },
      { x: a, y: b },
    ];
    expect(itemInLasso(item, square(10, 300))).toBe(false);
    expect(itemInLasso(item, square(-50, 1100))).toBe(true);
  });

  it('меняет размер без поворота заголовка и без изменения шрифта', () => {
    const big = transformElement(frame, { s: 2, tx: 0, ty: 0 }, me);
    expect([big.w, big.h]).toEqual([2000, 1200]);
    expect(big.style.size).toBe(frame.style.size);
  });

  it('названия по порядку', () => {
    expect(nextFrameName([])).toBe('Фрейм 1');
    expect(nextFrameName(['Фрейм 1', 'План', 'Фрейм 7'])).toBe('Фрейм 8');
  });
});

describe('маркер и выделитель', () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({ x: i * 5, y: 0, p: 0.9, tx: 0, ty: 0, t: i }));
  it('маркер — скошенный наконечник, выделитель — ровный и полупрозрачный', () => {
    const pen = makeStroke(pts, { hasPressure: true, actor: me });
    const marker = makeStroke(pts, { tool: 'marker', hasPressure: true, actor: me });
    const hl = makeStroke(pts, { tool: 'highlighter', hasPressure: true, actor: me });
    expect(strokeStyleFor(pen).thinning).toBeGreaterThan(0);
    expect(strokeStyleFor(marker).thinning).toBe(0);
    expect(strokeStyleFor(marker).nib).toBeDefined();
    expect(strokeStyleFor(pen).nib).toBeUndefined();
    expect(strokeAlpha(marker)).toBeLessThan(1);
    expect(strokeAlpha(marker)).toBeGreaterThan(strokeAlpha(hl));
    expect(strokeStyleFor(hl).simulatePressure).toBe(false);
    expect(strokeAlpha(pen)).toBe(1);
    expect(strokeAlpha(hl)).toBeLessThan(0.5);
  });
});
