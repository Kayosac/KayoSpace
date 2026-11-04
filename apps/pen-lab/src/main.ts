import './style.css';
import {
  InkStats,
  PenInput,
  RateMeter,
  StrokeBuilder,
  drawPolyline,
  drawStroke,
  fillSamples,
  supportsRawUpdate,
  type InkPoint,
  type RecoveryReason,
  type Sample,
  type StrokeStyle,
} from '@kayospace/ink';
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings';

const VERSION = '0.2.0';

interface Stroke {
  points: InkPoint[];
  style: StrokeStyle;
  example?: boolean;
}

interface ActiveStroke {
  points: InkPoint[];
  predicted: InkPoint[];
  style: StrokeStyle;
  builder: StrokeBuilder;
  /** Сколько стабильных сэмплов уже нарисовано на слое активного штриха. */
  drawnUpTo: number;
  /** Время последнего события, которое ещё не было отрисовано (для замера задержки). */
  pendingEventTime: number | null;
}

/** Прямоугольник в пикселях устройства. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const settings: Settings = loadSettings();
const stats = new InkStats();
const strokes: Stroke[] = [];
let active: ActiveStroke | null = null;
let pressing = false;
let dirty = true;

/** Нужна полная перерисовка (resize, тема, отмена, настройки…). */
let fullRepaint = true;
/** Накопленная область для частичной перерисовки. */
let pendingRegion: Rect | null = null;
/** Где хвост был нарисован в прошлом кадре — его нужно стереть. */
let prevTail: Rect | null = null;

const recoveries: Record<RecoveryReason, number> = {
  'lost-up': 0,
  hover: 0,
  'lost-capture': 0,
  blur: 0,
};
const errors: string[] = [];

const env = {
  tauri: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  rawUpdate: supportsRawUpdate(),
  predicted: typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype,
  coalesced: typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype,
  desyncApplied: false,
};

