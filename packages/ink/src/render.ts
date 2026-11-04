/**
 * Отрисовка штриха переменной толщины — свой алгоритм, без внешних зависимостей.
 *
 * 1. Сглаживание дрожи (streamline): каждая точка подтягивается к предыдущей сглаженной.
 * 2. Давление → радиус. Без пера давление имитируется по скорости: быстрее — тоньше.
 * 3. Кривая через середины отрезков (квадратичные сплайны), разбитая на частые сэмплы.
 * 4. Заливка как объединение «капсул»: круг в каждом сэмпле + касательная трапеция между соседями.
 *    Все подконтуры имеют одну ориентацию, поэтому nonzero-заливка даёт чистое объединение
 *    без дыр на резких поворотах.
 *
 * Построение причинное: уже выпущенные сэмплы не меняются при приходе новых точек,
 * поэтому активный штрих можно дорисовывать инкрементально, а заново рисовать только хвост.
 */

export interface PressurePoint {
  x: number;
  y: number;
  p: number;
  /** Время, мс (нужно только для имитации давления по скорости). */
  t?: number;
}

export interface StrokeStyle {
  color: string;
  /** Номинальная толщина в CSS-пикселях (при давлении 0.5). */
  size: number;
  /** Насколько давление меняет толщину, 0..1. */
  thinning: number;
  /** Сглаживание дрожи, 0..1. Больше — глаже, но линия сильнее отстаёт от пера. */
  streamline: number;
  /** Имитировать давление по скорости (для мыши и пальца). */
  simulatePressure: boolean;
}

export const defaultStrokeStyle: StrokeStyle = {
  color: '#16213a',
  size: 4,
  thinning: 0.6,
  streamline: 0.25,
  simulatePressure: false,
};

export interface Sample {
  x: number;
  y: number;
  r: number;
}

const MIN_RADIUS = 0.35;
/** Шаг разбиения кривой в пикселях. */
const SAMPLE_STEP = 1.5;

export class StrokeBuilder {
  /** Стабильные сэмплы: не меняются при добавлении точек. */
  readonly samples: Sample[] = [];
  private smoothed: Sample[] = [];
  private lastRaw: PressurePoint | null = null;
  private pressure = 0.5;

  constructor(private readonly style: StrokeStyle) {}

  get pointCount(): number {
    return this.smoothed.length;
  }

  add(pt: PressurePoint): void {
    const prev = this.smoothed[this.smoothed.length - 1];
    const k = 1 - clamp(this.style.streamline, 0, 0.95);
    const x = prev ? prev.x + (pt.x - prev.x) * k : pt.x;
    const y = prev ? prev.y + (pt.y - prev.y) * k : pt.y;
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 0.05) {
      this.lastRaw = pt;
      return; // точка на месте — пропускаем
    }
    const s: Sample = { x, y, r: this.radiusFor(pt) };
    this.lastRaw = pt;
    this.smoothed.push(s);
    this.emit();
  }

  /**
   * Сэмплы, которые ещё могут измениться: от последней середины до текущей точки,
   * плюс (необязательно) предсказанные точки. Рисуются заново каждый кадр.
   */
  tail(predicted: readonly PressurePoint[] = [], complete = false): Sample[] {
    const n = this.smoothed.length;
    if (n === 0) return [];
    const last = this.smoothed[n - 1]!;
    const start = n >= 2 ? mid(this.smoothed[n - 2]!, last) : last;
    const out: Sample[] = [];
    pushLine(out, start, last);
    let anchor = last;
    // Когда штрих закончен, доводим линию до настоящего положения пера.
    if (complete && this.lastRaw) {
      const end: Sample = { x: this.lastRaw.x, y: this.lastRaw.y, r: last.r };
      pushLine(out, anchor, end);
      anchor = end;
    }
    for (const p of predicted) {
      const s: Sample = { x: p.x, y: p.y, r: anchor.r };
      pushLine(out, anchor, s);
      anchor = s;
    }
    return out;
  }

  /** Все сэмплы законченного штриха. */
  finish(): Sample[] {
    return this.samples.concat(this.tail([], true));
  }

  private emit(): void {
    const s = this.smoothed;
    const n = s.length;
    if (n === 1) {
      this.samples.push({ ...s[0]! });
      return;
    }
    if (n === 2) {
      // Первый кусок: от начала до первой середины, по прямой.
      pushLine(this.samples, s[0]!, mid(s[0]!, s[1]!), true);
      return;
    }
    // Кусок i: от середины (i-2,i-1) до середины (i-1,i) с контрольной точкой i-1.
    const a = mid(s[n - 3]!, s[n - 2]!);
    const c = s[n - 2]!;
    const b = mid(s[n - 2]!, s[n - 1]!);
    pushQuad(this.samples, a, c, b);
  }

  private radiusFor(pt: PressurePoint): number {
    let target: number;
    if (this.style.simulatePressure) {
      const prev = this.lastRaw;
      const dt =
        prev && pt.t !== undefined && prev.t !== undefined ? Math.max(1, pt.t - prev.t) : 8;
      const v = prev ? Math.hypot(pt.x - prev.x, pt.y - prev.y) / dt : 0; // px/мс
      target = 0.75 - Math.min(v / 2.5, 1) * 0.5;
      this.pressure += (target - this.pressure) * 0.35;
    } else {
      target = clamp(pt.p, 0, 1);
      this.pressure += (target - this.pressure) * 0.6;
    }
    const f = 1 + clamp(this.style.thinning, 0, 1) * (2 * this.pressure - 1);
    return Math.max(MIN_RADIUS, (this.style.size / 2) * f);
  }
}

