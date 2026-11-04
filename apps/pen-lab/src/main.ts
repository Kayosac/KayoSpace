import './style.css';
import {
  InkStats,
  PenInput,
  RateMeter,
  RollingSamples,
  StrokeBuilder,
  boundsIntersect,
  drawPolyline,
  fillSamples,
  samplesBounds,
  samplesPath,
  samplesPathInRect,
  strokeSamples,
  supportsRawUpdate,
  type Bounds,
  type InkPoint,
  type RecoveryReason,
  type Sample,
  type StrokeStyle,
} from '@kayospace/ink';
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings';
import { BoardLink, hubSyncUrl, type RemoteStroke } from './link';
import type { SyncStatus } from '@kayospace/sync';

const VERSION = '0.4.0';

interface Stroke {
  /** id элемента на доске хаба (если штрих синхронизирован). */
  id?: string;
  points: InkPoint[];
  style: StrokeStyle;
  example?: boolean;
  /** Готовый контур (CSS-пиксели) — строится один раз, перерисовка участка просто заливает его с обрезкой. */
  path: Path2D;
  bounds: Bounds;
}

interface ActiveStroke {
  points: InkPoint[];
  predicted: InkPoint[];
  style: StrokeStyle;
  builder: StrokeBuilder;
  /** Сколько стабильных сэмплов уже попало в перерисованный участок. */
  paintedUpTo: number;
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
/** Площадь частичной перерисовки, доля канвы. */
const regionShare = new RollingSamples(240);

// Журнал событий пера: последние события и переходы состояния — чтобы по отчёту понять, что случилось.
const LOG_SIZE = 300;
const eventLog: string[] = [];
const logStart = performance.now();
function logEvent(text: string): void {
  eventLog.push(`${(performance.now() - logStart).toFixed(0)} ${text}`);
  if (eventLog.length > LOG_SIZE) eventLog.shift();
}
let lastEventLabel = '—';

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
    <div class="brand"><b>Kayospace</b><span>Pen Lab</span><em class="badge" id="err-badge" hidden></em><em class="badge quiet" id="sync-badge" hidden></em></div>
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
    <div class="readout"><dt>Состояние</dt><dd id="r-state">—</dd></div>
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
        <h2>Синхронизация</h2>
        <label class="field"><span>Хаб</span><input id="opt-hub" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="192.168.1.10:4000" /></label>
        <label class="field"><span>Доска</span><input id="opt-board" type="text" autocomplete="off" spellcheck="false" placeholder="pen-lab" /></label>
        <button type="button" id="btn-sync">Подключить</button>
        <p class="note" id="sync-note">Запустите хаб на компьютере (pnpm hub) и введите его адрес из вывода команды.</p>
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
}

// ---------- Канва ----------
//
// Одна видимая канва и никаких промежуточных слоёв: копирование между канвами на Android
// оказалось очень дорогим (низколатентная канва рисуется программно, а слои — на видеокарте).
// Изменившийся участок перерисовывается из векторных данных: фон, точки сетки, штрихи, хвост.

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let dpr = 1;
const GRID_STEP = 24;

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

function buildStroke(
  points: InkPoint[],
  style: StrokeStyle,
  samples: Sample[] = strokeSamples(points, style),
  example = false,
): Stroke | null {
  const bounds = samplesBounds(samples);
  if (!bounds) return null;
  return { points, style, example, path: samplesPath(samples), bounds };
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
  let area = 0;
  try {
    area = paintFrame();
  } catch (err) {
    recordError('paint', err);
    fullRepaint = true; // следующий кадр — с чистого листа
  } finally {
    dirty = false;
    const took = performance.now() - t0;
    stats.paintTook(took);
    if (took > 16)
      logEvent(`медленный кадр ${took.toFixed(1)} мс, площадь ${(area * 100).toFixed(1)}%`);
  }
}

