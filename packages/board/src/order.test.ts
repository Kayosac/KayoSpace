import { describe, expect, it } from 'vitest';
import type { Actor, CanvasElement } from '@kayospace/model';
import { alignDeltas } from './align';
import { makeFrame, makeSticky, zIndexFor } from './factory';
import { keyBetween, reorder } from './order';

const me: Actor = { kind: 'human', name: 't' };
const sticky = (z: string, id: string): CanvasElement => ({
  ...makeSticky('x', { x: 0, y: 0, actor: me }),
  id,
  z,
});
const sortZ = (els: CanvasElement[]) => [...els].sort((a, b) => (a.z < b.z ? -1 : 1));

describe('ключи порядка слоёв', () => {
  it('ключ строго между соседями, в том числе многократно', () => {
    let hi = zIndexFor(1_700_000_000_000);
    for (let i = 0; i < 200; i++) {
      const k = keyBetween('', hi);
      expect(k < hi).toBe(true);
      expect(k > '').toBe(true);
      expect(k.endsWith('0')).toBe(false);
      hi = k;
    }
    expect(hi.length).toBeLessThan(60);
    const a = 'abc';
    const b = 'abd';
    const m = keyBetween(a, b);
    expect(a < m && m < b).toBe(true);
    const top = keyBetween('zz', null);
    expect(top > 'zz').toBe(true);
  });

  it('на передний план: выше всех, ниже элементов, созданных позже; порядок сохраняется', () => {
    const els = [sticky('00a', 'a'), sticky('00b', 'b'), sticky('00c', 'c'), sticky('00d', 'd')];
    const now = 1_800_000_000_000;
    const z = reorder([els[1]!, els[0]!], els, 'front', now);
    const next = els.map((el) => ({ ...el, z: z.get(el.id) ?? el.z }));
    expect(sortZ(next).map((e) => e.id)).toEqual(['c', 'd', 'a', 'b']);
    // Элемент, созданный чуть позже, ляжет выше поднятых.
    expect(zIndexFor(now + 1) > z.get('b')!).toBe(true);
  });

  it('на задний план: ниже всех, но выше фреймов; фреймы не двигаются', () => {
    const frame = { ...makeFrame('Ф', { x: 0, y: 0, w: 10, h: 10 }, { actor: me }), id: 'f' };
    const els = [frame, sticky('00a', 'a'), sticky('00b', 'b'), sticky('00c', 'c')];
    const z = reorder([els[3]!, els[2]!, frame], els, 'back');
    expect(z.has('f')).toBe(false);
    const next = els.map((el) => ({ ...el, z: z.get(el.id) ?? el.z }));
    expect(sortZ(next).map((e) => e.id)).toEqual(['f', 'b', 'c', 'a']);
    // Повторно — ещё ниже, и снова выше фрейма.
    const z2 = reorder([next.find((e) => e.id === 'a')!], next, 'back');
    expect(z2.get('a')! < z.get('b')!).toBe(true);
    expect(z2.get('a')! > frame.z).toBe(true);
  });
});

describe('выравнивание', () => {
  const boxes = [
    { id: 'a', minX: 0, minY: 0, maxX: 10, maxY: 10 },
    { id: 'b', minX: 30, minY: 5, maxX: 50, maxY: 25 },
    { id: 'c', minX: 100, minY: -10, maxX: 110, maxY: 0 },
  ];
  it('по краям и центру', () => {
    expect(alignDeltas(boxes, 'left').get('b')).toEqual({ dx: -30, dy: 0 });
    expect(alignDeltas(boxes, 'left').has('a')).toBe(false);
    expect(alignDeltas(boxes, 'right').get('a')).toEqual({ dx: 100, dy: 0 });
    expect(alignDeltas(boxes, 'top').get('b')).toEqual({ dx: 0, dy: -15 });
    expect(alignDeltas(boxes, 'bottom').get('c')).toEqual({ dx: 0, dy: 25 });
    expect(alignDeltas(boxes, 'center').get('a')).toEqual({ dx: 50, dy: 0 });
    expect(alignDeltas(boxes, 'middle').get('a')).toEqual({ dx: 0, dy: 2.5 });
  });

  it('распределение: равные промежутки, крайние на месте', () => {
    const d = alignDeltas(boxes, 'distribute-x');
    // Ширины 10 + 20 + 10 = 40, пролёт 110 → промежуток 35; b встаёт на 45.
    expect(d.get('b')).toEqual({ dx: 15, dy: 0 });
    expect(d.has('a')).toBe(false);
    expect(d.has('c')).toBe(false);
    expect(alignDeltas(boxes.slice(0, 2), 'distribute-x').size).toBe(0);
    expect(alignDeltas([boxes[0]!], 'left').size).toBe(0);
  });
});