/** Сэмплы законченного штриха по исходным точкам. */
export function strokeSamples(points: readonly PressurePoint[], style: StrokeStyle): Sample[] {
  const b = new StrokeBuilder(style);
  for (const p of points) b.add(p);
  return b.finish();
}

/** Рамка в тех же координатах, что и сэмплы. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Рамка сэмплов с учётом радиуса. null — если сэмплов нет. */
export function samplesBounds(samples: readonly Sample[], from = 0): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = Math.max(0, from); i < samples.length; i++) {
    const s = samples[i]!;
    if (s.x - s.r < minX) minX = s.x - s.r;
    if (s.y - s.r < minY) minY = s.y - s.r;
    if (s.x + s.r > maxX) maxX = s.x + s.r;
    if (s.y + s.r > maxY) maxY = s.y + s.r;
  }
  return Number.isFinite(minX + minY + maxX + maxY) ? { minX, minY, maxX, maxY } : null;
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function circleHits(s: Sample, b: Bounds): boolean {
  return s.x + s.r >= b.minX && s.x - s.r <= b.maxX && s.y + s.r >= b.minY && s.y - s.r <= b.maxY;
}

/**
 * Контур сэмплов (объединение капсул). Его можно закешировать: для законченного штриха он не меняется.
 * from > 0 — продолжение: трапеция к samples[from - 1] тоже добавляется.
 */
export function samplesPath(samples: readonly Sample[], from = 0): Path2D {
  const path = new Path2D();
  const start = Math.max(0, from);
  for (let i = start; i < samples.length; i++) {
    const s = samples[i]!;
    path.moveTo(s.x + s.r, s.y);
    path.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    if (i > 0 && (i > start || from > 0)) addHull(path, samples[i - 1]!, s);
  }
  return path;
}

/**
 * Контур только той части сэмплов, что задевает прямоугольник: для перерисовки небольшого
 * участка не нужно растрировать весь штрих. null — если в прямоугольник ничего не попало.
 */
export function samplesPathInRect(samples: readonly Sample[], rect: Bounds): Path2D | null {
  let path: Path2D | null = null;
  let prevHit = false;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const hit = circleHits(s, rect);
    if (hit || prevHit) {
      path ??= new Path2D();
      if (hit) {
        path.moveTo(s.x + s.r, s.y);
        path.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      }
      if (i > 0) addHull(path, samples[i - 1]!, s);
    }
    prevHit = hit;
  }
  return path;
}

/** Залить последовательность сэмплов как объединение капсул. */
export function fillSamples(
  ctx: CanvasRenderingContext2D,
  samples: readonly Sample[],
  color: string,
  /** Начать с этого индекса (для инкрементальной дорисовки), круг в samples[from] тоже рисуется. */
  from = 0,
): void {
  if (samples.length === 0 || from >= samples.length) return;
  ctx.fillStyle = color;
  ctx.fill(samplesPath(samples, from), 'nonzero');
}

/** Нарисовать законченный штрих целиком. */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  points: readonly PressurePoint[],
  style: StrokeStyle,
): void {
  fillSamples(ctx, strokeSamples(points, style), style.color);
}

/** Тонкая линия по точкам — для подсветки предсказанного хвоста. */
export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  color: string,
  width: number,
): void {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.stroke();
}

// ---------- Геометрия ----------

/**
 * Четыре точки касательной трапеции между двумя кругами, ориентированные так же, как дуги
 * (положительная площадь по формуле шнурования в координатах канвы). null — если один круг внутри другого.
 */
export function hullQuad(a: Sample, b: Sample): [number, number][] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(a.r - b.r) || d < 1e-6) return null;
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos((a.r - b.r) / d);
  const q: [number, number][] = [
    [a.x + a.r * Math.cos(theta + alpha), a.y + a.r * Math.sin(theta + alpha)],
    [a.x + a.r * Math.cos(theta - alpha), a.y + a.r * Math.sin(theta - alpha)],
    [b.x + b.r * Math.cos(theta - alpha), b.y + b.r * Math.sin(theta - alpha)],
    [b.x + b.r * Math.cos(theta + alpha), b.y + b.r * Math.sin(theta + alpha)],
  ];
  if (signedArea(q) < 0) q.reverse();
  return q;
}

export function signedArea(poly: readonly [number, number][]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function addHull(path: Path2D, a: Sample, b: Sample): void {
  const q = hullQuad(a, b);
  if (!q) return;
  path.moveTo(q[0]![0], q[0]![1]);
  for (let i = 1; i < 4; i++) path.lineTo(q[i]![0], q[i]![1]);
  path.closePath();
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const mid = (a: Sample, b: Sample): Sample => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  r: (a.r + b.r) / 2,
});

/** Отрезок a→b разбитый на сэмплы (без точки a, если includeStart = false). */
function pushLine(out: Sample[], a: Sample, b: Sample, includeStart = false): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6 && !includeStart) return; // нулевой отрезок не добавляет сэмплов
  const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  for (let i = includeStart ? 0 : 1; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: a.r + (b.r - a.r) * t });
  }
}

/** Квадратичная кривая a→b с контрольной точкой c, без точки a. */
function pushQuad(out: Sample[], a: Sample, c: Sample, b: Sample): void {
  const len = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
  const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      r: u * u * a.r + 2 * u * t * c.r + t * t * b.r,
    });
  }
}
