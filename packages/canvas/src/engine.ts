/**
 * Движок холста: связывает доску (Yjs), сцену, отрисовку, ввод пера и навигацию.
 * Интерфейс приложения (React) общается с ним через методы и подписку на состояние.
 */

import * as Y from 'yjs';
import { addElement, deleteElement, elementsMap, getElement, makeStroke } from '@kayospace/board';
import { PenInput, StrokeBuilder, type InkPoint, type PressurePoint } from '@kayospace/ink';
import { decodeStroke, type Actor, type StrokePoint } from '@kayospace/model';
import { defaultCamera, fitBounds, screenToWorld, viewBounds, zoomAt, type Camera } from './camera';
import { eraseFromPoints } from './erase';
import { Navigation } from './navigation';
import { Renderer, samplesWorldBounds, type ActiveStroke, type Rect } from './renderer';
import { Scene, STROKE_STREAMLINE, STROKE_THINNING } from './scene';

export type Tool = 'pen' | 'eraser' | 'hand';

/** Origin транзакций с этого устройства: только их отменяет «Отменить». */
export const LOCAL_ORIGIN = 'kayospace:local';

export interface EngineState {
  tool: Tool;
  color: string | null;
  size: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  elements: number;
  touchDraws: boolean;
}

export interface EngineOptions {
  actor: Actor;
  camera?: Camera | null;
  tool?: Tool;
  /** null — цвет чернил темы. */
  color?: string | null;
  /** Толщина пера в экранных пикселях. */
  size?: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize?: number;
  /** Рисовать пальцем (иначе палец двигает холст). */
  touchDraws?: boolean;
}

interface ActiveDraw {
  builder: StrokeBuilder;
  points: StrokePoint[];
  predicted: PressurePoint[];
  color: string | null;
  size: number;
  unit: number;
  hasPressure: boolean;
  paintedUpTo: number;
  prevTail: Rect | null;
}

interface ActiveErase {
  last: { x: number; y: number };
  /** Кольцо ластика на экране (пиксели устройства) — чтобы стереть его в следующем кадре. */
  ringRect: Rect | null;
}

export class CanvasEngine {
  readonly scene: Scene;
  readonly renderer: Renderer;
  readonly undoManager: Y.UndoManager;
  private readonly input: PenInput;
  private readonly nav: Navigation;
  private readonly resizeObserver: ResizeObserver;
  private readonly darkQuery: MediaQueryList | null;
  private readonly listeners = new Set<() => void>();
  private readonly cameraListeners = new Set<(c: Camera) => void>();
  private readonly cleanups: (() => void)[] = [];

  private camera: Camera;
  private tool: Tool;
  private color: string | null;
  private size: number;
  private eraserSize: number;
  private touchDraws: boolean;
  private draw: ActiveDraw | null = null;
  private erase: ActiveErase | null = null;
  private raf = 0;
  private state: EngineState;
  private hasCamera: boolean;
  /** Время последней отрисовки, мс — для отладки и e2e-проверок. */
  lastPaintMs = 0;
  paints = 0;

  constructor(
    readonly host: HTMLElement,
    readonly doc: Y.Doc,
    private readonly opts: EngineOptions,
  ) {
    this.camera = opts.camera ?? defaultCamera();
    this.hasCamera = Boolean(opts.camera);
    this.tool = opts.tool ?? 'pen';
    this.color = opts.color ?? null;
    this.size = opts.size ?? 3;
    this.eraserSize = opts.eraserSize ?? 28;
    this.touchDraws = opts.touchDraws ?? false;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.style.overflow = 'hidden';
    host.style.userSelect = 'none';
    host.style.setProperty('-webkit-user-select', 'none');
    host.style.setProperty('-webkit-touch-callout', 'none');

    this.renderer = new Renderer(host);
    this.scene = new Scene(doc);
    this.undoManager = new Y.UndoManager(elementsMap(doc), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      // Шаги отмены разделяем вручную — по жестам (stopCapturing).
      captureTimeout: 24 * 3600 * 1000,
    });

    this.nav = new Navigation(host, {
      getCamera: () => this.camera,
      setCamera: (c) => this.setCamera(c),
      drawingWith: () => this.input.drawingWith,
      onMultiTouch: () => this.input.cancel(),
      onPanChange: () => this.updateCursor(),
      onTap: (fingers) => {
        if (fingers === 2) this.undo();
        else if (fingers === 3) this.redo();
      },
    });
    this.nav.handTool = this.tool === 'hand';
    this.nav.touchPans = !this.touchDraws;