// ---------- Разметка ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="bar">
    <div class="brand"><b>Kayospace</b><span>Pen Lab</span><em class="badge" id="err-badge" hidden></em></div>
    <div class="actions">
      <button id="btn-undo" type="button" title="Отменить последний штрих (Ctrl/Cmd+Z)">Отменить</button>
      <button id="btn-clear" type="button">Очистить</button>
      <button id="btn-reset" type="button" title="Обнулить счётчики">Сбросить замеры</button>
      <button id="btn-settings" type="button" aria-pressed="false" aria-controls="panel">Настройки</button>
      <button id="btn-report" type="button" class="primary">Отчёт</button>
    </div>
  </header>
  <dl class="readouts" aria-live="off">
    <div class="readout"><dt>Ввод</dt><dd id="r-type">—</dd></div>
    <div class="readout"><dt>Давление</dt><dd id="r-pressure">—</dd><div class="pressure-meter"><i id="r-pressure-bar"></i></div></div>
    <div class="readout"><dt>Макс. давл.</dt><dd id="r-maxp">—</dd></div>
    <div class="readout"><dt>Наклон X / Y</dt><dd id="r-tilt">—</dd></div>
    <div class="readout"><dt>События пера</dt><dd id="r-hz">—</dd></div>
    <div class="readout"><dt>Склейка</dt><dd id="r-coal">—</dd></div>
    <div class="readout key"><dt>Задержка ср.</dt><dd id="r-lat">—</dd></div>
    <div class="readout"><dt>Задержка p95</dt><dd id="r-p95">—</dd></div>
    <div class="readout"><dt>Отрисовка</dt><dd id="r-paint">—</dd></div>
    <div class="readout"><dt>Кадры</dt><dd id="r-fps">—</dd></div>
  </dl>
  <main class="work">
    <div class="stage" id="stage" aria-label="Холст для рисования"></div>
    <p class="hint" id="hint"><strong>Это пример штриха.</strong> Нажмите «Очистить» и рисуйте пером: показания сверху обновляются на лету. Для замера на камеру включите в настройках вспышку при касании и снимите экран в slow-motion.</p>
    <aside class="panel" id="panel" hidden>
      <section class="group">
        <h2>Ладонь на экране</h2>
        <div class="seg" role="group" aria-label="Режим отсечения ладони">
          <button type="button" data-palm="all">Все рисуют</button>
          <button type="button" data-palm="pen-only">Только перо</button>
          <button type="button" data-palm="auto">Авто</button>
        </div>
        <p class="note" id="palm-note"></p>
      </section>
      <section class="group">
        <h2>Когда рисовать</h2>
        <div class="seg" role="group" aria-label="Режим отрисовки">
          <button type="button" data-render="raf">По кадрам</button>
          <button type="button" data-render="immediate">Сразу в событии</button>
        </div>
        <p class="note">«Сразу» вместе с низколатентной канвой иногда выигрывает несколько миллисекунд.</p>
      </section>
      <section class="group">
        <h2>Задержка</h2>
        <label class="check"><input type="checkbox" id="opt-predicted" /><span>Предсказание точек</span><small>Рисовать чуть впереди пера по прогнозу браузера.</small></label>
        <label class="check"><input type="checkbox" id="opt-desync" /><span>Низколатентная канва</span><small>Режим desynchronized: кадр выводится в обход композитора.</small></label>
        <label class="check" id="raw-label"><input type="checkbox" id="opt-raw" /><span>Сырые события</span><small id="raw-note">pointerrawupdate: события без ожидания кадра.</small></label>
        <label class="check"><input type="checkbox" id="opt-highlight" /><span>Показать предсказание</span><small>Предсказанный хвост рисуется оранжевой линией.</small></label>
        <label class="check"><input type="checkbox" id="opt-flash" /><span>Вспышка при касании</span><small>Холст становится оранжевым, пока перо касается. Снимите в slow-motion и посчитайте кадры между касанием и вспышкой.</small></label>
      </section>
      <section class="group">
        <h2>Линия</h2>
        <label class="range"><span>Толщина</span><output id="out-size"></output><input type="range" id="opt-size" min="1" max="24" step="0.5" /></label>
        <label class="range"><span>Чувствительность к давлению</span><output id="out-thinning"></output><input type="range" id="opt-thinning" min="0" max="0.95" step="0.05" /></label>
        <label class="range"><span>Сглаживание дрожи</span><output id="out-streamline"></output><input type="range" id="opt-streamline" min="0" max="0.9" step="0.05" /></label>
        <button type="button" id="btn-defaults">Вернуть настройки по умолчанию</button>
      </section>
      <section class="group">
        <h2>Среда</h2>
        <dl class="env" id="env"></dl>
      </section>
    </aside>
  </main>
  <div class="dialog" id="dialog" hidden>
    <div class="dialog-box" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <h2 id="dialog-title">Отчёт о замере</h2>
      <p>Порисуйте 20–30 секунд, затем скопируйте отчёт и пришлите его в чат — по нему решим, нужен ли нативный слой пера.</p>
      <textarea id="report" readonly></textarea>
      <div class="dialog-actions">
        <span class="status" id="copy-status"></span>
        <button type="button" id="btn-close">Закрыть</button>
        <button type="button" id="btn-copy" class="primary">Скопировать</button>
      </div>
    </div>
  </div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const panel = $<HTMLElement>('panel');
const hint = $<HTMLElement>('hint');

// ---------- Ошибки: не даём одной ошибке остановить стенд ----------

