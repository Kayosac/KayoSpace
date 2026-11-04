/**
 * Ластик, который стирает часть штриха, как кисть, а не весь штрих целиком.
 *
 * Штрих хранится как исходные точки, поэтому стирание режет ломаную точек: всё, что попало
 * в «капсулу» ластика (отрезок движения ластика с радиусом r), удаляется, на границах
 * добавляются точки разреза. Оставшиеся куски становятся отдельными штрихами
 * с тем же стилем; их контур пересчитывается из точек, как у любого штриха.
 */

import type { StrokePoint } from '@kayospace/model';

export interface Pt {
  x: number;
  y: number;
}

/** Расстояние от точки до отрезка ab. */
export function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

function lerp(a: StrokePoint, b: StrokePoint, t: number): StrokePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: a.p + (b.p - a.p) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    ty: a.ty + (b.ty - a.ty) * t,
    t: a.t + (b.t - a.t) * t,
  };
}

function pathLength(pts: readonly StrokePoint[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++)
    len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return len;
}

/**
 * Стереть из штриха всё, что попало в капсулу ластика (from → to, радиус r).
 * null — штрих не задет; иначе — оставшиеся куски (пустой массив — штрих стёрт целиком).
 * Совсем короткие обрывки (короче minPiece) выбрасываются, чтобы не оставалось крошек.
 */
export function eraseFromPoints(
  points: readonly StrokePoint[],
  from: Pt,
  to: Pt,
  r: number,
  minPiece = r / 4,
): StrokePoint[][] | null {
  if (points.length === 0) return null;
  const inside = (q: Pt): boolean => distToSegment(q.x, q.y, from, to) <= r;
  if (points.length === 1) return inside(points[0]!) ? [] : null;

  const pieces: StrokePoint[][] = [];
  let cur: StrokePoint[] = [];
  let erased = false;
  let prevIn = inside(points[0]!);
  if (prevIn) erased = true;
  else cur.push(points[0]!);

  // Шаг проверки внутри отрезка: ластик не проскочит между редкими точками быстрого штриха.
  const probe = Math.max(r / 3, 1e-6);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / probe));
    let tPrev = 0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const q = k === steps ? b : lerp(a, b, t);
      const qIn = inside(q);
      if (qIn !== prevIn) {
        // Граница где-то между tPrev и t — уточняем делением пополам.
        let lo = tPrev;
        let hi = t;
        for (let n = 0; n < 12; n++) {
          const m = (lo + hi) / 2;
          if (inside(lerp(a, b, m)) === prevIn) lo = m;
          else hi = m;
        }
        const edge = lerp(a, b, prevIn ? hi : lo);
        if (qIn) {
          cur.push(edge);
          pieces.push(cur);
          cur = [];
          erased = true;
        } else {
          cur = [edge];
        }
      }
      if (!qIn && k === steps) cur.push(b);
      prevIn = qIn;
      tPrev = t;
    }
  }
  if (cur.length > 0) pieces.push(cur);
  if (!erased) return null;
  return pieces.filter((p) => p.length > 0 && pathLength(p) >= minPiece);
}