    this.input = new PenInput(
      host,
      {
        palm: 'all',
        usePredicted: true,
        useRawUpdate: false,
        accept: (e) => !this.nav.claims(e) && (e.pointerType === 'mouse' ? e.button === 0 : true),
      },
      {
        onStart: (info) => {
          this.undoManager.stopCapturing();
          const p = this.toWorld(info.point);
          if (this.tool === 'eraser' || info.eraser) {
            this.erase = { last: p, ringRect: null };
            this.eraseAt(p, p);
          } else {
            this.startDraw(p, info.hasPressure);
          }
          this.schedule();
        },
        onMove: (points, predicted) => {
          if (this.draw) {
            for (const pt of points) {
              const w = this.toWorld(pt);
              this.draw.points.push(w);
              this.draw.builder.add(w);
            }
            this.draw.predicted = predicted.map((pt) => this.toWorld(pt));
            this.schedule();
          } else if (this.erase) {
            for (const pt of points) {
              const w = this.toWorld(pt);
              this.eraseAt(this.erase.last, w);
              this.erase.last = w;
            }
            this.schedule();
          }
        },
        onEnd: () => this.endGesture(false),
        onCancel: () => this.endGesture(true),
      },
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    this.readTheme();
    this.darkQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onTheme = (): void => this.refreshTheme();
    this.darkQuery?.addEventListener('change', onTheme);
    this.cleanups.push(() => this.darkQuery?.removeEventListener('change', onTheme));

    this.cleanups.push(
      this.scene.onChange((dirty) => {
        for (const b of dirty) this.renderer.invalidateWorld(this.camera, b);
        this.schedule();
        this.emit();
      }),
    );
    const onStack = (): void => this.emit();
    this.undoManager.on('stack-item-added', onStack);
    this.undoManager.on('stack-item-popped', onStack);
    this.undoManager.on('stack-cleared', onStack);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.state = this.makeState();
    this.updateCursor();
    this.schedule();
  }

  // ---------- Состояние для интерфейса ----------

  getState(): EngineState {
    return this.state;
  }

  /** Подписка на изменения состояния (для useSyncExternalStore). */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onCamera(cb: (c: Camera) => void): () => void {
    this.cameraListeners.add(cb);
    return () => this.cameraListeners.delete(cb);
  }

  getCamera(): Camera {
    return this.camera;
  }

  setTool(tool: Tool): void {
    if (tool === this.tool) return;
    this.tool = tool;
    this.nav.handTool = tool === 'hand';
    this.updateCursor();
    this.emit();
  }

  setColor(color: string | null): void {
    this.color = color;
    if (this.tool !== 'pen') this.setTool('pen');
    this.emit();
  }

  setSize(size: number): void {
    this.size = size;
    if (this.tool !== 'pen') this.setTool('pen');
    this.emit();
  }

  setEraserSize(size: number): void {
    this.eraserSize = size;
    if (this.tool !== 'eraser') this.setTool('eraser');
    this.updateCursor();
    this.emit();
  }

  setTouchDraws(on: boolean): void {
    this.touchDraws = on;
    this.nav.touchPans = !on;
    this.emit();
  }

  undo(): void {
    if (this.draw || this.erase) return;
    this.undoManager.undo();
  }

  redo(): void {
    if (this.draw || this.erase) return;
    this.undoManager.redo();
  }

  // ---------- Камера ----------

  setCamera(c: Camera): void {
    if (c.x === this.camera.x && c.y === this.camera.y && c.zoom === this.camera.zoom) return;
    if (!Number.isFinite(c.x + c.y + c.zoom)) return;
    const zoomChanged = c.zoom !== this.camera.zoom;
    this.camera = c;
    this.hasCamera = true;
    this.renderer.invalidateAll();
    this.schedule();
    for (const cb of [...this.cameraListeners]) cb(c);
    if (zoomChanged) this.emit();
  }

  /** Масштабировать вокруг центра экрана. */
  zoomBy(factor: number): void {
    this.setCamera(zoomAt(this.camera, this.renderer.width / 2, this.renderer.height / 2, factor));
  }

  /** Масштаб 100% с тем же центром. */
  resetZoom(): void {
    this.zoomBy(1 / this.camera.zoom);
  }

  /** Показать всё содержимое доски (пустая доска — начало координат). */
  zoomToFit(): void {
    const b = this.scene.contentBounds();
    if (!b) {
      this.setCamera({ x: -this.renderer.width / 2, y: -this.renderer.height / 2, zoom: 1 });
      return;
    }
    this.setCamera(fitBounds(b, this.renderer.width, this.renderer.height));
  }

