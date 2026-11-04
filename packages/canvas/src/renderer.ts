/**
 * Отрисовка холста на одну видимую канву — тот же подход, что проверен в Pen Lab (решение 0003):
 * никаких промежуточных слоёв и копирования между канвами; изменившийся участок
 * перерисовывается из векторных данных: бумага, сетка, элементы сцены, активный штрих.
 *
 * Прямоугольники перерисовки — в пикселях устройства. Мировые рамки переводятся через камеру.
 */

import {
  boundsIntersect,
  fillSamples,
  samplesPath,
  samplesPathInRect,
  type Bounds,
  type Sample,
} from '@kayospace/ink';
import { STICKY_FONT_SIZE, fontSizeOf, type Transform } from '@kayospace/board';
import type { ArrowElement, CanvasElement, ShapeElement } from '@kayospace/model';
import { DEFAULT_LINE, arrowEnds, arrowHead } from './shapes';
import type { Camera } from './camera';
import { transformBounds } from './selection';
import type { Scene, SceneItem } from './scene';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ThemeColors {
  paper: string;
  ink: string;
  dot: string;
  accent: string;
}

/** Штрих, который сейчас рисуется: стабильная часть и хвост (мировые координаты). */
export interface ActiveStroke {
  samples: readonly Sample[];
  tail: readonly Sample[];
  color: string | null;
}

export interface SelectionOverlay {
  /** Рамка выделения (мировые координаты, до преобразования жеста). */
  bounds: Bounds;
  ids: ReadonlySet<string>;
  /** Показывать ручки масштаба. */
  handles: boolean;
}

export interface PaintOverlay {
  active?: ActiveStroke | null;
  /** Кольцо ластика (мировые координаты). */
  ring?: { x: number; y: number; r: number } | null;
  /** Элементы, которые сейчас двигают или масштабируют: рисуются с преобразованием жеста. */
  preview?: { ids: ReadonlySet<string>; t: Transform } | null;
  selection?: SelectionOverlay | null;
  /** Контур лассо (мировые координаты). */
  lasso?: readonly { x: number; y: number }[] | null;
  /** Рамка выделения мышью (мировые координаты). */
  marquee?: Bounds | null;
  /** Фигура, которую сейчас тянут (ещё не в доске). */
  draft?: CanvasElement | null;
  /** Стикер или текст, который сейчас редактируют: текст рисует поле ввода, а не канва. */
  editing?: string | null;
}

/** Отступ рамки выделения от элементов и размер ручек, CSS-пиксели. */
export const SELECTION_PAD = 6;
export const HANDLE_SIZE = 10;

/** Шаг сетки в мировых единицах при зуме 1. */
export const GRID_STEP = 24;
/** Если точки сетки ближе этого (CSS-пиксели), шаг укрупняется. */
const GRID_MIN_GAP = 14;

