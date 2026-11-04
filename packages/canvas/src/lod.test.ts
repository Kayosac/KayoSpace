import { describe, expect, it } from 'vitest';
import { LOD_MAX_WIDTH, lodLevel, meanRadius, simplifyLine } from './lod';

const line = (n: number, step: number) =>
  Array.from({ length: n }, (_, i) => ({ x: i * step, y: Math.sin(i / 5) * 3, r: 1 + (i % 3) }));

describe('упрощённая отрисовка штрихов', () => {
  it('отбрасывает точки ближе допуска, первая и последняя остаются', () => {
    const s = line(200, 0.5);
    const full = simplifyLine(s, 0.01);
    expect(full.length).toBe(400);
    const coarse = simplifyLine(s, 5);
    expect(coarse.length / 2).toBeLessThan(30);
    expect([coarse[0], coarse[1]]).toEqual([s[0]!.x, s[0]!.y]);
    expect([coarse.at(-2), coarse.at(-1)]).toEqual([s[199]!.x, s[199]!.y]);
  });

  it('штрих-точка превращается в отрезок нулевой длины — его видно скруглённым концом', () => {
    const pt = simplifyLine([{ x: 3, y: 4, r: 1 }], 1);
    expect(pt.length).toBe(4);
    expect(pt[0]).toBe(3);
    expect(Math.abs(pt[2]! - 3)).toBeLessThan(0.1);
    expect(simplifyLine([], 1).length).toBe(0);
  });

  it('уровень меняется только на удвоении масштаба', () => {
    expect(lodLevel(0.5)).toBe(0);
    expect(lodLevel(0.3)).toBe(0);
    expect(lodLevel(0.25)).toBe(1);
    expect(lodLevel(0.2)).toBe(1);
    expect(lodLevel(2)).toBe(-2);
  });

  it('средняя толщина', () => {
    expect(meanRadius(line(3, 1))).toBe(2);
    expect(meanRadius([])).toBe(0);
    expect(LOD_MAX_WIDTH).toBeGreaterThan(1);
  });
});