function recordError(where: string, err: unknown): void {
  const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  if (errors.length < 20) errors.push(msg);
  console.error('[pen-lab]', msg, err);
  const badge = $('err-badge');
  badge.textContent = `Ошибок: ${errors.length} — пришлите отчёт`;
  badge.hidden = false;
}
window.addEventListener('error', (e) => recordError('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => recordError('promise', e.reason));

// ---------- Цвета из темы ----------

const colors = {
  paper: '#eef1f5',
  ink: '#16213a',
  dot: '#c9d0dc',
  accent: '#d9501b',
  flash: '#d9501b',
};
function readColors(): void {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  colors.paper = v('--paper', colors.paper);
  colors.ink = v('--ink', colors.ink);
  colors.dot = v('--dot', colors.dot);
  colors.accent = v('--accent', colors.accent);
  colors.flash = v('--flash', colors.flash);
  gridPattern = null;
}

// ---------- Канвы ----------

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
const committed = document.createElement('canvas');
const cctx = committed.getContext('2d')!;
/** Слой активного штриха: стабильная часть дорисовывается сюда по кускам. */
const activeLayer = document.createElement('canvas');
const actx = activeLayer.getContext('2d')!;
let dpr = 1;
let gridPattern: CanvasPattern | null = null;

function createCanvas(): void {
  const c = document.createElement('canvas');
  const context = c.getContext('2d', {
    desynchronized: settings.desync,
    alpha: false,
  }) as CanvasRenderingContext2D | null;
  if (!context) throw new Error('Canvas 2D недоступен');
  canvas?.remove();
  stage.prepend(c);
  canvas = c;
  ctx = context;
  env.desyncApplied = Boolean(
    (
      ctx as CanvasRenderingContext2D & {
        getContextAttributes?: () => { desynchronized?: boolean };
      }
    ).getContextAttributes?.().desynchronized,
  );
  gridPattern = null;
  resize();
  renderEnv();
}

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  committed.width = w;
  committed.height = h;
  activeLayer.width = w;
  activeLayer.height = h;
  if (active) active.drawnUpTo = 0; // слой очищен — дорисуем активный штрих заново
  gridPattern = null;
  rebuildCommitted();
  repaintAll();
}

function strokeStyleFromSettings(simulatePressure: boolean): StrokeStyle {
  return {
    color: colors.ink,
    size: settings.size,
    thinning: settings.thinning,
    streamline: settings.streamline,
    simulatePressure,
  };
}

function rebuildCommitted(): void {
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, committed.width, committed.height);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokes) drawStroke(cctx, s.points, { ...s.style, color: colors.ink });
}

function clearActiveLayer(): void {
  actx.setTransform(1, 0, 0, 1, 0, 0);
  actx.clearRect(0, 0, activeLayer.width, activeLayer.height);
}

function getGrid(): CanvasPattern | null {
  if (gridPattern) return gridPattern;
  const step = Math.round(24 * dpr);
  const tile = document.createElement('canvas');
  tile.width = step;
  tile.height = step;
  const t = tile.getContext('2d')!;
  t.fillStyle = colors.dot;
  t.beginPath();
  t.arc(step / 2, step / 2, Math.max(1, dpr), 0, Math.PI * 2);
  t.fill();
  gridPattern = ctx.createPattern(tile, 'repeat');
  return gridPattern;
}

// ---------- Области перерисовки ----------

/** Рамка сэмплов (CSS-пиксели) → прямоугольник в пикселях устройства с запасом на сглаживание. */
function samplesRect(samples: readonly Sample[], from = 0, minR = 0): Rect | null {
  if (samples.length <= from) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = Math.max(0, from); i < samples.length; i++) {
    const s = samples[i]!;
    const r = Math.max(s.r, minR);
    if (s.x - r < x0) x0 = s.x - r;
    if (s.y - r < y0) y0 = s.y - r;
    if (s.x + r > x1) x1 = s.x + r;
    if (s.y + r > y1) y1 = s.y + r;
  }
  if (!Number.isFinite(x0 + y0 + x1 + y1)) return null;
  const pad = 2;
  return {
    x0: Math.floor(x0 * dpr) - pad,
    y0: Math.floor(y0 * dpr) - pad,
    x1: Math.ceil(x1 * dpr) + pad,
    y1: Math.ceil(y1 * dpr) + pad,
  };
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function invalidate(r: Rect | null): void {
  pendingRegion = union(pendingRegion, r);
  dirty = true;
}

function repaintAll(): void {
  fullRepaint = true;
  paint();
}

// ---------- Отрисовка кадра ----------

function paint(): void {
  const t0 = performance.now();
  try {
    paintFrame();
  } catch (err) {
    recordError('paint', err);
    fullRepaint = true; // следующий кадр — с чистого листа
  } finally {
    dirty = false;
    stats.paintTook(performance.now() - t0);
  }
}

