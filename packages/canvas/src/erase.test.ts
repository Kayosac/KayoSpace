import { describe, expect, it } from 'vitest';
import { distToSegment, eraseFromPoints } from './erase';

/** Горизонтальная линия из n точек с шагом step. */
const line = (n: number, step = 10) =>
  Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0, p: 0.5, tx: 0, ty: 0, t: i }));

describe('ластик частями', () => {
  it('расстояние до отрезка', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distToSegment(5, 3, a, b)).toBeCloseTo(3, 9);
    expect(distToSegment(-4, 3, a, b)).toBeCloseTo(5, 9);
    expect(distToSegment(2, 2, a, a)).toBeCloseTo(Math.SQRT2 * 2, 9);
  });

  it('не задетый штрих не меняется', () => {
    expect(eraseFromPoints(line(11), { x: 50, y: 30 }, { x: 60, y: 30 }, 5)).toBeNull();
  });

  it('проход поперёк середины режет штрих на два куска с точками разреза на границе', () => {
    const pieces = eraseFromPoints(line(11), { x: 50, y: -20 }, { x: 50, y: 20 }, 5)!;
    expect(pieces).toHaveLength(2);
    const [left, right] = pieces as [ReturnType<typeof line>, ReturnType<typeof line>];
    expect(left[0]!.x).toBe(0);
    expect(left[left.length - 1]!.x).toBeCloseTo(45, 2);
    expect(right[0]!.x).toBeCloseTo(55, 2);
    expect(right[right.length - 1]!.x).toBe(100);
    // Время и давление на разрезе — интерполированы.
    expect(left[left.length - 1]!.t).toBeCloseTo(4.5, 2);
  });

  it('ластик не проскакивает между редкими точками', () => {
    const sparse = line(3, 100); // 0, 100, 200
    const pieces = eraseFromPoints(sparse, { x: 150, y: -10 }, { x: 150, y: 10 }, 4)!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.at(-1)!.x).toBeCloseTo(146, 2);
    expect(pieces[1]![0]!.x).toBeCloseTo(154, 2);
  });

  it('стёртый конец оставляет один кусок', () => {
    const pieces = eraseFromPoints(line(11), { x: 100, y: 0 }, { x: 100, y: 0 }, 15)!;
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.at(-1)!.x).toBeCloseTo(85, 2);
  });

  it('штрих под ластиком целиком исчезает, крошки не остаются', () => {
    expect(eraseFromPoints(line(11), { x: -10, y: 0 }, { x: 110, y: 0 }, 5)).toEqual([]);
    expect(eraseFromPoints(line(1), { x: 0, y: 0 }, { x: 0, y: 0 }, 5)).toEqual([]);
    // Между двумя проходами остаётся обрывок 1 единица — он короче minPiece и выбрасывается.
    const pieces = eraseFromPoints(line(11), { x: 50, y: 0 }, { x: 50, y: 0 }, 49.5, 2)!;
    expect(pieces).toEqual([]);
  });
});