/** Рисует кадр, возвращает долю перерисованной площади. */
function paintFrame(): number {
  let tail: Sample[] = [];
  let highlight: InkPoint[] = [];
  if (active) {
    const b = active.builder;
    // Новые стабильные сэмплы: между кадрами их может прийти много (склеенные события),
    // и они не обязаны попадать в прошлый хвост — добавляем их участок явно.
    if (b.samples.length > active.paintedUpTo) {
      invalidate(samplesRect(b.samples, Math.max(0, active.paintedUpTo - 1)));
      active.paintedUpTo = b.samples.length;
    }
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
  if (!fullRepaint && !region) return 0;

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
  if (w <= 0 || h <= 0) return 0;
  const share = (w * h) / (canvas.width * canvas.height);
  if (region) regionShare.push(share);

  // Участок в CSS-пикселях — для выбора штрихов, которые его задевают.
  const view: Bounds = { minX: x / dpr, minY: y / dpr, maxX: (x + w) / dpr, maxY: (y + h) / dpr };

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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!flashing) drawGrid(view);

    ctx.fillStyle = colors.ink;
    for (const s of strokes) {
      if (boundsIntersect(s.bounds, view)) ctx.fill(s.path, 'nonzero');
    }
    if (active) {
      const stable = region
        ? samplesPathInRect(active.builder.samples, view)
        : samplesPath(active.builder.samples);
      if (stable) ctx.fill(stable, 'nonzero');
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
  return share;
}

/** Точки сетки в видимом участке (CSS-пиксели). */
function drawGrid(view: Bounds): void {
  const half = GRID_STEP / 2;
  const r = Math.max(1, dpr) / dpr;
  const ix0 = Math.floor((view.minX - half) / GRID_STEP);
  const ix1 = Math.ceil((view.maxX - half) / GRID_STEP);
  const iy0 = Math.floor((view.minY - half) / GRID_STEP);
  const iy1 = Math.ceil((view.maxY - half) / GRID_STEP);
  const dots = new Path2D();
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = ix * GRID_STEP + half;
      const cy = iy * GRID_STEP + half;
      dots.moveTo(cx + r, cy);
      dots.arc(cx, cy, r, 0, Math.PI * 2);
    }
  }
  ctx.fillStyle = colors.dot;
  ctx.fill(dots);
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
  const style = { ...strokeStyleFromSettings(false), size: 6 };
  const stroke = buildStroke(pts, style, undefined, true);
  if (stroke) strokes.push(stroke);
}

function updateHint(): void {
  hint.hidden = !strokes.some((s) => s.example);
}

function removeExample(): void {
  const before = strokes.length;
  for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i]!.example) strokes.splice(i, 1);
  if (strokes.length !== before) {
    updateHint();
    fullRepaint = true;
  }
}

// ---------- Ввод ----------