function paintFrame(): void {
  let tail: Sample[] = [];
  let highlight: InkPoint[] = [];
  if (active) {
    const b = active.builder;
    // 1. Новые стабильные сэмплы — на слой активного штриха (рисуются один раз).
    if (b.samples.length > active.drawnUpTo) {
      const from = active.drawnUpTo;
      if (from === 0) clearActiveLayer();
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fillSamples(actx, b.samples, colors.ink, from);
      invalidate(samplesRect(b.samples, Math.max(0, from - 1)));
      active.drawnUpTo = b.samples.length;
    }
    // 2. Хвост (последний кусок + предсказание) рисуется заново каждый кадр.
    const lastStable = b.samples[b.samples.length - 1];
    const fresh = b.tail(active.predicted);
    tail = lastStable ? [lastStable, ...fresh] : fresh;
    if (settings.highlightPredicted && active.predicted.length > 0) {
      highlight = [active.points[active.points.length - 1]!, ...active.predicted];
    }
    const tailRect = union(
      samplesRect(tail),
      samplesRect(
        highlight.map((p) => ({ x: p.x, y: p.y, r: 2 })),
        0,
        2,
      ),
    );
    invalidate(prevTail);
    invalidate(tailRect);
    prevTail = tailRect;
  } else if (prevTail) {
    invalidate(prevTail);
    prevTail = null;
  }

  const region = fullRepaint ? null : pendingRegion;
  if (!fullRepaint && !region) return;

  // Обрезаем область по канве.
  let x = 0;
  let y = 0;
  let w = canvas.width;
  let h = canvas.height;
  if (region) {
    x = Math.max(0, region.x0);
    y = Math.max(0, region.y0);
    w = Math.min(canvas.width, region.x1) - x;
    h = Math.min(canvas.height, region.y1) - y;
  }
  fullRepaint = false;
  pendingRegion = null;
  if (w <= 0 || h <= 0) return;

  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (region) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }
    const flashing = settings.flash && pressing;
    ctx.fillStyle = flashing ? colors.flash : colors.paper;
    ctx.fillRect(x, y, w, h);
    if (!flashing) {
      const grid = getGrid();
      if (grid) {
        ctx.fillStyle = grid;
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.drawImage(committed, x, y, w, h, x, y, w, h);
    if (active) {
      ctx.drawImage(activeLayer, x, y, w, h, x, y, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fillSamples(ctx, tail, colors.ink);
      if (highlight.length > 1) drawPolyline(ctx, highlight, colors.accent, 2);
      if (active.pendingEventTime !== null) {
        stats.painted(active.pendingEventTime, performance.now());
        active.pendingEventTime = null;
      }
    }
  } finally {
    ctx.restore();
  }
}

function schedule(): void {
  if (settings.render === 'immediate') paint();
  else dirty = true;
}

// ---------- Пример штриха, чтобы стенд не открывался пустым ----------

function addExampleStroke(): void {
  const rect = stage.getBoundingClientRect();
  const w = Math.min(rect.width - 64, 520);
  const x0 = Math.max(32, (rect.width - w) / 2);
  const y0 = rect.height * 0.42;
  const pts: InkPoint[] = [];
  for (let i = 0; i <= 120; i++) {
    const k = i / 120;
    pts.push({
      x: x0 + k * w,
      y: y0 + Math.sin(k * Math.PI * 3) * 36 * (1 - k * 0.4),
      p: 0.25 + 0.6 * Math.sin(k * Math.PI),
      tx: 0,
      ty: 0,
      t: i * 4,
    });
  }
  strokes.push({
    points: pts,
    style: { ...strokeStyleFromSettings(false), size: 6 },
    example: true,
  });
}

function updateHint(): void {
  hint.hidden = !strokes.some((s) => s.example);
}

function removeExample(): void {
  const before = strokes.length;
  for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i]!.example) strokes.splice(i, 1);
  if (strokes.length !== before) {
    rebuildCommitted();
    updateHint();
    fullRepaint = true;
  }
}

// ---------- Ввод ----------

function endStroke(): void {
  if (active) {
    const finished = active.builder.finish();
    strokes.push({ points: active.points, style: active.style });
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fillSamples(cctx, finished, colors.ink);
    invalidate(samplesRect(finished, Math.max(0, active.drawnUpTo - 1)));
  }
  active = null;
  clearActiveLayer();
  if (pressing && settings.flash) fullRepaint = true;
  pressing = false;
  schedule();
}

