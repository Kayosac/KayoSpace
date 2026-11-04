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
import { STICKY_FONT_SIZE, applyTransform, fontSizeOf, type Transform } from '@kayospace/board';
import type { ArrowElement, CanvasElement, ShapeElement } from '@kayospace/model';
import { DEFAULT_LINE, arrowEnds, arrowHead } from './shapes';
import { screenToWorld, worldToScreen, type Camera } from './camera';
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

/** Источник картинок: decoded-изображение нужного размера или null (тогда — заглушка и загрузка). */
export interface ImageSource {
  get(assetId: string, pixels: number): CanvasImageSource | null;
}

export interface StickyFit {
  size: number;
  lines: string[];
  pad: number;
}

/** Внутренний отступ стикера: 16 при ширине 200. */
export const stickyPad = (w: number): number => w * 0.08;

const scaled = (measure: (s: string) => number, size: number) => ({
  measureText: (str: string) => ({ width: (measure(str) * size) / 100 }),
});

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
/** Насколько ручка поворота выше рамки, CSS-пиксели. */
export const ROTATE_HANDLE_OFFSET = 26;

/** Середина верхней стороны рамки выделения и ручка поворота над ней (мировые координаты). */
export function rotateHandleWorld(
  b: Bounds,
  zoom: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const x = (b.minX + b.maxX) / 2;
  const top = b.minY - SELECTION_PAD / zoom;
  return [
    { x, y: top },
    { x, y: top - ROTATE_HANDLE_OFFSET / zoom },
  ];
}

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
  private readonly widths: Record<number, Map<string, number>> = {};
  /** Откуда брать картинки (готовые к отрисовке); null — показываем заглушки. */
  images: ImageSource | null = null;
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

  /** Матрица мир → пиксели устройства [a, b, c, d, e, f] (как у setTransform). */
  worldMatrix(cam: Camera): [number, number, number, number, number, number] {
    const k = this.dpr * cam.zoom;
    const r = cam.rotation ?? 0;
    const a = k * Math.cos(r);
    const b = k * Math.sin(r);
    return [a, b, -b, a, -(a * cam.x - b * cam.y), -(b * cam.x + a * cam.y)];
  }

  /** Мировая рамка → прямоугольник в пикселях устройства с запасом на сглаживание. */
  worldRect(cam: Camera, b: Bounds | null, pad = 2): Rect | null {
    if (!b) return null;
    const k = this.dpr * cam.zoom;
    if (!cam.rotation) {
      return {
        x0: Math.floor((b.minX - cam.x) * k) - pad,
        y0: Math.floor((b.minY - cam.y) * k) - pad,
        x1: Math.ceil((b.maxX - cam.x) * k) + pad,
        y1: Math.ceil((b.maxY - cam.y) * k) + pad,
      };
    }
    const [ma, mb, mc, md, me, mf] = this.worldMatrix(cam);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [wx, wy] of [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.maxX, b.maxY],
      [b.minX, b.maxY],
    ] as const) {
      xs.push(ma * wx + mc * wy + me);
      ys.push(mb * wx + md * wy + mf);
    }
    return {
      x0: Math.floor(Math.min(...xs)) - pad,
      y0: Math.floor(Math.min(...ys)) - pad,
      x1: Math.ceil(Math.max(...xs)) + pad,
      y1: Math.ceil(Math.max(...ys)) + pad,
    };
  }

  /** Участок в пикселях устройства → рамка видимого мира. */
  private deviceToWorldBounds(cam: Camera, x: number, y: number, w: number, h: number): Bounds {
    const c = { ...cam, zoom: cam.zoom * this.dpr };
    const pts = [
      screenToWorld(c, x, y),
      screenToWorld(c, x + w, y),
      screenToWorld(c, x + w, y + h),
      screenToWorld(c, x, y + h),
    ];
    return {
      minX: Math.min(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxX: Math.max(...pts.map((p) => p.x)),
      maxY: Math.max(...pts.map((p) => p.y)),
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

    // Участок в мировых координатах — для выбора элементов, которые его задевают.
    const view = this.deviceToWorldBounds(cam, x, y, w, h);
    const m = this.worldMatrix(cam);
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

      ctx.setTransform(...m);
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
        const pc = Math.cos(t.r ?? 0) * t.s;
        const ps = Math.sin(t.r ?? 0) * t.s;
        ctx.transform(pc, ps, -ps, pc, t.tx, t.ty);
        for (const id of preview.ids) {
          const item = scene.items.get(id);
          if (!item) continue;
          setFill(item.color);
          this.drawItem(item, cam.zoom * t.s);
          if (item.element.type !== 'stroke') fill = '';
        }
        ctx.setTransform(...m);
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
      const toScreen = (wx: number, wy: number): [number, number] => {
        const p = worldToScreen(cam, wx, wy);
        return [p.x, p.y];
      };
      if (selection) {
        this.drawSelection(selection, scene, toScreen, preview?.t ?? null, cam.zoom);
      }
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
        const mq = overlay.marquee;
        ctx.beginPath();
        (
          [
            [mq.minX, mq.minY],
            [mq.maxX, mq.minY],
            [mq.maxX, mq.maxY],
            [mq.minX, mq.maxY],
          ] as const
        ).forEach(([wx, wy], i) => {
          const [sx, sy] = toScreen(wx, wy);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.closePath();
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = this.colors.accent;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.colors.accent;
        ctx.stroke();
      }
    } finally {
      ctx.restore();
    }
    return (w * h) / (cw * ch);
  }

  private drawItem(item: SceneItem, zoom: number): void {
    const b = item.bounds;
    const ctx = this.ctx;
    const el = item.element;
    const type = el.type;
    if (type === 'sticky' || type === 'text' || type === 'image' || type === 'shape') {
      // Элементы-рамки: рисуем в своей системе координат, повёрнутой вокруг центра.
      const r = el.rotation ?? 0;
      if (r) {
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(r);
        ctx.translate(-cx, -cy);
      }
      if (type === 'sticky' || type === 'text') this.drawNote(item, zoom);
      else if (type === 'image') this.drawImage(item, zoom);
      else this.drawShape(el as ShapeElement, item.color);
      if (r) ctx.restore();
      return;
    }
    if (type === 'arrow') {
      this.drawShape(el as ArrowElement, item.color, item.ends);
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

  private drawImage(item: SceneItem, zoom: number): void {
    const el = item.element;
    if (el.type !== 'image') return;
    const ctx = this.ctx;
    const src = this.images?.get(el.props.assetId, Math.max(el.w, el.h) * zoom * this.dpr) ?? null;
    if (src) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, el.x, el.y, el.w, el.h);
      return;
    }
    // Картинка ещё грузится (или её нет на этом устройстве) — серая заглушка.
    ctx.fillStyle = this.colors.dot;
    ctx.fillRect(el.x, el.y, el.w, el.h);
  }

  private drawSelection(
    sel: SelectionOverlay,
    scene: Scene,
    toScreen: (x: number, y: number) => [number, number],
    t: Transform | null,
    zoom: number,
  ): void {
    const ctx = this.ctx;
    // Углы рамки в мире → (преобразование жеста) → экран: при повороте рамка тоже повёрнута.
    const quad = (b: Bounds, pad: number): [number, number][] =>
      (
        [
          [b.minX - pad, b.minY - pad],
          [b.maxX + pad, b.minY - pad],
          [b.maxX + pad, b.maxY + pad],
          [b.minX - pad, b.maxY + pad],
        ] as const
      ).map(([x, y]) => {
        const q = t ? applyTransform(t, x, y) : { x, y };
        return toScreen(q.x, q.y);
      });
    const poly = (pts: [number, number][]): void => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    };
    ctx.strokeStyle = this.colors.accent;
    // Рамки отдельных элементов — видно, что именно попало в выделение.
    if (sel.ids.size > 1 && sel.ids.size <= 200) {
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      for (const id of sel.ids) {
        const item = scene.items.get(id);
        if (!item) continue;
        poly(quad(item.bounds, 2.5 / zoom));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const corners = quad(sel.bounds, SELECTION_PAD / zoom);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    poly(corners);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!sel.handles) return;
    const hs = HANDLE_SIZE;
    ctx.lineWidth = 1.5;
    for (const [hx, hy] of corners) {
      ctx.fillStyle = this.colors.paper;
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    // Ручка поворота — над серединой верхней стороны.
    const [top, rot] = rotateHandleWorld(sel.bounds, zoom).map((p) => {
      const q = t ? applyTransform(t, p.x, p.y) : p;
      return toScreen(q.x, q.y);
    }) as [[number, number], [number, number]];
    ctx.beginPath();
    ctx.moveTo(top[0], top[1]);
    ctx.lineTo(rot[0], rot[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rot[0], rot[1], HANDLE_SIZE * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.paper;
    ctx.fill();
    ctx.stroke();
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
    if (el.type === 'sticky') {
      const fit = this.fitSticky(content, el.w, el.h);
      return { lines: fit.lines, height: el.h };
    }
    const size = fontSizeOf(el);
    const measure = this.measurer(400);
    const lines = wrapText(scaled(measure, size), content, el.w);
    return { lines, height: lines.length * size * LINE_HEIGHT };
  }

  /**
   * Текст стикера — самым крупным шрифтом, при котором он целиком помещается (слова не рвутся).
   * Если даже мелкий шрифт не помогает — мелкий шрифт с переносом внутри слов.
   */
  fitSticky(content: string, w: number, h: number): StickyFit {
    const pad = stickyPad(w);
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const measure = this.measurer(500);
    const max = Math.max(1, Math.min(iw, ih) * 0.42);
    const min = Math.max(0.5, w * 0.035);
    const text = content.trim() ? content : '';
    if (!text) return { size: Math.min(max, w * (STICKY_FONT_SIZE / 200)), lines: [], pad };
    const words = text.split(/\s+/).filter(Boolean);
    const widest = Math.max(...words.map((wd) => measure(wd)));
    const fits = (size: number): string[] | null => {
      if ((widest * size) / 100 > iw) return null;
      const lines = wrapText(scaled(measure, size), text, iw);
      return lines.length * size * LINE_HEIGHT <= ih ? lines : null;
    };
    let lo = min;
    let hi = max;
    let best = fits(lo);
    if (!best) {
      return { size: min, lines: wrapText(scaled(measure, min), text, iw), pad };
    }
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const lines = fits(mid);
      if (lines) {
        lo = mid;
        best = lines;
      } else {
        hi = mid;
      }
    }
    return { size: lo, lines: best, pad };
  }

  /** Ширина строки шрифтом 100 px (кэш): ширина при другом размере — пропорциональна. */
  private measurer(weight: number): (s: string) => number {
    const cache = this.widths[weight] ?? (this.widths[weight] = new Map());
    return (str: string) => {
      let wd = cache.get(str);
      if (wd === undefined) {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = `${weight} 100px ${NOTE_FONT}`;
        wd = ctx.measureText(str).width;
        ctx.restore();
        if (cache.size > 20_000) cache.clear();
        cache.set(str, wd);
      }
      return wd;
    };
  }

  /** Стикер или текст. */
  private drawNote(item: SceneItem, zoom: number): void {
    const ctx = this.ctx;
    const el = item.element;
    if (el.type !== 'sticky' && el.type !== 'text') return;
    const sticky = el.type === 'sticky';
    if (sticky) {
      ctx.fillStyle = item.color ?? STICKY_COLOR;
      ctx.beginPath();
      ctx.roundRect(el.x, el.y, el.w, el.h, Math.min(6, el.w * 0.03));
      ctx.fill();
    }
    if (item.id === this.editing) return; // текст рисует поле ввода
    let size: number;
    let pad: number;
    let lines: string[];
    if (sticky) {
      const key = `${el.w}|${el.h}|${el.props.content}`;
      if (item.fit?.key !== key)
        item.fit = { key, ...this.fitSticky(el.props.content, el.w, el.h) };
      ({ size, pad, lines } = item.fit);
    } else {
      size = fontSizeOf(el);
      pad = 0;
      item.lines ??= wrapText(scaled(this.measurer(400), size), el.props.content, el.w);
      lines = item.lines;
    }
    if (size * zoom < 3 || lines.length === 0) return; // текст неразличим — не тратим время
    ctx.font = `${sticky ? 500 : 400} ${size}px ${NOTE_FONT}`;
    // Середина строки — как в поле ввода (CSS делит межстрочный интервал поровну сверху и снизу).
    ctx.textBaseline = 'middle';
    ctx.fillStyle = sticky ? STICKY_INK : (item.color ?? this.colors.ink);
    const lh = size * LINE_HEIGHT;
    // Стикер: блок текста — по центру по вертикали.
    const top = sticky ? el.y + (el.h - lines.length * lh) / 2 : el.y;
    lines.forEach((line, i) => ctx.fillText(line, el.x + pad, top + (i + 0.5) * lh));
  }

  /** Точки сетки в участке (x, y, w, h — пиксели устройства); квадратики по пиксельной сетке — чётче. */
  private drawGrid(cam: Camera, x: number, y: number, w: number, h: number): void {
    const step = gridStepFor(cam.zoom);
    const k = this.dpr * cam.zoom;
    const size = Math.max(2, Math.round(this.dpr * 1.5));
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.dot;
    if (cam.rotation) {
      // Повёрнутый вид: точки — в мире, под общей матрицей (немного мягче, зато верно повёрнуты).
      const v = this.deviceToWorldBounds(cam, x, y, w, h);
      const i0 = Math.floor(v.minX / step - 0.5);
      const i1 = Math.ceil(v.maxX / step - 0.5);
      const j0 = Math.floor(v.minY / step - 0.5);
      const j1 = Math.ceil(v.maxY / step - 0.5);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 20_000) return;
      const ws = size / k;
      ctx.save();
      ctx.setTransform(...this.worldMatrix(cam));
      ctx.beginPath();
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          ctx.rect((i + 0.5) * step - ws / 2, (j + 0.5) * step - ws / 2, ws, ws);
        }
      }
      ctx.fill();
      ctx.restore();
      return;
    }
    const px = step * k; // шаг в пикселях устройства
    const half = size / 2;
    // Мировые координаты точек: (i + 0.5) * step.
    const i0 = Math.floor((x / k + cam.x) / step - 0.5);
    const i1 = Math.ceil(((x + w) / k + cam.x) / step - 0.5);
    const j0 = Math.floor((y / k + cam.y) / step - 0.5);
    const j1 = Math.ceil(((y + h) / k + cam.y) / step - 0.5);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 20_000) return; // защита от вырожденных случаев
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
