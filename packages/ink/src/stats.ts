/**
 * Скользящая статистика для замеров пера: частота событий, задержка «событие → отрисовка», FPS.
 * Задержка здесь — только часть пути внутри браузера; экран добавляет свои кадры сверху,
 * поэтому финальная проверка — съёмка в slow-motion.
 */

export class RollingSamples {
  private values: number[] = [];
  constructor(private readonly capacity: number) {}

  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.capacity) this.values.shift();
  }

  clear(): void {
    this.values = [];
  }

  get count(): number {
    return this.values.length;
  }

  mean(): number {
    if (this.values.length === 0) return NaN;
    let s = 0;
    for (const v of this.values) s += v;
    return s / this.values.length;
  }

  percentile(q: number): number {
    if (this.values.length === 0) return NaN;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx]!;
  }
}

/** Считает события в окне последних windowMs миллисекунд. */
export class RateMeter {
  private stamps: number[] = [];
  constructor(private readonly windowMs = 1000) {}

  mark(t: number): void {
    this.stamps.push(t);
    this.trim(t);
  }

  rate(now: number): number {
    this.trim(now);
    return (this.stamps.length * 1000) / this.windowMs;
  }

  clear(): void {
    this.stamps = [];
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i]! < cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }
}

export interface InkStatsSnapshot {
  pointerType: string;
  pressure: number;
  maxPressure: number;
  tiltX: number;
  tiltY: number;
  eventHz: number;
  peakEventHz: number;
  coalescedPerEvent: number;
  latencyMean: number;
  latencyP95: number;
  paintMean: number;
  paintP95: number;
  fps: number;
  longFrames: number;
  predictedLast: number;
  rejected: number;
}

export class InkStats {
  pointerType = '—';
  pressure = 0;
  maxPressure = 0;
  tiltX = 0;
  tiltY = 0;
  predictedLast = 0;
  rejected = 0;
  peakEventHz = 0;

  readonly events = new RateMeter(1000);
  readonly frames = new RateMeter(1000);
  readonly latency = new RollingSamples(240);
  readonly coalesced = new RollingSamples(120);
  /** Сколько миллисекунд занимает сама отрисовка кадра. */
  readonly paintCost = new RollingSamples(240);
  /** Кадры, между которыми прошло больше 34 мс (пропущен минимум один кадр при 60 Гц). */
  longFrames = 0;
  private lastFrame = 0;

  sample(e: PointerEvent, coalesced: readonly PointerEvent[]): void {
    this.pointerType = e.pointerType;
    this.pressure = e.pressure;
    if (e.pointerType === 'pen' && e.pressure > this.maxPressure) this.maxPressure = e.pressure;
    this.tiltX = e.tiltX ?? 0;
    this.tiltY = e.tiltY ?? 0;
    for (const c of coalesced) this.events.mark(c.timeStamp);
    this.coalesced.push(coalesced.length);
  }

  painted(eventTime: number, paintTime: number): void {
    const d = paintTime - eventTime;
    if (d >= 0 && d < 1000) this.latency.push(d);
  }

  frame(t: number): void {
    if (this.lastFrame > 0 && t - this.lastFrame > 34) this.longFrames++;
    this.lastFrame = t;
    this.frames.mark(t);
  }

  paintTook(ms: number): void {
    this.paintCost.push(ms);
  }

  reset(): void {
    this.maxPressure = 0;
    this.rejected = 0;
    this.peakEventHz = 0;
    this.longFrames = 0;
    this.events.clear();
    this.latency.clear();
    this.coalesced.clear();
    this.paintCost.clear();
  }

  snapshot(now: number): InkStatsSnapshot {
    const hz = this.events.rate(now);
    if (hz > this.peakEventHz) this.peakEventHz = hz;
    return {
      pointerType: this.pointerType,
      pressure: this.pressure,
      maxPressure: this.maxPressure,
      tiltX: this.tiltX,
      tiltY: this.tiltY,
      eventHz: hz,
      peakEventHz: this.peakEventHz,
      coalescedPerEvent: this.coalesced.mean(),
      latencyMean: this.latency.mean(),
      latencyP95: this.latency.percentile(0.95),
      paintMean: this.paintCost.mean(),
      paintP95: this.paintCost.percentile(0.95),
      fps: this.frames.rate(now),
      longFrames: this.longFrames,
      predictedLast: this.predictedLast,
      rejected: this.rejected,
    };
  }
}