const input = new PenInput(
  stage,
  { palm: settings.palm, usePredicted: settings.predicted, useRawUpdate: settings.rawUpdate },
  {
    onStart(info) {
      removeExample();
      pressing = true;
      if (settings.flash) fullRepaint = true;
      stats.pointerType = info.pointerType;
      const style = strokeStyleFromSettings(!info.hasPressure);
      const builder = new StrokeBuilder(style);
      builder.add(info.point);
      clearActiveLayer();
      active = {
        points: [info.point],
        predicted: [],
        style,
        builder,
        drawnUpTo: 0,
        pendingEventTime: info.event.timeStamp,
      };
      schedule();
    },
    onMove(points, predicted, event) {
      if (!active) return;
      for (const p of points) {
        active.points.push(p);
        active.builder.add(p);
      }
      active.predicted = predicted;
      active.pendingEventTime = event.timeStamp;
      stats.predictedLast = predicted.length;
      schedule();
    },
    onEnd: endStroke,
    onSample(event, coalesced) {
      stats.sample(event, coalesced);
    },
    onRejected() {
      stats.rejected++;
    },
    onRecover(reason) {
      recoveries[reason]++;
    },
  },
);

// Диагностика: считаем pointermove и pointerrawupdate одновременно, чтобы за одну сессию
// понять, какой из них в этой среде приходит чаще. На рисование это не влияет.
const diag = {
  move: new RateMeter(1000),
  moveSamples: new RateMeter(1000),
  raw: new RateMeter(1000),
  rawSamples: new RateMeter(1000),
  peak: { move: 0, moveSamples: 0, raw: 0, rawSamples: 0 },
};
function diagListener(events: RateMeter, samples: RateMeter): (e: PointerEvent) => void {
  return (e) => {
    if (e.buttons === 0) return;
    events.mark(e.timeStamp);
    const n = Math.max(1, e.getCoalescedEvents?.().length ?? 1);
    for (let i = 0; i < n; i++) samples.mark(e.timeStamp);
  };
}
stage.addEventListener('pointermove', diagListener(diag.move, diag.moveSamples));
if (env.rawUpdate) {
  stage.addEventListener(
    'pointerrawupdate' as 'pointermove',
    diagListener(diag.raw, diag.rawSamples),
  );
}
function updateDiagPeaks(now: number): void {
  diag.peak.move = Math.max(diag.peak.move, diag.move.rate(now));
  diag.peak.moveSamples = Math.max(diag.peak.moveSamples, diag.moveSamples.rate(now));
  diag.peak.raw = Math.max(diag.peak.raw, diag.raw.rate(now));
  diag.peak.rawSamples = Math.max(diag.peak.rawSamples, diag.rawSamples.rate(now));
}

// ---------- Цикл кадров и показания ----------

const r = {
  type: $('r-type'),
  pressure: $('r-pressure'),
  pressureBar: $('r-pressure-bar'),
  maxp: $('r-maxp'),
  tilt: $('r-tilt'),
  hz: $('r-hz'),
  coal: $('r-coal'),
  lat: $('r-lat'),
  p95: $('r-p95'),
  paint: $('r-paint'),
  fps: $('r-fps'),
};

const typeNames: Record<string, string> = { pen: 'перо', touch: 'палец', mouse: 'мышь', '—': '—' };
const fmt = (v: number, digits = 0): string => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const withUnit = (v: number, digits: number, unit: string): string =>
  Number.isFinite(v) ? `${fmt(v, digits)}<small>${unit}</small>` : '—';

function updateHud(): void {
  const now = performance.now();
  const s = stats.snapshot(now);
  updateDiagPeaks(now);
  r.type.textContent = typeNames[s.pointerType] ?? s.pointerType;
  const showP = s.pointerType === 'pen';
  r.pressure.textContent = showP ? fmt(s.pressure, 2) : '—';
  r.pressureBar.style.width = showP ? `${Math.round(s.pressure * 100)}%` : '0';
  r.maxp.textContent = s.maxPressure > 0 ? fmt(s.maxPressure, 2) : '—';
  r.tilt.textContent = showP ? `${fmt(s.tiltX)}° / ${fmt(s.tiltY)}°` : '—';
  r.hz.innerHTML = s.peakEventHz > 0 ? withUnit(s.peakEventHz, 0, 'Гц пик') : '—';
  r.coal.textContent = fmt(s.coalescedPerEvent, 1);
  r.lat.innerHTML = withUnit(s.latencyMean, 1, 'мс');
  r.p95.innerHTML = withUnit(s.latencyP95, 1, 'мс');
  r.paint.innerHTML = withUnit(s.paintMean, 1, 'мс');
  r.fps.innerHTML = withUnit(s.fps, 0, 'к/с');
}

