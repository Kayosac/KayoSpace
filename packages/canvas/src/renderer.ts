/**
 * Отрисовка холста на одну видимую канву — тот же подход, что проверен в Pen Lab (решение 0003):
 * никаких промежуточных слоёв и копирования между канвами; изменившийся участок
 * перерисовывается из векторных данных: бумага, сетка, элементы сцены, активный штрих.
 *
 * Прямоугольники перерисовки — в пикселях устройства. Мировые рамки переводятся через камеру.
 */

import {
  boundsIntersect,
  samplesPath,
  samplesPathInRect,
  type Bounds,
  type Sample,
} from '@kayospace/ink';
import {
  STICKY_FONT_SIZE,
  applyTransform,
  fontSizeOf,
  TEXT_FONT_SIZE,
  type BoardBackground,
  type Transform,
} from '@kayospace/board';
import {
  ROUND_RECT_RADIUS,
  shapePolygon,
  type ArrowElement,
  type CanvasElement,
  type FrameElement,
  type ShapeElement,
} from '@kayospace/model';
import { frameTitleBand } from './frames';
import { DEFAULT_LINE, arrowEnds, arrowHead } from './shapes';
import { LOD_MAX_WIDTH, appendLine, lodLevel, meanRadius, simplifyLine } from './lod';
import { screenToWorld, worldToScreen, type Camera } from './camera';
import { strokeAlpha, type Scene, type SceneItem } from './scene';

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
  /** Заливка и край фрейма. */
  frame: string;
  frameLine: string;
}

/** Штрих, который сейчас рисуется: стабильная часть и хвост (мировые координаты). */
export interface ActiveStroke {
  samples: readonly Sample[];
  tail: readonly Sample[];
  color: string | null;
  /** Прозрачность (выделитель). */
  alpha?: number;
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
  /** Показывать ручку поворота (фреймы не поворачиваются). */
  rotatable?: boolean;
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
  /** Предпросмотр правок ИИ: что подсветить и что ИИ удалил (рисуем бледно). */
  ai?: { ids: ReadonlySet<string>; deleted: readonly SceneItem[] } | null;
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

/** Цвета экспорта: светлая тема на белом — для печати и пересылки. */
export const EXPORT_COLORS: ThemeColors = {
  paper: '#ffffff',
  ink: '#1c1f26',
  dot: '#dcd9d0',
  accent: '#3e63dd',
  frame: '#ffffff',
  frameLine: 'rgba(28, 31, 38, 0.18)',
};

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

/** Срок коротко: «сегодня», «12.11» (другой год — «12.11.27»). */
export function shortDue(due: string, today: string): string {
  if (due === today) return 'сегодня';
  const [y, m, d] = due.split('-');
  return `${d}.${m}${y === today.slice(0, 4) ? '' : `.${y!.slice(2)}`}`;
}

/** Полоса задачи внизу стикера (решение 0019): статус, срок, важность. 0 — не задача. */
export function taskBand(el: CanvasElement): number {
  return el.type === 'sticky' && el.props.task ? el.h * 0.17 : 0;
}

const TASK_RED = '#d93d42';
const TASK_DONE = '#2f9e66';

/**
 * Текст, который при таком масштабе неразличим, — полосками по строкам (решение 0022): длина —
 * примерно по числу символов, без замеров шрифта (их тысячи на отдалённой доске).
 */
export function textBars(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  x: number,
  top: number,
  size: number,
  color: string,
  zoom: number,
  maxW = Infinity,
): void {
  const lh = size * LINE_HEIGHT;
  const h = Math.max(size * 0.5, 1 / zoom);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.28;
  // Строки тоньше пикселя — одним блоком на весь текст.
  if (lh * zoom < 1.5) {
    const w = Math.min(maxW, Math.max(...lines.map((l) => l.length)) * size * 0.5);
    ctx.fillRect(x, top, Math.max(w, 1 / zoom), Math.max(lines.length * lh * 0.8, 1 / zoom));
  } else {
    for (let i = 0; i < lines.length; i++) {
      const w = Math.min(maxW, lines[i]!.length * size * 0.5);
      if (w > 0) ctx.fillRect(x, top + i * lh + (lh - h) / 2, w, h);
    }
  }
  ctx.globalAlpha = 1;
}

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
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Не рисовать сетку (экспорт картинки). */
  private noGrid = false;
  dpr = 1;
  /** Размер в CSS-пикселях. */
  width = 1;
  height = 1;
  colors: ThemeColors = {
    paper: '#fbfaf7',
    ink: '#16213a',
    dot: '#d9d6cf',
    accent: '#3e63dd',
    frame: '#ffffff',
    frameLine: 'rgba(28, 31, 38, 0.18)',
  };
  /** Удалось ли включить низколатентный режим (для диагностики). */
  readonly desynchronized: boolean;