const STICKY_COLOR = '#ffe58a';
/** Межстрочный интервал текста — так же в поле ввода (интерфейс). */
export const LINE_HEIGHT = 1.3;
/** Стикер всегда светлый — текст на нём тёмный в любой теме. */
export const STICKY_INK = '#1c1f26';
export const NOTE_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Перенос строк по ширине (по словам; длинное слово режется). */
export function wrapText(
  ctx: { measureText(s: string): { width: number } },
  text: string,
  width: number,
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= width || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Рамка сэмплов (мировые координаты). */
export function samplesWorldBounds(samples: readonly Sample[], from = 0): Bounds | null {
  if (samples.length <= from) return null;
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

/** Шаг сетки в мировых единицах для данного зума: точки не гуще GRID_MIN_GAP на экране. */
export function gridStepFor(zoom: number): number {
  let step = GRID_STEP;
  while (step * zoom < GRID_MIN_GAP) step *= 4;
  while (step * zoom >= GRID_MIN_GAP * 4 && step > GRID_STEP / 64) step /= 4;
  return step;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  dpr = 1;
  /** Размер в CSS-пикселях. */
  width = 1;
  height = 1;
  colors: ThemeColors = { paper: '#fbfaf7', ink: '#16213a', dot: '#d9d6cf', accent: '#3e63dd' };
  /** Удалось ли включить низколатентный режим (для диагностики). */
  readonly desynchronized: boolean;

  private pending: Rect | null = null;
  private editing: string | null = null;
  private full = true;

  constructor(host: HTMLElement) {
    const c = document.createElement('canvas');
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.display = 'block';
    const ctx = c.getContext('2d', { desynchronized: true, alpha: false });
    if (!ctx) throw new Error('Canvas 2D недоступен');
    host.prepend(c);
    this.canvas = c;
    this.ctx = ctx;
    this.desynchronized = Boolean(
      (
        ctx as CanvasRenderingContext2D & {
          getContextAttributes?: () => { desynchronized?: boolean };
        }
      ).getContextAttributes?.().desynchronized,
    );
  }

  /** Подогнать размер канвы под элемент. true — если размер изменился. */
  resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
    this.dpr = dpr || 1;
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);
    const w = Math.max(1, Math.round(this.width * this.dpr));
    const h = Math.max(1, Math.round(this.height * this.dpr));
    const changed = this.canvas.width !== w || this.canvas.height !== h;
    if (changed) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.full = true;
    return changed;
  }

  get needsPaint(): boolean {
    return this.full || this.pending !== null;
  }

  invalidateAll(): void {
    this.full = true;
  }

  invalidate(r: Rect | null): void {
    if (r) this.pending = unionRect(this.pending, r);
  }

  /** Мировая рамка → прямоугольник в пикселях устройства с запасом на сглаживание. */
  worldRect(cam: Camera, b: Bounds | null, pad = 2): Rect | null {
    if (!b) return null;
    const k = this.dpr * cam.zoom;
    return {
      x0: Math.floor((b.minX - cam.x) * k) - pad,
      y0: Math.floor((b.minY - cam.y) * k) - pad,
      x1: Math.ceil((b.maxX - cam.x) * k) + pad,
      y1: Math.ceil((b.maxY - cam.y) * k) + pad,
    };
  }

  invalidateWorld(cam: Camera, b: Bounds | null): void {
    this.invalidate(this.worldRect(cam, b));
  }

  /** Нарисовать накопившиеся изменения. Возвращает долю перерисованной площади. */
  paint(cam: Camera, scene: Scene, overlay: PaintOverlay = {}): number {
    const { active = null, ring = null, preview = null, selection = null } = overlay;
    this.editing = overlay.editing ?? null;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    let x = 0;
    let y = 0;
    let w = cw;
    let h = ch;
    const region = this.full ? null : this.pending;
    if (!this.full && !region) return 0;
    if (region) {
      x = Math.max(0, region.x0);
      y = Math.max(0, region.y0);
      w = Math.min(cw, region.x1) - x;
      h = Math.min(ch, region.y1) - y;
    }
    this.full = false;
    this.pending = null;
    if (w <= 0 || h <= 0) return 0;

    const k = this.dpr * cam.zoom;
    // Участок в мировых координатах — для выбора элементов, которые его задевают.
    const view: Bounds = {
      minX: x / k + cam.x,
      minY: y / k + cam.y,
      maxX: (x + w) / k + cam.x,
      maxY: (y + h) / k + cam.y,
    };
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (region) {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }
      ctx.fillStyle = this.colors.paper;
      ctx.fillRect(x, y, w, h);
      this.drawGrid(cam, x, y, w, h);

      ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
      let fill = '';
      const setFill = (color: string | null): void => {
        const c = color ?? this.colors.ink;
        if (c !== fill) ctx.fillStyle = fill = c;
      };
      for (const item of scene.query(view)) {
        if (preview?.ids.has(item.id)) continue;
        setFill(item.color);
        this.drawItem(item, cam.zoom);
        if (item.element.type !== 'stroke') fill = ''; // стикер и фигура сами меняют fillStyle
      }
      if (preview) {
        // Перетаскиваемые элементы — поверх остальных, с преобразованием жеста.
        const t = preview.t;
        ctx.transform(t.s, 0, 0, t.s, t.tx, t.ty);
        for (const id of preview.ids) {
          const item = scene.items.get(id);
          if (!item) continue;
          setFill(item.color);
          this.drawItem(item, cam.zoom * t.s);
          if (item.element.type !== 'stroke') fill = '';
        }
        ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
      }
      if (active) {
        setFill(active.color);
        const stable = region
          ? samplesPathInRect(active.samples, view)
          : active.samples.length > 0
            ? samplesPath(active.samples)
            : null;
        if (stable) ctx.fill(stable, 'nonzero');
        if (active.tail.length > 0 && boundsIntersect(samplesWorldBounds(active.tail)!, view)) {
          fillSamples(ctx, active.tail, fill);
        }
      }
      if (overlay.draft) {
        const d = overlay.draft;
        if (d.type === 'shape' || d.type === 'arrow') this.drawShape(d, d.style.color ?? null);
      }
      if (ring) {
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / cam.zoom;
        ctx.strokeStyle = this.colors.accent;
        ctx.stroke();
      }
      // Рамки выделения, лассо — в экранных координатах: толщина линий не зависит от зума.
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const toScreen = (wx: number, wy: number): [number, number] => [
        (wx - cam.x) * cam.zoom,
        (wy - cam.y) * cam.zoom,
      ];
      if (selection) this.drawSelection(selection, scene, toScreen, preview?.t ?? null);
      if (overlay.lasso && overlay.lasso.length > 1) {
        ctx.beginPath();
        overlay.lasso.forEach((p, i) => {
          const [sx, sy] = toScreen(p.x, p.y);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = this.colors.accent;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (overlay.marquee) {
        const m = overlay.marquee;
        const [x0, y0] = toScreen(m.minX, m.minY);
        const [x1, y1] = toScreen(m.maxX, m.maxY);
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = this.colors.accent;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.colors.accent;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      }
    } finally {
      ctx.restore();
    }
    return (w * h) / (cw * ch);
  }

  private drawItem(item: SceneItem, zoom: number): void {
    const b = item.bounds;
    const ctx = this.ctx;
    const type = item.element.type;
    if (type === 'sticky' || type === 'text') {
      this.drawNote(item, zoom);
      return;
    }
    if (type === 'shape' || type === 'arrow') {
      this.drawShape(item.element as ShapeElement | ArrowElement, item.color, item.ends);
      return;
    }
    // Совсем мелкий на экране элемент — точкой: контур из сотен кругов там всё равно не виден.
    if ((b.maxX - b.minX) * zoom < 1.5 && (b.maxY - b.minY) * zoom < 1.5) {
      const s = 1.5 / zoom;
      ctx.fillRect((b.minX + b.maxX) / 2 - s / 2, (b.minY + b.maxY) / 2 - s / 2, s, s);
      return;
    }
    item.path ??= samplesPath(item.samples);
    ctx.fill(item.path, 'nonzero');
  }

  private drawSelection(
    sel: SelectionOverlay,
    scene: Scene,
    toScreen: (x: number, y: number) => [number, number],
    t: Transform | null,
  ): void {
    const ctx = this.ctx;
    const map = (b: Bounds): Bounds => (t ? transformBounds(b, t) : b);
    ctx.strokeStyle = this.colors.accent;
    // Рамки отдельных элементов — видно, что именно попало в выделение.
    if (sel.ids.size > 1 && sel.ids.size <= 200) {
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      for (const id of sel.ids) {
        const item = scene.items.get(id);
        if (!item) continue;
        const b = map(item.bounds);
        const [x0, y0] = toScreen(b.minX, b.minY);
        const [x1, y1] = toScreen(b.maxX, b.maxY);
        ctx.strokeRect(x0 - 2.5, y0 - 2.5, x1 - x0 + 5, y1 - y0 + 5);
      }
      ctx.globalAlpha = 1;
    }
    const b = map(sel.bounds);
    const [x0, y0] = toScreen(b.minX, b.minY);
    const [x1, y1] = toScreen(b.maxX, b.maxY);
    const p = SELECTION_PAD;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x0 - p, y0 - p, x1 - x0 + 2 * p, y1 - y0 + 2 * p);
    ctx.setLineDash([]);
    if (!sel.handles) return;
    const hs = HANDLE_SIZE;
    for (const [hx, hy] of [
      [x0 - p, y0 - p],
      [x1 + p, y0 - p],
      [x1 + p, y1 + p],
      [x0 - p, y1 + p],
    ] as const) {
      ctx.fillStyle = this.colors.paper;
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }

  /** Прямоугольник, эллипс, линия или стрелка. */
  private drawShape(
    el: ShapeElement | ArrowElement,
    color: string | null,
    ends?: [{ x: number; y: number }, { x: number; y: number }],
  ): void {
    const ctx = this.ctx;
    const c = color ?? this.colors.ink;
    const size = el.style.size ?? DEFAULT_LINE;
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = size;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (el.type === 'arrow') {
      const [a, b] = ends ?? arrowEnds(el);
      const heads = el.props.heads ?? 'end';
      // Линия заканчивается у основания наконечника — острый кончик не скругляется толщиной.
      const tipEnd = heads !== 'none' ? arrowHead(a, b, size) : null;
      const tipStart = heads === 'both' ? arrowHead(b, a, size) : null;
      const base = (
        h: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
      ) => ({
        x: (h[1].x + h[2].x) / 2,
        y: (h[1].y + h[2].y) / 2,
      });
      const p0 = tipStart ? base(tipStart) : a;
      const p1 = tipEnd ? base(tipEnd) : b;
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      for (const h of [tipEnd, tipStart]) {
        if (!h) continue;
        ctx.beginPath();
        ctx.moveTo(h[0].x, h[0].y);
        ctx.lineTo(h[1].x, h[1].y);
        ctx.lineTo(h[2].x, h[2].y);
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    if (el.props.shape === 'ellipse') {
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.roundRect(el.x, el.y, el.w, el.h, Math.min(size * 2, el.w / 2, el.h / 2));
    }
    ctx.stroke();
  }

  /** Строки и высота текста стикера или заметки при данной ширине (для подгонки рамки). */
  measureNote(el: CanvasElement, content: string): { lines: string[]; height: number } {
    const sticky = el.type === 'sticky';
    const size = fontSizeOf(el);
    const pad = sticky ? size * (16 / STICKY_FONT_SIZE) : 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${sticky ? 500 : 400} ${size}px ${NOTE_FONT}`;
    const lines = wrapText(ctx, content, el.w - pad * 2);
    ctx.restore();
    return { lines, height: lines.length * size * LINE_HEIGHT + pad * 2 };
  }

  /** Стикер или текст. */
  private drawNote(item: SceneItem, zoom: number): void {
    const ctx = this.ctx;
    const b = item.bounds;
    const sticky = item.element.type === 'sticky';
    const size = fontSizeOf(item.element);
    const pad = sticky ? size * (16 / STICKY_FONT_SIZE) : 0;
    if (sticky) {
      ctx.fillStyle = item.color ?? STICKY_COLOR;
      ctx.beginPath();
      ctx.roundRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY, 6);
      ctx.fill();
    }
    if (size * zoom < 3 || item.id === this.editing) return; // текст неразличим или его правят
    const content =
      item.element.type === 'sticky' || item.element.type === 'text'
        ? item.element.props.content
        : '';
    ctx.font = `${sticky ? 500 : 400} ${size}px ${NOTE_FONT}`;
    // Середина строки — как в поле ввода (CSS делит межстрочный интервал поровну сверху и снизу).
    ctx.textBaseline = 'middle';
    item.lines ??= wrapText(ctx, content, b.maxX - b.minX - pad * 2);
    ctx.fillStyle = sticky ? STICKY_INK : (item.color ?? this.colors.ink);
    const lh = size * LINE_HEIGHT;
    const maxLines = Math.max(1, Math.floor((b.maxY - b.minY - pad * 2) / lh));
    const lines = sticky ? item.lines.slice(0, maxLines) : item.lines;
    lines.forEach((line, i) => ctx.fillText(line, b.minX + pad, b.minY + pad + (i + 0.5) * lh));
  }

  /** Точки сетки в участке (x, y, w, h — пиксели устройства); квадратики по пиксельной сетке — чётче. */
  private drawGrid(cam: Camera, x: number, y: number, w: number, h: number): void {
    const step = gridStepFor(cam.zoom);
    const k = this.dpr * cam.zoom;
    const px = step * k; // шаг в пикселях устройства
    const size = Math.max(2, Math.round(this.dpr * 1.5));
    const half = size / 2;
    // Мировые координаты точек: (i + 0.5) * step.
    const i0 = Math.floor((x / k + cam.x) / step - 0.5);
    const i1 = Math.ceil(((x + w) / k + cam.x) / step - 0.5);
    const j0 = Math.floor((y / k + cam.y) / step - 0.5);
    const j1 = Math.ceil(((y + h) / k + cam.y) / step - 0.5);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 20_000) return; // защита от вырожденных случаев
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.dot;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      const sy = Math.round((j + 0.5) * px - cam.y * k - half);
      for (let i = i0; i <= i1; i++) {
        ctx.rect(Math.round((i + 0.5) * px - cam.x * k - half), sy, size, size);
      }
    }
    ctx.fill();
  }
}