let lastHud = 0;
function frame(t: number): void {
  try {
    stats.frame(t);
    if (dirty) paint();
    if (t - lastHud > 120) {
      lastHud = t;
      updateHud();
    }
  } catch (err) {
    recordError('frame', err);
  } finally {
    // Цикл кадров не должен останавливаться ни при какой ошибке.
    requestAnimationFrame(frame);
  }
}

// ---------- Настройки ----------

function syncControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-palm]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.palm === settings.palm));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-render]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.render === settings.render));
  });
  const palmNotes: Record<Settings['palm'], string> = {
    all: 'Рисуют и перо, и пальцы.',
    'pen-only': 'Пальцы и ладонь никогда не рисуют.',
    auto: 'После первого касания пером пальцы перестают рисовать.',
  };
  $('palm-note').textContent = palmNotes[settings.palm];
  $<HTMLInputElement>('opt-predicted').checked = settings.predicted;
  $<HTMLInputElement>('opt-desync').checked = settings.desync;
  const raw = $<HTMLInputElement>('opt-raw');
  raw.checked = settings.rawUpdate && env.rawUpdate;
  raw.disabled = !env.rawUpdate;
  $('raw-label').classList.toggle('disabled', !env.rawUpdate);
  if (!env.rawUpdate) {
    $('raw-note').textContent = window.isSecureContext
      ? 'Этот браузер не поддерживает pointerrawupdate.'
      : 'Недоступно: страница открыта не по HTTPS (например, по IP в локальной сети).';
  }
  $<HTMLInputElement>('opt-highlight').checked = settings.highlightPredicted;
  $<HTMLInputElement>('opt-flash').checked = settings.flash;
  $<HTMLInputElement>('opt-size').value = String(settings.size);
  $<HTMLInputElement>('opt-thinning').value = String(settings.thinning);
  $<HTMLInputElement>('opt-streamline').value = String(settings.streamline);
  $('out-size').textContent = `${settings.size} px`;
  $('out-thinning').textContent = settings.thinning.toFixed(2);
  $('out-streamline').textContent = settings.streamline.toFixed(2);
}

function renderEnv(): void {
  const yes = (b: boolean): string => (b ? 'да' : 'нет');
  const rows: [string, string][] = [
    ['Оболочка', env.tauri ? 'Tauri' : 'браузер'],
    ['HTTPS-контекст', yes(window.isSecureContext)],
    ['Плотность пикселей', String(window.devicePixelRatio)],
    [
      'Низколатентная канва',
      settings.desync ? (env.desyncApplied ? 'включена' : 'не поддерживается') : 'выключена',
    ],
    ['Склеенные события', yes(env.coalesced)],
    ['Предсказание', yes(env.predicted)],
    ['Сырые события', yes(env.rawUpdate)],
  ];
  $('env').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function update(next: Partial<Settings>): void {
  const prevDesync = settings.desync;
  Object.assign(settings, next);
  saveSettings(settings);
  input.setOptions({
    palm: settings.palm,
    usePredicted: settings.predicted,
    useRawUpdate: settings.rawUpdate,
  });
  if (settings.desync !== prevDesync) createCanvas();
  syncControls();
  renderEnv();
  fullRepaint = true;
  schedule();
}

document
  .querySelectorAll<HTMLButtonElement>('[data-palm]')
  .forEach((b) =>
    b.addEventListener('click', () => update({ palm: b.dataset.palm as Settings['palm'] })),
  );
document
  .querySelectorAll<HTMLButtonElement>('[data-render]')
  .forEach((b) =>
    b.addEventListener('click', () => update({ render: b.dataset.render as Settings['render'] })),
  );
const bindCheck = (id: string, key: keyof Settings): void => {
  $<HTMLInputElement>(id).addEventListener('change', (e) =>
    update({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>),
  );
};
bindCheck('opt-predicted', 'predicted');
bindCheck('opt-desync', 'desync');
bindCheck('opt-raw', 'rawUpdate');
bindCheck('opt-highlight', 'highlightPredicted');
bindCheck('opt-flash', 'flash');
const bindRange = (id: string, key: 'size' | 'thinning' | 'streamline'): void => {
  $<HTMLInputElement>(id).addEventListener('input', (e) =>
    update({ [key]: Number((e.target as HTMLInputElement).value) }),
  );
};
bindRange('opt-size', 'size');
bindRange('opt-thinning', 'thinning');
bindRange('opt-streamline', 'streamline');
$('btn-defaults').addEventListener('click', () => update({ ...defaultSettings }));

// ---------- Кнопки ----------

function undo(): void {
  if (strokes.length === 0) return;
  strokes.pop();
  rebuildCommitted();
  updateHint();
  repaintAll();
}

$('btn-undo').addEventListener('click', undo);
$('btn-clear').addEventListener('click', () => {
  strokes.length = 0;
  rebuildCommitted();
  updateHint();
  repaintAll();
});
$('btn-reset').addEventListener('click', () => {
  stats.reset();
  diag.peak = { move: 0, moveSamples: 0, raw: 0, rawSamples: 0 };
  for (const k of Object.keys(recoveries) as RecoveryReason[]) recoveries[k] = 0;
});
$('btn-settings').addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  $('btn-settings').setAttribute('aria-pressed', String(!panel.hidden));
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
  if (e.key === 'Escape') $('dialog').hidden = true;
});