  /** Участки, которые нужно перерисовать (пиксели устройства). */
  private rects: Rect[] = [];
  /** Камера, при которой нарисована картинка на канве (null — ещё ничего не нарисовано). */
  private paintedCam: Camera | null = null;
  /**
   * Картинка на канве приблизительная: сдвинута на дробное число пикселей или растянута при зуме.
   * Её нужно перерисовать начисто, когда вид перестанет меняться.
   */
  approx = false;
  /**
   * Картинка растянута CSS-трансформацией (зум на тяжёлой доске): камера, при которой она нарисована.
   * Пока растянута, любая перерисовка — полная (она же снимает трансформацию).
   */
  private stretchFrom: Camera | null = null;
  /** Сколько заняла последняя полная перерисовка, мс (JS) и когда она была (performance.now()). */
  lastFullMs = 0;
  lastFullAt = 0;
  private editing: string | null = null;
  private readonly widths: Record<number, Map<string, number>> = {};
  /** Откуда брать картинки (готовые к отрисовке); null — показываем заглушки. */
  images: ImageSource | null = null;
  private full = true;

  /**
   * lowLatency — канва в режиме низкой задержки (desynchronized): перо отзывчивее, но на части
   * экранов (Windows) при сдвиге холста видны разрывы картинки.
   */
  constructor(host: HTMLElement, opts: { lowLatency?: boolean } = {}) {
    const c = document.createElement('canvas');
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.display = 'block';
    const ctx = c.getContext('2d', { desynchronized: opts.lowLatency ?? true, alpha: false });
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
    return this.full || this.rects.length > 0;
  }

  invalidateAll(): void {
    this.full = true;
  }