  /** Камера ещё не задана (новая доска без сохранённого вида). */
  get cameraIsDefault(): boolean {
    return !this.hasCamera;
  }

  visibleBounds() {
    return viewBounds(this.camera, this.renderer.width, this.renderer.height);
  }

  /** Перечитать цвета темы из CSS-переменных и перерисовать. */
  refreshTheme(): void {
    this.readTheme();
    this.renderer.invalidateAll();
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.input.destroy();
    this.nav.destroy();
    this.resizeObserver.disconnect();
    for (const fn of this.cleanups) fn();
    this.undoManager.destroy();
    this.scene.destroy();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.renderer.canvas.remove();
    this.listeners.clear();
    this.cameraListeners.clear();
  }

  // ---------- Рисование и ластик ----------

  private toWorld(p: InkPoint): StrokePoint {
    const w = screenToWorld(this.camera, p.x, p.y);
    return { x: w.x, y: w.y, p: p.p, tx: p.tx, ty: p.ty, t: p.t };
  }

  private startDraw(p: StrokePoint, hasPressure: boolean): void {
    const unit = 1 / this.camera.zoom;
    const size = this.size * unit;
    const builder = new StrokeBuilder({
      color: '',
      size,
      thinning: STROKE_THINNING,
      streamline: STROKE_STREAMLINE,
      simulatePressure: !hasPressure,
      unit,
    });
    builder.add(p);
    this.draw = {
      builder,
      points: [p],
      predicted: [],
      color: this.color,
      size,
      unit,
      hasPressure,
      paintedUpTo: 0,
      prevTail: null,
    };
  }