// ---------- Отчёт ----------

function buildReport(): string {
  const now = performance.now();
  const s = stats.snapshot(now);
  updateDiagPeaks(now);
  const round = (v: number, d = 1): number | null =>
    Number.isFinite(v) ? Number(v.toFixed(d)) : null;
  const userStrokes = strokes.filter((x) => !x.example);
  return JSON.stringify(
    {
      app: `Kayospace Pen Lab ${VERSION}`,
      time: new Date().toISOString(),
      env: {
        shell: env.tauri ? 'tauri' : 'browser',
        userAgent: navigator.userAgent,
        secureContext: window.isSecureContext,
        dpr: window.devicePixelRatio,
        screen: `${screen.width}x${screen.height}`,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        canvas: `${canvas.width}x${canvas.height}`,
        desyncApplied: env.desyncApplied,
        coalescedSupported: env.coalesced,
        predictedSupported: env.predicted,
        rawUpdateSupported: env.rawUpdate,
      },
      settings,
      measured: {
        pointerType: s.pointerType,
        maxPressure: round(s.maxPressure, 3),
        peakEventHz: round(s.peakEventHz, 0),
        coalescedPerEvent: round(s.coalescedPerEvent, 2),
        inputToPaintMeanMs: round(s.latencyMean),
        inputToPaintP95Ms: round(s.latencyP95),
        paintMeanMs: round(s.paintMean, 2),
        paintP95Ms: round(s.paintP95, 2),
        fps: round(s.fps, 0),
        longFrames: s.longFrames,
        rejectedTouches: s.rejected,
        strokes: userStrokes.length,
        points: userStrokes.reduce((n, x) => n + x.points.length, 0),
      },
      eventSources: {
        pointermovePeakHz: round(diag.peak.move, 0),
        pointermoveSamplesPeakHz: round(diag.peak.moveSamples, 0),
        rawupdatePeakHz: env.rawUpdate ? round(diag.peak.raw, 0) : null,
        rawupdateSamplesPeakHz: env.rawUpdate ? round(diag.peak.rawSamples, 0) : null,
      },
      recoveries,
      errors,
    },
    null,
    2,
  );
}

$('btn-report').addEventListener('click', () => {
  $<HTMLTextAreaElement>('report').value = buildReport();
  $('copy-status').textContent = '';
  $('dialog').hidden = false;
});
$('btn-close').addEventListener('click', () => ($('dialog').hidden = true));
$('dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('dialog').hidden = true;
});
$('btn-copy').addEventListener('click', () => {
  const ta = $<HTMLTextAreaElement>('report');
  const status = $('copy-status');
  const fallback = (): void => {
    ta.focus();
    ta.select();
    status.textContent = 'Текст выделен — скопируйте его вручную.';
  };
  try {
    navigator.clipboard
      .writeText(ta.value)
      .then(() => (status.textContent = 'Скопировано.'), fallback);
  } catch {
    fallback();
  }
});

// ---------- Старт ----------

readColors();
createCanvas();
addExampleStroke();
rebuildCommitted();
updateHint();
syncControls();
repaintAll();

new ResizeObserver(() => resize()).observe(stage);
const onTheme = (): void => {
  readColors();
  rebuildCommitted();
  repaintAll();
};
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
new MutationObserver(onTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});
if (window.innerWidth >= 1100) {
  panel.hidden = false;
  $('btn-settings').setAttribute('aria-pressed', 'true');
}
requestAnimationFrame(frame);