  invalidate(r: Rect | null): void {
    if (!r || this.full) return;
    // Пересекающиеся и соседние участки сливаем; много участков — один общий.
    let cur = r;
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = this.rects.length - 1; i >= 0; i--) {
        const o = this.rects[i]!;
        if (o.x0 <= cur.x1 + 8 && o.x1 >= cur.x0 - 8 && o.y0 <= cur.y1 + 8 && o.y1 >= cur.y0 - 8) {
          cur = unionRect(cur, o)!;
          this.rects.splice(i, 1);
          merged = true;
        }
      }
    }
    this.rects.push(cur);
    if (this.rects.length > 6) this.rects = [this.rects.reduce((a, b) => unionRect(a, b)!)];
  }

  /**
   * Перейти к новой камере, не перерисовывая всё:
   *   - тот же масштаб и поворот — картинка сдвигается, дорисовываются открывшиеся полосы;
   *   - другой масштаб (stretch = true) — картинка растягивается (приблизительно, approx),
   *     чёткую перерисовку движок делает реже и в конце жеста;
   *   - иначе — полная перерисовка.
   */
  moveTo(cam: Camera, stretch: boolean): void {
    const prev = this.paintedCam;
    if (this.full || !prev) {
      this.full = true;
      return;
    }
    const sameRot = (prev.rotation ?? 0) === (cam.rotation ?? 0);
    if (
      prev.x === cam.x &&
      prev.y === cam.y &&
      prev.zoom === cam.zoom &&
      sameRot &&
      !this.stretchFrom
    ) {
      return;
    }
    if (!sameRot) {
      this.full = true;
      return;
    }
    if (this.stretchFrom || prev.zoom !== cam.zoom) {
      if (!stretch) {
        this.full = true;
        return;
      }
      // Растягивает композитор браузера (CSS-трансформация): растр канвы не трогаем вовсе.
      // Картинка нарисована при камере prev — переводим её экран в экран новой камеры.
      const o = worldToScreen(cam, prev.x, prev.y);
      const k = cam.zoom / prev.zoom;
      const style = this.canvas.style;
      // Свой слой композитора — только на время растяжения: так трансформация не перерисовывает
      // страницу, а в остальное время у канвы остаётся режим низкой задержки для пера (решение 0003).
      style.willChange = 'transform';
      style.transformOrigin = '0 0';
      style.transform = `matrix(${k}, 0, 0, ${k}, ${o.x}, ${o.y})`;
      this.stretchFrom = prev;
      this.approx = true;
      this.rects = [];
      return;
    }
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    // Тот же масштаб: куда на новом экране попадает левый верхний угол старого (пиксели устройства).
    const o = worldToScreen(cam, prev.x, prev.y);
    const dx = o.x * this.dpr;
    const dy = o.y * this.dpr;
    if (Math.abs(dx) >= cw * 0.8 || Math.abs(dy) >= ch * 0.8) {
      this.full = true;
      return;
    }
    // Сдвигаем только на целое число пикселей устройства: дробный сдвиг пересэмплирует картинку,
    // и за жест размытие копится кадр за кадром (на Windows с масштабом 125% сдвиг дробный почти
    // всегда). Остаток меньше полупикселя не теряется: картинка считается нарисованной при камере,
    // сдвинутой на этот остаток, — по ней же дорисовываются полосы и участки.
    const ix = Math.round(dx);
    const iy = Math.round(dy);
    if (ix === 0 && iy === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Канва копируется сама на себя (браузер сначала снимает копию источника).
    ctx.drawImage(this.canvas, ix, iy);
    ctx.restore();
    // Ранее отмеченные участки уехали вместе с картинкой.
    const old = this.rects;
    this.rects = [];
    for (const r of old) {
      this.invalidate({ x0: r.x0 + ix, y0: r.y0 + iy, x1: r.x1 + ix, y1: r.y1 + iy });
    }
    if (ix > 0) this.invalidate({ x0: 0, y0: 0, x1: ix + 2, y1: ch });
    if (ix < 0) this.invalidate({ x0: cw + ix - 2, y0: 0, x1: cw, y1: ch });
    if (iy > 0) this.invalidate({ x0: 0, y0: 0, x1: cw, y1: iy + 2 });
    if (iy < 0) this.invalidate({ x0: 0, y0: ch + iy - 2, x1: cw, y1: ch });
    this.paintedCam = snappedCamera(cam, (dx - ix) / this.dpr, (dy - iy) / this.dpr);
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
    this.editing = overlay.editing ?? null;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    // Растянутая картинка не совпадает с камерой: частичная перерисовка легла бы криво — рисуем всё.
    if (this.stretchFrom && this.rects.length > 0) this.full = true;
    if (this.full) {
      this.full = false;
      this.rects = [];
      this.approx = false;
      if (this.stretchFrom) {
        this.stretchFrom = null;
        this.canvas.style.transform = '';
        this.canvas.style.willChange = '';
      }
      const t0 = performance.now();
      this.paintRect(cam, scene, overlay, 0, 0, cw, ch, false);
      this.lastFullAt = performance.now();
      this.lastFullMs = this.lastFullAt - t0;
      this.paintedCam = { ...cam };
      return 1;
    }
    // Участки дорисовываем при камере картинки (после сдвига она отстаёт от камеры меньше
    // чем на полпикселя), иначе на стыке с готовой картинкой был бы шов.
    const at =
      this.paintedCam && closeCamera(this.paintedCam, cam, this.dpr) ? this.paintedCam : null;
    if (!at) {
      this.full = true;
      return this.paint(cam, scene, overlay);
    }
    const rects = this.rects;
    this.rects = [];
    let area = 0;
    for (const r of rects) {
      const x = Math.max(0, r.x0);
      const y = Math.max(0, r.y0);
      const w = Math.min(cw, r.x1) - x;
      const h = Math.min(ch, r.y1) - y;
      if (w <= 0 || h <= 0) continue;
      this.paintRect(at, scene, overlay, x, y, w, h, true);
      area += w * h;
    }
    return area / (cw * ch);
  }

  /** Перерисовать участок (пиксели устройства); clip — только внутри него. */
  private paintRect(
    cam: Camera,
    scene: Scene,
    overlay: PaintOverlay,
    x: number,
    y: number,
    w: number,
    h: number,
    clip: boolean,
  ): void {
    const { active = null, ring = null, preview = null, selection = null } = overlay;
    const region = clip;

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
      // Тонкие на экране штрихи копятся в общие пути и рисуются одним вызовом (см. lod.ts).
      const k = cam.zoom * this.dpr;
      const level = lodLevel(k);
      const tol = 2 ** level;
      let lines: { path: Path2D; color: string; width: number; alpha: number } | null = null;
      let dots: { path: Path2D; color: string } | null = null;
      const flush = (): void => {
        if (lines) {
          ctx.strokeStyle = lines.color;
          ctx.lineWidth = lines.width;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.globalAlpha = lines.alpha;
          ctx.stroke(lines.path);
          ctx.globalAlpha = 1;
          lines = null;
        }
        if (dots) {
          ctx.fillStyle = fill = dots.color;
          ctx.fill(dots.path);
          dots = null;
        }
      };
      for (const item of scene.query(view)) {
        if (preview?.ids.has(item.id)) continue;
        if (item.element.type === 'stroke') {
          const color = item.color ?? this.colors.ink;
          const b = item.bounds;
          if ((b.maxX - b.minX) * cam.zoom < 1.5 && (b.maxY - b.minY) * cam.zoom < 1.5) {
            // Совсем мелкий на экране штрих — точкой.
            if (lines || (dots && dots.color !== color)) flush();
            dots ??= { path: new Path2D(), color };
            const sz = 1.5 / cam.zoom;
            dots.path.rect((b.minX + b.maxX - sz) / 2, (b.minY + b.maxY - sz) / 2, sz, sz);
            continue;
          }
          item.meanR ??= meanRadius(item.samples);
          const px = item.meanR * 2 * k;
          if (px <= LOD_MAX_WIDTH) {
            // Толщина — шагами в четверть пикселя: соседние штрихи попадают в один путь.
            const width = Math.max(0.5, Math.round(px * 4) / 4) / k;
            const alpha = strokeAlpha(item.element);
            if (
              dots ||
              (lines && (lines.color !== color || lines.width !== width || lines.alpha !== alpha))
            ) {
              flush();
            }
            if (item.lod?.level !== level) {
              item.lod = { level, pts: simplifyLine(item.samples, tol) };
            }
            lines ??= { path: new Path2D(), color, width, alpha };
            appendLine(lines.path, item.lod.pts);
            continue;
          }
        }
        flush();
        setFill(item.color);
        this.drawItem(item, cam.zoom);
        if (item.element.type !== 'stroke') fill = ''; // стикер и фигура сами меняют fillStyle
      }
      flush();
      if (overlay.ai && overlay.ai.deleted.length > 0) {
        // Что ИИ предлагает удалить — бледным.
        ctx.globalAlpha = 0.22;
        for (const item of overlay.ai.deleted) {
          if (!boundsIntersect(item.bounds, view)) continue;
          setFill(item.color);
          this.drawItem(item, cam.zoom);
          fill = '';
        }
        ctx.globalAlpha = 1;
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
        const tail =
          active.tail.length > 0 && boundsIntersect(samplesWorldBounds(active.tail)!, view)
            ? samplesPath(active.tail)
            : null;
        // Одной заливкой: у полупрозрачного выделителя стык с хвостом не темнеет.
        const path = stable ?? tail;
        if (path && stable && tail) path.addPath(tail);
        if (path) {
          ctx.globalAlpha = active.alpha ?? 1;
          ctx.fill(path, 'nonzero');
          ctx.globalAlpha = 1;
        }
      }
      if (overlay.draft) {
        const d = overlay.draft;
        if (d.type === 'shape' || d.type === 'arrow') this.drawShape(d, d.style.color ?? null);
        if (d.type === 'frame') this.drawFrame(d, cam.zoom);
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
      if (overlay.ai) this.drawAiMarks(overlay.ai, scene, toScreen);
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
  }

  private drawItem(item: SceneItem, zoom: number): void {
    const b = item.bounds;
    const ctx = this.ctx;
    const el = item.element;
    const type = el.type;
    if (
      type === 'sticky' ||
      type === 'text' ||
      type === 'image' ||
      type === 'shape' ||
      type === 'doc'
    ) {
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
      else if (type === 'doc') this.drawDocCard(item, zoom);
      else this.drawShape(el as ShapeElement, item.color);
      if (r) ctx.restore();
      return;
    }
    if (type === 'arrow') {
      this.drawShape(el as ArrowElement, item.color, item.ends);
      return;
    }
    if (type === 'frame') {
      this.drawFrame(el as FrameElement, zoom);
      return;
    }
    // Совсем мелкий на экране элемент — точкой: контур из сотен кругов там всё равно не виден.
    if ((b.maxX - b.minX) * zoom < 1.5 && (b.maxY - b.minY) * zoom < 1.5) {
      const s = 1.5 / zoom;
      ctx.fillRect((b.minX + b.maxX) / 2 - s / 2, (b.minY + b.maxY) / 2 - s / 2, s, s);
      return;
    }
    item.path ??= samplesPath(item.samples);
    const alpha = strokeAlpha(el);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.fill(item.path, 'nonzero');
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  /** Карточка документа или таблицы (решение 0021): метка, название, начало текста. */
  private drawDocCard(item: SceneItem, zoom: number): void {
    const el = item.element;
    if (el.type !== 'doc') return;
    const ctx = this.ctx;
    const table = el.props.doc.startsWith('tb_');
    ctx.fillStyle = this.colors.frame;
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 10);
    ctx.fill();
    // Миниатюра (решение 0022): страница сверху, внизу полоса с названием.
    const thumb = el.props.thumb
      ? (this.images?.get(el.props.thumb, Math.max(el.w, el.h) * zoom * this.dpr) ?? null)
      : null;
    if (thumb) {
      this.drawDocThumb(el, thumb, zoom, table);
      return;
    }
    ctx.lineWidth = 1.5 / Math.max(zoom, 0.5);
    ctx.strokeStyle = this.colors.frameLine;
    ctx.stroke();
    ctx.fillStyle = table ? TASK_DONE : this.colors.accent;
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, 4, el.h, 2);
    ctx.fill();
    const pad = 16;
    const title = el.props.title || (table ? 'Таблица' : 'Документ');
    if (18 * zoom < 3) {
      textBars(
        ctx,
        [title],
        el.x + pad,
        el.y + pad + 22,
        18,
        this.colors.ink,
        zoom,
        el.w - pad * 2,
      );
      return;
    }
    const key = `${el.w}|${el.h}|${title}|${el.props.excerpt ?? ''}`;
    if (item.card?.key !== key) {
      const iw = el.w - pad * 2;
      const titleLines = wrapText(scaled(this.measurer(700), 18), title, iw).slice(0, 2);
      const room = Math.max(
        0,
        Math.floor(
          (el.h - pad * 2 - 22 - titleLines.length * 18 * LINE_HEIGHT - 8) / (14 * LINE_HEIGHT),
        ),
      );
      const body = (el.props.excerpt ?? '')
        .split('\n')
        .flatMap((l) => wrapText(scaled(this.measurer(400), 14), l, iw))
        .slice(0, room);
      item.card = { key, title: titleLines, body };
    }
    ctx.textBaseline = 'middle';
    ctx.font = `600 11px ${NOTE_FONT}`;
    ctx.fillStyle = this.colors.ink;
    ctx.globalAlpha = 0.55;
    ctx.fillText(table ? 'ТАБЛИЦА' : 'ДОКУМЕНТ', el.x + pad, el.y + pad + 5);
    ctx.globalAlpha = 1;
    ctx.font = `700 18px ${NOTE_FONT}`;
    let y = el.y + pad + 22;
    for (const l of item.card.title) {
      ctx.fillText(l, el.x + pad, y + (18 * LINE_HEIGHT) / 2);
      y += 18 * LINE_HEIGHT;
    }
    y += 6;
    ctx.font = `400 14px ${NOTE_FONT}`;
    ctx.globalAlpha = 0.7;
    for (const l of item.card.body) {
      ctx.fillText(l, el.x + pad, y + (14 * LINE_HEIGHT) / 2);
      y += 14 * LINE_HEIGHT;
    }
    ctx.globalAlpha = 1;
  }

  private drawDocThumb(
    el: CanvasElement & { type: 'doc' },
    src: CanvasImageSource,
    zoom: number,
    table: boolean,
  ): void {
    const ctx = this.ctx;
    const bar = Math.min(44, el.h * 0.3);
    const iw = (src as { width: number }).width || 480;
    const ih = (src as { height: number }).height || 300;
    // Как «cover» сверху: заполняем ширину, лишнее снизу обрезаем.
    const areaH = el.h - bar;
    const k = Math.max(el.w / iw, areaH / ih);
    const sw = el.w / k;
    const sh = areaH / k;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 10);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (iw - sw) / 2, 0, sw, sh, el.x, el.y, el.w, areaH);
    ctx.fillStyle = this.colors.paper;
    ctx.fillRect(el.x, el.y + areaH, el.w, bar);
    ctx.fillStyle = this.colors.frameLine;
    ctx.fillRect(el.x, el.y + areaH, el.w, 1 / Math.max(zoom, 0.5));
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 10);
    ctx.lineWidth = 1.5 / Math.max(zoom, 0.5);
    ctx.strokeStyle = this.colors.frameLine;
    ctx.stroke();
    if (14 * zoom < 3) return;
    const pad = 14;
    const cy = el.y + areaH + bar / 2;
    ctx.textBaseline = 'middle';
    ctx.font = `600 10px ${NOTE_FONT}`;
    const label = table ? 'ТАБЛИЦА' : 'ДОКУМЕНТ';
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = table ? TASK_DONE : this.colors.accent;
    ctx.fillText(label, el.x + el.w - pad - lw, cy);
    ctx.font = `700 14px ${NOTE_FONT}`;
    ctx.fillStyle = this.colors.ink;
    let title = el.props.title || (table ? 'Таблица' : 'Документ');
    const room = el.w - pad * 3 - lw;
    if (ctx.measureText(title).width > room) {
      while (title.length > 1 && ctx.measureText(`${title}…`).width > room)
        title = title.slice(0, -1);
      title = `${title}…`;
    }
    ctx.fillText(title, el.x + pad, cy);
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

  /** Рамки вокруг того, что ИИ добавил или изменил (сплошные), и удалённого (пунктир). */
  private drawAiMarks(
    ai: NonNullable<PaintOverlay['ai']>,
    scene: Scene,
    toScreen: (x: number, y: number) => [number, number],
  ): void {
    const ctx = this.ctx;
    const outline = (b: Bounds): void => {
      ctx.beginPath();
      (
        [
          [b.minX, b.minY],
          [b.maxX, b.minY],
          [b.maxX, b.maxY],
          [b.minX, b.maxY],
        ] as const
      ).forEach(([wx, wy], i) => {
        const [sx, sy] = toScreen(wx, wy);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
    };
    ctx.strokeStyle = this.colors.accent;
    ctx.fillStyle = this.colors.accent;
    ctx.lineWidth = 2;
    let n = 0;
    for (const id of ai.ids) {
      const item = scene.items.get(id);
      if (!item || item.element.parentId || ++n > 300) continue;
      const b = item.bounds;
      outline({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      ctx.globalAlpha = 0.07;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.stroke();
    }
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    for (const item of ai.deleted) {
      if (item.element.parentId) continue;
      outline(item.bounds);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /**
   * Нарисовать участок мира в отдельную канву (масштаб k пикселей на единицу мира), без сетки.
   * Для картинки, которую видит ИИ. Видимую канву не трогает.
   */
  exportRegion(
    scene: Scene,
    area: Bounds,
    k: number,
    colors: ThemeColors | null = null,
  ): HTMLCanvasElement | null {
    const w = Math.round((area.maxX - area.minX) * k);
    const h = Math.round((area.maxY - area.minY) * k);
    if (!(w >= 1 && h >= 1) || w > 8192 || h > 8192) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return null;
    const saved = {
      canvas: this.canvas,
      ctx: this.ctx,
      dpr: this.dpr,
      width: this.width,
      height: this.height,
      full: this.full,
      rects: this.rects,
      paintedCam: this.paintedCam,
      stretchFrom: this.stretchFrom,
      approx: this.approx,
      lastFullMs: this.lastFullMs,
      lastFullAt: this.lastFullAt,
      colors: this.colors,
    };
    if (colors) this.colors = colors;
    this.canvas = c;
    this.ctx = ctx;
    this.dpr = 1;
    this.width = w;
    this.height = h;
    this.full = true;
    this.rects = [];
    this.stretchFrom = null;
    this.noGrid = true;
    try {
      this.paint({ x: area.minX, y: area.minY, zoom: k, rotation: 0 }, scene, {});
    } finally {
      this.canvas = saved.canvas;
      this.ctx = saved.ctx;
      this.dpr = saved.dpr;
      this.width = saved.width;
      this.height = saved.height;
      this.full = saved.full;
      this.rects = saved.rects;
      this.paintedCam = saved.paintedCam;
      this.stretchFrom = saved.stretchFrom;
      this.approx = saved.approx;
      this.lastFullMs = saved.lastFullMs;
      this.lastFullAt = saved.lastFullAt;
      this.colors = saved.colors;
      this.noGrid = false;
    }
    return c;
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
    if (sel.rotatable === false) return;
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

  /** Фрейм: светлая подложка, тонкий край (1 пиксель экрана) и название над верхней стороной. */
  private drawFrame(el: FrameElement, zoom: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.frame;
    ctx.fillRect(el.x, el.y, el.w, el.h);
    ctx.strokeStyle = this.colors.frameLine;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(el.x, el.y, el.w, el.h);
    const size = el.style.size ?? 14;
    const band = frameTitleBand(el);
    if (size * zoom < 4) {
      // Название неразличимо — полоска на его месте (решение 0022).
      const name = el.props.name || 'Фрейм';
      textBars(
        ctx,
        [name],
        el.x,
        el.y - band / 2 - (size * LINE_HEIGHT) / 2,
        size,
        this.colors.ink,
        zoom,
        el.w,
      );
      return;
    }
    ctx.font = `500 ${size}px ${NOTE_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.colors.ink;
    ctx.globalAlpha = 0.62;
    // Длинное название обрезаем по ширине фрейма.
    let name = el.props.name || 'Фрейм';
    const max = el.w;
    if (ctx.measureText(name).width > max) {
      while (name.length > 1 && ctx.measureText(name + '…').width > max) name = name.slice(0, -1);
      name += '…';
    }
    ctx.fillText(name, el.x, el.y - band / 2);
    ctx.globalAlpha = 1;
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
    const kind = el.props.shape;
    if (kind === 'ellipse') {
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
    } else if (kind === 'rect') {
      ctx.roundRect(el.x, el.y, el.w, el.h, Math.min(size * 2, el.w / 2, el.h / 2));
    } else if (kind === 'roundRect') {
      ctx.roundRect(el.x, el.y, el.w, el.h, Math.min(el.w, el.h) * ROUND_RECT_RADIUS);
    } else if (kind === 'line') {
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x + el.w, el.y + el.h);
    } else {
      const pts = shapePolygon(kind, el.x, el.y, el.w, el.h);
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.closePath();
    }
    // Заливка (решение 0022) — под контуром.
    if (el.style.fill && kind !== 'line') {
      ctx.fillStyle = el.style.fill;
      ctx.fill();
    }
    ctx.stroke();
  }

  /** Строки и высота текста стикера или заметки при данной ширине (для подгонки рамки). */
  measureNote(el: CanvasElement, content: string): { lines: string[]; height: number } {
    if (el.type === 'sticky') {
      const fit = this.fitSticky(content, el.w, el.h - taskBand(el));
      return { lines: fit.lines, height: el.h };
    }
    if (el.type === 'text' && el.props.fit) {
      return { lines: this.fitText(content, el.w, el.h).lines, height: el.h };
    }
    const size = fontSizeOf(el);
    const measure = this.measurer(400);
    const lines = wrapText(scaled(measure, size), content, el.w);
    return { lines, height: lines.length * size * LINE_HEIGHT };
  }

  /**
   * Надпись в рамке (решение 0022): самый крупный шрифт, при котором текст целиком помещается
   * в рамку (слова не рвутся); пустая — шрифт по высоте одной строки.
   */
  fitText(content: string, w: number, h: number): StickyFit {
    const measure = this.measurer(400);
    const max = Math.max(1, h / LINE_HEIGHT);
    const text = content.trim() ? content : '';
    if (!text) return { size: Math.min(max, TEXT_FONT_SIZE * 4), lines: [], pad: 0 };
    const words = text.split(/\s+/).filter(Boolean);
    const widest = Math.max(...words.map((wd) => measure(wd)));
    const fits = (size: number): string[] | null => {
      if ((widest * size) / 100 > w) return null;
      const lines = wrapText(scaled(measure, size), text, w);
      return lines.length * size * LINE_HEIGHT <= h ? lines : null;
    };
    const min = 0.5;
    let lo = min;
    let hi = max;
    let best = fits(lo);
    if (!best) return { size: min, lines: wrapText(scaled(measure, min), text, w), pad: 0 };
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const lines = fits(mid);
      if (lines) {
        lo = mid;
        best = lines;
      } else {
        hi = mid;
      }
    }
    return { size: lo, lines: best, pad: 0 };
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

  /** Ширина самой длинной строки текста шрифтом size (мировые единицы). */
  textWidth(content: string, size: number): number {
    const measure = this.measurer(400);
    return Math.max(0, ...content.split('\n').map((l) => (measure(l) * size) / 100));
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
    const band = taskBand(el);
    if (sticky) {
      const key = `${el.w}|${el.h}|${band}|${el.props.content}`;
      if (item.fit?.key !== key)
        item.fit = { key, ...this.fitSticky(el.props.content, el.w, el.h - band) };
      ({ size, pad, lines } = item.fit);
    } else if (el.props.fit) {
      const key = `${el.w}|${el.h}|${el.props.content}`;
      if (item.fit?.key !== key) item.fit = { key, ...this.fitText(el.props.content, el.w, el.h) };
      ({ size, pad, lines } = item.fit);
    } else {
      size = fontSizeOf(el);
      pad = 0;
      item.lines ??= wrapText(scaled(this.measurer(400), size), el.props.content, el.w);
      lines = item.lines;
    }
    if (el.type === 'sticky' && el.props.task && band * zoom >= 6) this.drawTaskBand(el, band);
    if (lines.length === 0) return;
    const lh0 = size * LINE_HEIGHT;
    const top0 = sticky ? el.y + (el.h - band - lines.length * lh0) / 2 : el.y;
    if (size * zoom < 3) {
      // Текст неразличим — серые полоски строк (решение 0022): видно, что здесь написано.
      textBars(
        ctx,
        lines,
        el.x + pad,
        top0,
        size,
        sticky ? STICKY_INK : (item.color ?? this.colors.ink),
        zoom,
      );
      return;
    }
    const done = el.type === 'sticky' && el.props.task?.status === 'done';
    if (done) ctx.globalAlpha = 0.5;
    ctx.font = `${sticky ? 500 : 400} ${size}px ${NOTE_FONT}`;
    // Середина строки — как в поле ввода (CSS делит межстрочный интервал поровну сверху и снизу).
    ctx.textBaseline = 'middle';
    ctx.fillStyle = sticky ? STICKY_INK : (item.color ?? this.colors.ink);
    const lh = size * LINE_HEIGHT;
    // Стикер: блок текста — по центру по вертикали.
    const top = sticky ? el.y + (el.h - band - lines.length * lh) / 2 : el.y;
    lines.forEach((line, i) => ctx.fillText(line, el.x + pad, top + (i + 0.5) * lh));
    if (done) ctx.globalAlpha = 1;
  }

  /** Полоса задачи: значок статуса, срок (просроченный — красным), «!» у важной. */
  private drawTaskBand(el: CanvasElement & { type: 'sticky' }, band: number): void {
    const t = el.props.task!;
    const ctx = this.ctx;
    const pad = stickyPad(el.w);
    const cy = el.y + el.h - band / 2 - pad * 0.25;
    const r = band * 0.24;
    const cx = el.x + pad + r;
    ctx.lineWidth = r * 0.28;
    ctx.strokeStyle = t.status === 'done' ? TASK_DONE : STICKY_INK;
    ctx.globalAlpha = t.status === 'done' ? 1 : 0.7;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (t.status === 'done') {
      ctx.fillStyle = TASK_DONE;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy);
      ctx.lineTo(cx - r * 0.1, cy + r * 0.42);
      ctx.lineTo(cx + r * 0.55, cy - r * 0.4);
      ctx.stroke();
    } else {
      ctx.stroke();
      if (t.status === 'doing') {
        // Наполовину закрашенный кружок — «в работе».
        ctx.fillStyle = STICKY_INK;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const size = band * 0.42;
    ctx.font = `500 ${size}px ${NOTE_FONT}`;
    ctx.textBaseline = 'middle';
    let x = cx + r * 2;
    const status = t.status === 'done' ? 'Готово' : t.status === 'doing' ? 'В работе' : 'Сделать';
    const today = this.today();
    const overdue = t.status !== 'done' && !!t.due && t.due < today;
    const label = t.due ? `${status} · ${shortDue(t.due, today)}` : status;
    ctx.fillStyle = overdue ? TASK_RED : STICKY_INK;
    ctx.globalAlpha = overdue ? 1 : 0.72;
    ctx.fillText(label, x, cy);
    x += ctx.measureText(label).width;
    ctx.globalAlpha = 1;
    if (t.high) {
      ctx.fillStyle = TASK_RED;
      ctx.font = `700 ${size * 1.1}px ${NOTE_FONT}`;
      ctx.fillText('!', el.x + el.w - pad - size * 0.4, cy);
    }
  }

  /** Сегодня (YYYY-MM-DD, местное время) — пересчитывается раз в минуту, а не на каждый стикер. */
  private todayCache = { at: 0, day: '' };
  private today(): string {
    const now = Date.now();
    if (now - this.todayCache.at > 60_000) {
      const d = new Date(now);
      const p = (n: number) => String(n).padStart(2, '0');
      this.todayCache = {
        at: now,
        day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      };
    }
    return this.todayCache.day;
  }

  /** Точки сетки в участке (x, y, w, h — пиксели устройства); квадратики по пиксельной сетке — чётче. */
  /** Фон доски (решение 0012). */
  background: BoardBackground = 'dots';

  private drawGrid(cam: Camera, x: number, y: number, w: number, h: number): void {
    if (this.noGrid || this.background === 'plain') return;
    if (this.background !== 'dots') {
      this.drawLines(cam, x, y, w, h, this.background === 'grid');
      return;
    }
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

  /** Линейка (горизонтальные линии) или клетка (и вертикальные) — линии по пиксельной сетке. */
  private drawLines(
    cam: Camera,
    x: number,
    y: number,
    w: number,
    h: number,
    vertical: boolean,
  ): void {
    const step = gridStepFor(cam.zoom);
    const k = this.dpr * cam.zoom;
    const ctx = this.ctx;
    const lw = Math.max(1, Math.round(this.dpr));
    ctx.strokeStyle = this.colors.dot;
    ctx.beginPath();
    if (cam.rotation) {
      const v = this.deviceToWorldBounds(cam, x, y, w, h);
      const j0 = Math.floor(v.minY / step);
      const j1 = Math.ceil(v.maxY / step);
      const i0 = Math.floor(v.minX / step);
      const i1 = Math.ceil(v.maxX / step);
      if (j1 - j0 + (vertical ? i1 - i0 : 0) > 4000) return;
      ctx.save();
      ctx.setTransform(...this.worldMatrix(cam));
      ctx.lineWidth = lw / k;
      for (let j = j0; j <= j1; j++) {
        ctx.moveTo(v.minX, j * step);
        ctx.lineTo(v.maxX, j * step);
      }
      if (vertical) {
        for (let i = i0; i <= i1; i++) {
          ctx.moveTo(i * step, v.minY);
          ctx.lineTo(i * step, v.maxY);
        }
      }
      // Сплошные линии заметнее точек — делаем их бледнее.
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }
    const px = step * k;
    const off = lw % 2 ? 0.5 : 0;
    ctx.lineWidth = lw;
    const j0 = Math.floor((y / k + cam.y) / step);
    const j1 = Math.ceil(((y + h) / k + cam.y) / step);
    if (j1 - j0 > 4000) return;
    for (let j = j0; j <= j1; j++) {
      const sy = Math.round(j * px - cam.y * k) + off;
      ctx.moveTo(x, sy);
      ctx.lineTo(x + w, sy);
    }
    if (vertical) {
      const i0 = Math.floor((x / k + cam.x) / step);
      const i1 = Math.ceil(((x + w) / k + cam.x) / step);
      for (let i = i0; i <= Math.min(i1, i0 + 4000); i++) {
        const sx = Math.round(i * px - cam.x * k) + off;
        ctx.moveTo(sx, y);
        ctx.lineTo(sx, y + h);
      }
    }
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/**
 * Камера, при которой нарисована картинка после сдвига на целое число пикселей:
 * экран сдвинут на (rx, ry) CSS-пикселей относительно cam.
 */
export function snappedCamera(cam: Camera, rx: number, ry: number): Camera {
  if (rx === 0 && ry === 0) return { ...cam };
  const w = screenToWorld(cam, rx, ry);
  return { ...cam, x: w.x, y: w.y };
}

/** Камеры совпадают с точностью до пикселя устройства (тот же масштаб и поворот). */
export function closeCamera(a: Camera, b: Camera, dpr: number): boolean {
  if (a.zoom !== b.zoom || (a.rotation ?? 0) !== (b.rotation ?? 0)) return false;
  const k = a.zoom * dpr;
  return Math.abs(a.x - b.x) * k <= 1 && Math.abs(a.y - b.y) * k <= 1;
}
