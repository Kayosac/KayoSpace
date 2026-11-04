import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addElement,
  createBoardDoc,
  deleteElement,
  makeArrow,
  makeSticky,
  makeStroke,
  updateElement,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { Scene } from './scene';

const me: Actor = { kind: 'human', name: 'test' };
const line = (x0: number, y0: number, n = 30) =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + i * 4, y: y0, p: 0.5, tx: 0, ty: 0, t: i * 4 }));

describe('сцена', () => {
  it('собирает штрихи доски с рамками и индексом', () => {
    const doc = createBoardDoc();
    addElement(doc, makeStroke(line(0, 0), { hasPressure: true, style: { size: 4 }, actor: me }));
    const sticky = makeSticky('от агента', { x: 1000, y: 0, actor: me });
    addElement(doc, sticky);
    const scene = new Scene(doc);
    expect(scene.size).toBe(2);
    expect(scene.items.get(sticky.id)!.bounds).toEqual({
      minX: 1000,
      minY: 0,
      maxX: 1200,
      maxY: 200,
    });
    const item = [...scene.items.values()].find((i) => i.element.type === 'stroke')!;
    expect(item.bounds.minX).toBeLessThan(1);
    expect(item.bounds.maxX).toBeGreaterThan(110);
    expect(scene.query({ minX: 50, minY: -5, maxX: 60, maxY: 5 })).toHaveLength(1);
    expect(scene.query({ minX: 500, minY: 500, maxX: 600, maxY: 600 })).toHaveLength(0);
  });

  it('обновляется при изменениях доски и сообщает грязные области', () => {
    const doc = createBoardDoc();
    const scene = new Scene(doc);
    const dirty: number[] = [];
    scene.onChange((d) => dirty.push(d.length));
    const s = makeStroke(line(100, 100), { hasPressure: true, actor: me });
    addElement(doc, s);
    expect(scene.size).toBe(1);
    deleteElement(doc, s.id);
    expect(scene.size).toBe(0);
    expect(dirty).toEqual([1, 1]);
  });

  it('видит штрихи, пришедшие с другого устройства', () => {
    const remote = createBoardDoc();
    addElement(remote, makeStroke(line(0, 0), { hasPressure: false, actor: me }));
    const local = createBoardDoc();
    const scene = new Scene(local);
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    expect(scene.size).toBe(1);
  });

  it('ластик находит штрих рядом с точкой и не находит вдали', () => {
    const doc = createBoardDoc();
    const s = makeStroke(line(0, 0), { hasPressure: true, style: { size: 4 }, actor: me });
    addElement(doc, s);
    const scene = new Scene(doc);
    expect(scene.hitTest(40, 3, 2)).toEqual([s.id]);
    expect(scene.hitTest(40, 30, 2)).toEqual([]);
    addElement(doc, makeSticky('не стирается', { x: 0, y: 0, actor: me }));
    expect(scene.hitTest(100, 100, 2)).toEqual([]);
  });

  it('pick находит верхний элемент под точкой', () => {
    const doc = createBoardDoc();
    const s = makeStroke(line(0, 0), { hasPressure: true, style: { size: 4 }, actor: me, now: 1 });
    const st = makeSticky('сверху', { x: 50, y: -50, actor: me, now: 2 });
    addElement(doc, s);
    addElement(doc, st);
    const scene = new Scene(doc);
    expect(scene.pick(20, 4, 3)).toBe(s.id);
    expect(scene.pick(60, 0, 3)).toBe(st.id); // стикер выше штриха
    expect(scene.pick(20, 40, 3)).toBeNull();
  });

  it('рамка содержимого', () => {
    const doc = createBoardDoc();
    const scene = new Scene(doc);
    expect(scene.contentBounds()).toBeNull();
    addElement(doc, makeStroke(line(0, 0), { hasPressure: true, actor: me }));
    addElement(doc, makeStroke(line(500, 300), { hasPressure: true, actor: me }));
    const b = scene.contentBounds()!;
    expect(b.minX).toBeLessThan(1);
    expect(b.maxY).toBeGreaterThan(300);
  });
});

describe('стрелки в сцене', () => {
  it('привязанная стрелка тянется за элементом и пересчитывается при загрузке', () => {
    const doc = createBoardDoc();
    const a = makeSticky('a', { x: 0, y: 0, actor: me });
    const b = makeSticky('b', { x: 400, y: 0, actor: me });
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 1, y: 1 }, { size: 2, actor: me });
    arrow.props.start = { kind: 'element', id: a.id };
    arrow.props.end = { kind: 'element', id: b.id };
    // Стрелка — раньше элементов: при загрузке её концы всё равно на краях стикеров.
    addElement(doc, arrow);
    addElement(doc, a);
    addElement(doc, b);
    const scene = new Scene(doc);
    expect(scene.items.get(arrow.id)!.ends![0].x).toBeCloseTo(206, 6);
    expect(scene.items.get(arrow.id)!.ends![1].x).toBeCloseTo(394, 6);
    let dirty = 0;
    scene.onChange((d) => (dirty += d.length));
    updateElement(doc, b.id, { x: 800 }, me);
    expect(scene.items.get(arrow.id)!.ends![1].x).toBeCloseTo(794, 6);
    expect(dirty).toBeGreaterThanOrEqual(4); // стикер (было/стало) + стрелка (было/стало)
    expect(scene.pick(500, 100, 3)).toBe(arrow.id);
  });
});

describe('рисунок на стикере', () => {
  it('штрих с parentId принадлежит стикеру: pick и список детей', () => {
    const doc = createBoardDoc();
    const st = makeSticky('', { x: 0, y: 0, actor: me });
    const s = { ...makeStroke(line(20, 50), { hasPressure: true, actor: me }), parentId: st.id };
    addElement(doc, st);
    addElement(doc, s);
    const scene = new Scene(doc);
    expect(scene.childrenOf(st.id)).toEqual([s.id]);
    expect(scene.pick(40, 50, 2)).toBe(st.id);
    deleteElement(doc, st.id);
    expect(scene.ownerOf(s.id)).toBe(s.id); // стикера нет — штрих сам по себе
  });

  it('повёрнутый стикер: рамка шире, попадание — по повёрнутому прямоугольнику', () => {
    const doc = createBoardDoc();
    const st = { ...makeSticky('', { x: 0, y: 0, actor: me }), rotation: Math.PI / 4 };
    addElement(doc, st);
    const scene = new Scene(doc);
    const b = scene.items.get(st.id)!.bounds;
    expect(b.maxX - b.minX).toBeCloseTo(200 * Math.SQRT2, 6);
    expect(scene.pick(100, 100, 1)).toBe(st.id); // центр
    expect(scene.pick(5, 5, 1)).toBeNull(); // угол рамки, но вне повёрнутого стикера
  });
});
