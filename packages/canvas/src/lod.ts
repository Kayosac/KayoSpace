/**
 * Упрощённая отрисовка штрихов при отдалении (шаг 1.7).
 *
 * Полный штрих — объединение кругов по всем сэмплам: это точно, но дорого растрировать.
 * Когда штрих на экране тоньше пары пикселей, разница с линией постоянной толщины не видна,
 * поэтому рисуем осевую линию: точки ближе допуска к предыдущей отбрасываются, а соседние
 * такие штрихи одного цвета и толщины идут одним вызовом stroke().
 */

import type { Sample } from '@kayospace/ink';

/** Тоньше этого (пиксели устройства) штрих рисуется упрощённо. */
export const LOD_MAX_WIDTH = 2.5;

/** Средний радиус сэмплов — толщина упрощённой линии. */
export function meanRadius(samples: readonly Sample[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s.r;
  return sum / samples.length;
}

/**
 * Уровень упрощения для масштаба: допуск — половина пикселя устройства, округлённая до степени двойки,
 * чтобы при плавном зуме упрощённая линия пересчитывалась редко (раз на удвоение масштаба).
 */
export function lodLevel(pixelsPerUnit: number): number {
  return Math.floor(Math.log2(0.5 / Math.max(pixelsPerUnit, 1e-9)));
}

/** Осевая линия по сэмплам с допуском tol (мировые единицы): [x0, y0, x1, y1, …]. */
export function simplifyLine(samples: readonly Sample[], tol: number): Float64Array {
  const n = samples.length;
  if (n === 0) return new Float64Array(0);
  const out = new Float64Array(Math.max(4, n * 2));
  let k = 0;
  let lx = samples[0]!.x;
  let ly = samples[0]!.y;
  out[k++] = lx;
  out[k++] = ly;
  const tol2 = tol * tol;
  for (let i = 1; i < n; i++) {
    const s = samples[i]!;
    const dx = s.x - lx;
    const dy = s.y - ly;
    // Последнюю точку оставляем всегда — конец штриха не должен «уползать».
    if (dx * dx + dy * dy >= tol2 || i === n - 1) {
      out[k++] = lx = s.x;
      out[k++] = ly = s.y;
    }
  }
  // Штрих-точка: вторая точка рядом, чтобы скруглённый конец нарисовал кружок.
  if (k === 2) {
    out[k++] = lx + tol * 0.01;
    out[k++] = ly;
  }
  return out.slice(0, k);
}

/** Добавить осевую линию в путь. */
export function appendLine(path: Path2D, pts: Float64Array): void {
  if (pts.length < 4) return;
  path.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i]!, pts[i + 1]!);
}