  /** Стереть часть штрихов под ластиком на отрезке from → to (мировые координаты). */
  private eraseAt(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const r = this.eraserSize / 2 / this.camera.zoom;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(len / (r / 2)));
    const ids = new Set<string>();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      for (const id of this.scene.hitTest(x, y, r)) ids.add(id);
    }
    if (ids.size === 0) return;
    const actor = this.opts.actor;
    this.doc.transact(() => {
      for (const id of ids) {
        const el = getElement(this.doc, id);
        if (!el || el.type !== 'stroke') continue;
        const points = decodeStroke(el.props.points).map((p) => ({
          ...p,
          x: p.x + el.x,
          y: p.y + el.y,
        }));
        // Задеваем не только осевую линию, но и край толстого штриха.
        const reach = r + (el.style.size ?? 4) / 4;
        const pieces = eraseFromPoints(points, from, to, reach, r / 4);
        if (!pieces) continue;
        deleteElement(this.doc, id);
        for (const piece of pieces) {
          const part = makeStroke(piece, {
            tool: el.props.tool,
            style: el.style,
            hasPressure: el.props.hasPressure,
            actor,
            ...(el.props.unit !== undefined ? { unit: el.props.unit } : {}),
          });
          // Кусок остаётся на том же слое и с тем же автором.
          addElement(this.doc, {
            ...part,
            z: el.z,
            createdBy: el.createdBy,
            createdAt: el.createdAt,
          });
        }
      }
    }, LOCAL_ORIGIN);
  }

  private endGesture(cancel: boolean): void {
    const d = this.draw;
    this.draw = null;
    if (this.erase) {
      this.renderer.invalidate(this.erase.ringRect);
      this.erase = null;
    }
    if (d) {
      this.renderer.invalidate(d.prevTail);
      const finished = d.builder.finish();
      this.renderer.invalidateWorld(this.camera, samplesWorldBounds(finished));
      if (!cancel && d.points.length > 0) {
        const el = makeStroke(d.points, {
          hasPressure: d.hasPressure,
          style: { size: d.size, ...(d.color ? { color: d.color } : {}) },
          actor: this.opts.actor,
          unit: d.unit,
        });
        addElement(this.doc, el, LOCAL_ORIGIN);
      }
    }
    this.undoManager.stopCapturing();
    this.schedule();
  }

  // ---------- Кадры ----------

  private schedule(): void {
    if (this.raf === 0) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    const t0 = performance.now();
    try {
      const d = this.draw;
      let active: ActiveStroke | null = null;
      if (d) {
        const b = d.builder;
        // Новые стабильные сэмплы (между кадрами их может прийти много) — их участок явно.
        if (b.samples.length > d.paintedUpTo) {
          this.renderer.invalidateWorld(
            this.camera,
            samplesWorldBounds(b.samples, Math.max(0, d.paintedUpTo - 1)),
          );
          d.paintedUpTo = b.samples.length;
        }
        const lastStable = b.samples[b.samples.length - 1];
        const fresh = b.tail(d.predicted);
        const tail = lastStable ? [lastStable, ...fresh] : fresh;
        const tailRect = this.renderer.worldRect(this.camera, samplesWorldBounds(tail));
        this.renderer.invalidate(d.prevTail);
        this.renderer.invalidate(tailRect);
        d.prevTail = tailRect;
        active = { samples: b.samples, tail, color: d.color };
      }
      let ring: { x: number; y: number; r: number } | null = null;
      const er = this.erase;
      if (er) {
        ring = { x: er.last.x, y: er.last.y, r: this.eraserSize / 2 / this.camera.zoom };
        const rect = this.renderer.worldRect(
          this.camera,
          {
            minX: ring.x - ring.r,
            minY: ring.y - ring.r,
            maxX: ring.x + ring.r,
            maxY: ring.y + ring.r,
          },
          4,
        );
        this.renderer.invalidate(er.ringRect);
        this.renderer.invalidate(rect);
        er.ringRect = rect;
      }
      if (this.renderer.needsPaint) {
        this.renderer.paint(this.camera, this.scene, active, ring);
        this.paints++;
      }
    } catch (err) {
      console.error('[kayospace] ошибка отрисовки', err);
      this.renderer.invalidateAll();
    } finally {
      this.lastPaintMs = performance.now() - t0;
    }
  };

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    // Новая доска без сохранённого вида: начало координат — в центре экрана.
    if (!this.hasCamera && r.width > 0) {
      this.camera = { x: -r.width / 2, y: -r.height / 2, zoom: 1 };
    }
    this.schedule();
  }

  private readTheme(): void {
    const cs = getComputedStyle(this.host);
    const v = (name: string, fallback: string): string =>
      cs.getPropertyValue(name).trim() || fallback;
    const c = this.renderer.colors;
    this.renderer.colors = {
      paper: v('--canvas-paper', c.paper),
      ink: v('--canvas-ink', c.ink),
      dot: v('--canvas-dot', c.dot),
      accent: v('--accent', c.accent),
    };
  }

  private updateCursor(): void {
    let cursor = 'crosshair';
    if (this.nav.isPanning) cursor = 'grabbing';
    else if (this.tool === 'hand' || this.nav.spaceDown) cursor = 'grab';
    else if (this.tool === 'eraser') cursor = eraserCursor(this.eraserSize);
    this.host.style.cursor = cursor;
  }

  private makeState(): EngineState {
    return {
      tool: this.tool,
      color: this.color,
      size: this.size,
      eraserSize: this.eraserSize,
      zoom: this.camera.zoom,
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo(),
      elements: this.scene.size,
      touchDraws: this.touchDraws,
    };
  }

  private emit(): void {
    const next = this.makeState();
    const prev = this.state;
    if (prev && (Object.keys(next) as (keyof EngineState)[]).every((k) => next[k] === prev[k])) {
      return;
    }
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }

  // ---------- Клавиатура ----------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    // e.code — физическая клавиша: сочетания работают и в русской раскладке.
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.nav.spaceDown) {
        this.nav.spaceDown = true;
        this.updateCursor();
      }
      return;
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
      e.preventDefault();
      this.zoomBy(1.25);
      return;
    }
    if (mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      this.zoomBy(0.8);
      return;
    }
    if (mod || e.altKey) return;
    if (e.shiftKey && e.code === 'Digit1') this.zoomToFit();
    else if (e.shiftKey && e.code === 'Digit0') this.resetZoom();
    else if (e.shiftKey) return;
    else if (e.code === 'KeyP' || e.code === 'KeyB') this.setTool('pen');
    else if (e.code === 'KeyE') this.setTool('eraser');
    else if (e.code === 'KeyH') this.setTool('hand');
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && this.nav.spaceDown) {
      this.nav.spaceDown = false;
      this.updateCursor();
    }
  };

  private onBlur = (): void => {
    if (this.nav.spaceDown) {
      this.nav.spaceDown = false;
      this.updateCursor();
    }
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Курсор ластика — кольцо его размера (браузеры не показывают курсоры больше 128 пикселей). */
function eraserCursor(size: number): string {
  const d = Math.max(8, Math.min(120, Math.round(size)));
  const c = d / 2 + 2;
  const w = d + 4;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}">` +
    `<circle cx="${c}" cy="${c}" r="${d / 2}" fill="none" stroke="white" stroke-width="3"/>` +
    `<circle cx="${c}" cy="${c}" r="${d / 2}" fill="none" stroke="black" stroke-width="1.2"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, cell`;
}
