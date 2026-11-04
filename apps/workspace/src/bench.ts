/**
 * Стенд замера скорости холста (шаг 1.7): доска на 20 000 объектов, загрузка, отрисовка всего экрана
 * на разных масштабах и сдвиг холста кадр за кадром. Открывается дев-сервером: /bench.html
 * (в сборку приложения не входит). ?count=N — другое число объектов.
 * Результат — в window.__bench (его читает e2e/tests/bench.spec.ts) и на экране.
 */

import * as Y from 'yjs';
import { CanvasEngine, fillBenchBoard, type Camera } from '@kayospace/canvas';

export interface BenchResult {
  elements: number;
  /** Загрузка доски: построение сцены и индекса, мс. */
  loadMs: number;
  /** Отрисовка всего экрана (JS), мс — по масштабам. */
  fullPaint: Record<string, { p50: number; max: number; visible: number }>;
  /** Сдвиг холста: интервал между кадрами и время отрисовки кадра, мс. */
  pan: Record<string, { frameP50: number; frameP95: number; paintP50: number; paintP95: number }>;
  /** Плавный зум от 100% до всей доски и обратно (как щипок). */
  zoom: { frameP50: number; frameP95: number; paintP50: number; paintP95: number };
  viewport: { w: number; h: number; dpr: number };
}

declare global {
  interface Window {
    __bench?: BenchResult | { error: string };
  }
}

const out = document.getElementById('out')!;
const stage = document.getElementById('stage')!;
const frame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0;
};
const round = (n: number): number => Math.round(n * 100) / 100;

async function run(): Promise<BenchResult> {
  const count = Number(new URLSearchParams(location.search).get('count') ?? 20_000);
  const doc = new Y.Doc();
  fillBenchBoard(doc, { count });
  const t0 = performance.now();
  const engine = new CanvasEngine(stage, doc, {
    actor: { kind: 'human', name: 'bench' },
    camera: { x: 0, y: 0, zoom: 1 },
  });
  const loadMs = performance.now() - t0;
  (window as { __benchEngine?: CanvasEngine }).__benchEngine = engine;
  await frame();
  await frame();

  const b = engine.scene.contentBounds()!;
  const w = engine.renderer.width;
  const h = engine.renderer.height;
  const centerAt = (zoom: number): Camera => {
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return { x: cx - w / 2 / zoom, y: cy - h / 2 / zoom, zoom };
  };
  const scales: [string, number][] = [
    ['100%', 1],
    ['25%', 0.25],
    ['10%', 0.1],
    // Вся доска на экране.
    ['всё', Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 0.95],
  ];

  const fullPaint: BenchResult['fullPaint'] = {};
  for (const [name, zoom] of scales) {
    engine.setCamera(centerAt(zoom));
    await frame();
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      engine.renderer.invalidateAll();
      const s = performance.now();
      engine.renderer.paint(engine.getCamera(), engine.scene);
      times.push(performance.now() - s);
    }
    fullPaint[name] = {
      p50: round(pct(times, 0.5)),
      max: round(Math.max(...times)),
      visible: engine.scene.query(engine.visibleBounds()).length,
    };
  }

  // Сдвиг: каждый кадр камера уезжает на 1/120 ширины экрана — как перетаскивание пальцем.
  const pan: BenchResult['pan'] = {};
  for (const [name, zoom] of scales) {
    const start = centerAt(zoom);
    engine.setCamera(start);
    await frame();
    await frame();
    const frames: number[] = [];
    const paints: number[] = [];
    let last = await frame();
    for (let i = 1; i <= 90; i++) {
      engine.setCamera({ ...start, x: start.x + (i * w) / 120 / zoom });
      const now = await frame();
      frames.push(now - last);
      paints.push(engine.lastPaintMs);
      last = now;
    }
    pan[name] = {
      frameP50: round(pct(frames, 0.5)),
      frameP95: round(pct(frames, 0.95)),
      paintP50: round(pct(paints, 0.5)),
      paintP95: round(pct(paints, 0.95)),
    };
  }

  // Зум щипком: от 100% до всей доски и обратно за 120 кадров, вокруг центра экрана.
  engine.setCamera(centerAt(1));
  await frame();
  await frame();
  const zf: number[] = [];
  const zp: number[] = [];
  const far = scales[scales.length - 1]![1];
  let last = await frame();
  for (let i = 1; i <= 120; i++) {
    const t = i <= 60 ? i / 60 : (120 - i) / 60;
    const zoom = Math.exp(Math.log(1) * (1 - t) + Math.log(far) * t);
    engine.setCamera(centerAt(zoom));
    const now = await frame();
    zf.push(now - last);
    zp.push(engine.lastPaintMs);
    last = now;
  }
  const zoom = {
    frameP50: round(pct(zf, 0.5)),
    frameP95: round(pct(zf, 0.95)),
    paintP50: round(pct(zp, 0.5)),
    paintP95: round(pct(zp, 0.95)),
  };

  return {
    elements: engine.scene.size,
    zoom,
    loadMs: round(loadMs),
    fullPaint,
    pan,
    viewport: { w, h, dpr: engine.renderer.dpr },
  };
}

run().then(
  (r) => {
    window.__bench = r;
    out.textContent = JSON.stringify(r, null, 2);
  },
  (err: unknown) => {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    window.__bench = { error };
    out.textContent = error;
  },
);