function endStroke(): void {
  if (active) {
    const finished = active.builder.finish();
    const stroke = buildStroke(active.points, active.style, finished);
    if (stroke) {
      if (link)
        stroke.id = link.publish(active.points, active.style.size, !active.style.simulatePressure);
      strokes.push(stroke);
    }
    // Хвост законченного штриха доходит до настоящей точки пера — перерисуем этот участок.
    invalidate(samplesRect(finished, Math.max(0, active.builder.samples.length - 1)));
    logEvent(`штрих закончен: ${active.points.length} точек`);
  }
  active = null;
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
      active = {
        points: [info.point],
        predicted: [],
        style,
        builder,
        paintedUpTo: 0,
        pendingEventTime: info.event.timeStamp,
      };
      logEvent(`штрих начат: #${info.event.pointerId} ${info.pointerType}`);
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
    onRejected(e) {
      stats.rejected++;
      logEvent(`касание отброшено: #${e.pointerId} ${e.pointerType}`);
    },
    onRecover(reason) {
      recoveries[reason]++;
      logEvent(`восстановление: ${reason}`);
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
// Журнал: down/up/cancel/захват — всегда; движения — только при смене «касание ↔ наведение».
const shortType: Record<string, string> = {
  pointerdown: 'down',
  pointerup: 'up',
  pointercancel: 'cancel',
  gotpointercapture: 'got-capture',
  lostpointercapture: 'lost-capture',
  pointermove: 'move',
};
const moveKind = new Map<number, { kind: string; count: number }>();
function logPointer(e: PointerEvent): void {
  const who = `#${e.pointerId}${e.pointerType === 'pen' ? 'P' : e.pointerType === 'touch' ? 'T' : 'M'}`;
  const state = `b${e.buttons} p${e.pressure.toFixed(2)}`;
  if (e.type === 'pointermove') {
    const kind = e.buttons !== 0 || e.pressure > 0 ? 'касание' : 'наведение';
    const prev = moveKind.get(e.pointerId);
    if (prev && prev.kind === kind) {
      prev.count++;
      return;
    }
    if (prev) logEvent(`  …${prev.count} move (${prev.kind})`);
    moveKind.set(e.pointerId, { kind, count: 1 });
    logEvent(`move ${who} ${state} → ${kind}`);
    return;
  }
  const prev = moveKind.get(e.pointerId);
  if (prev) {
    logEvent(`  …${prev.count} move (${prev.kind})`);
    moveKind.delete(e.pointerId);
  }
  lastEventLabel = shortType[e.type] ?? e.type;
  logEvent(
    `${lastEventLabel} ${who} ${state}${e.target instanceof Node && stage.contains(e.target) ? '' : ' (вне холста)'}`,
  );
}
for (const type of Object.keys(shortType)) {
  window.addEventListener(type, logPointer as EventListener, true);
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
  state: $('r-state'),
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
  r.state.innerHTML = `${active ? 'рисует' : 'ждёт'}<small>${lastEventLabel}</small>`;
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
    if (settings.syncOn && settings.hubUrl) startSync();
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

// ---------- Синхронизация с хабом ----------

let link: BoardLink | null = null;
const syncLabels: Record<SyncStatus, string> = {
  connecting: 'подключаюсь…',
  connected: 'соединено, сверяю доску…',
  synced: 'синхронизировано',
  offline: 'нет связи, переподключаюсь…',
  stopped: 'отключено',
};

function cssBoundsToRect(b: { minX: number; minY: number; maxX: number; maxY: number }): Rect {
  return {
    x0: Math.floor(b.minX * dpr) - 2,
    y0: Math.floor(b.minY * dpr) - 2,
    x1: Math.ceil(b.maxX * dpr) + 2,
    y1: Math.ceil(b.maxY * dpr) + 2,
  };
}

function onRemoteStroke(r: RemoteStroke): void {
  if (strokes.some((st) => st.id === r.id)) return;
  removeExample();
  const style = { ...strokeStyleFromSettings(!r.hasPressure), size: r.size };
  const stroke = buildStroke(r.points, style);
  if (!stroke) return;
  stroke.id = r.id;
  strokes.push(stroke);
  invalidate(cssBoundsToRect(stroke.bounds));
  schedule();
}

function onRemoteDelete(id: string): void {
  const i = strokes.findIndex((st) => st.id === id);
  if (i < 0) return;
  const [gone] = strokes.splice(i, 1);
  invalidate(cssBoundsToRect(gone!.bounds));
  updateHint();
  schedule();
}

function renderSync(status: SyncStatus | 'off'): void {
  const badge = $('sync-badge');
  const note = $('sync-note');
  $('btn-sync').textContent = link ? 'Отключить' : 'Подключить';
  if (status === 'off') {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = `Хаб: ${syncLabels[status]}`;
  badge.classList.toggle('quiet', status === 'synced');
  note.textContent =
    status === 'synced'
      ? `Доска «${settings.board}»: ${strokes.filter((x) => x.id).length} штрихов с хабом.`
      : `${link?.url ?? ''} — ${syncLabels[status]}`;
}

function startSync(): void {
  stopSync();
  const url = hubSyncUrl(settings.hubUrl, settings.board);
  if (!url) {
    $('sync-note').textContent =
      'Проверьте адрес хаба (например 192.168.1.10:4000) и имя доски (латиница, цифры, «-», «_»).';
    return;
  }
  if (location.protocol === 'https:' && url.startsWith('ws:')) {
    $('sync-note').textContent =
      'Страница открыта по HTTPS, а хаб в локальной сети — без шифрования: браузер такое соединение запретит. ' +
      'Откройте Pen Lab в приложении Kayospace или через pnpm dev.';
    return;
  }
  link = new BoardLink(
    url,
    { kind: 'human', name: 'kayos', device: env.tauri ? 'app' : 'browser' },
    { onStroke: onRemoteStroke, onDelete: onRemoteDelete, onStatus: renderSync },
  );
  // Штрихи, нарисованные до подключения, тоже отправляем на доску.
  for (const st of strokes) {
    if (!st.id && !st.example) {
      st.id = link.publish(st.points, st.style.size, !st.style.simulatePressure);
    }
  }
  logEvent(`синхронизация: ${url}`);
}

function stopSync(): void {
  if (!link) return;
  link.destroy();
  link = null;
  renderSync('off');
  logEvent('синхронизация выключена');
}

$<HTMLInputElement>('opt-hub').value = settings.hubUrl;
$<HTMLInputElement>('opt-board').value = settings.board;
$('btn-sync').addEventListener('click', () => {
  if (link) {
    stopSync();
    update({ syncOn: false });
    return;
  }
  update({
    hubUrl: $<HTMLInputElement>('opt-hub').value.trim(),
    board: $<HTMLInputElement>('opt-board').value.trim() || 'pen-lab',
    syncOn: true,
  });
  startSync();
});

// ---------- Кнопки ----------

function undo(): void {
  if (strokes.length === 0) return;
  const removed = strokes.pop()!;
  if (removed.id) link?.remove([removed.id]);
  updateHint();
  repaintAll();
}

$('btn-undo').addEventListener('click', undo);
$('btn-clear').addEventListener('click', () => {
  link?.remove(strokes.flatMap((st) => (st.id ? [st.id] : [])));
  strokes.length = 0;
  updateHint();
  repaintAll();
});
$('btn-reset').addEventListener('click', () => {
  stats.reset();
  diag.peak = { move: 0, moveSamples: 0, raw: 0, rawSamples: 0 };
  for (const k of Object.keys(recoveries) as RecoveryReason[]) recoveries[k] = 0;
  regionShare.clear();
  eventLog.length = 0;
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
        repaintAreaMeanPct: round(regionShare.mean() * 100, 2),
        fps: round(s.fps, 0),
        longFrames: s.longFrames,
        rejectedTouches: s.rejected,
        strokes: userStrokes.length,
        points: userStrokes.reduce((n, x) => n + x.points.length, 0),
      },
      sync: {
        hub: link?.url ?? null,
        status: link?.client.status ?? 'off',
        syncedStrokes: strokes.filter((x) => x.id).length,
      },
      eventSources: {
        pointermovePeakHz: round(diag.peak.move, 0),
        pointermoveSamplesPeakHz: round(diag.peak.moveSamples, 0),
        rawupdatePeakHz: env.rawUpdate ? round(diag.peak.raw, 0) : null,
        rawupdateSamplesPeakHz: env.rawUpdate ? round(diag.peak.rawSamples, 0) : null,
      },
      recoveries,
      errors,
      eventLog: eventLog.slice(-150),
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
updateHint();
syncControls();
repaintAll();

new ResizeObserver(() => resize()).observe(stage);
const onTheme = (): void => {
  readColors();
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
