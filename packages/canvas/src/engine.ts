/**
 * Движок холста: связывает доску (Yjs), сцену, отрисовку, ввод пера и навигацию.
 * Интерфейс приложения (React) общается с ним через методы и подписку на состояние.
 */

import * as Y from 'yjs';
import {
  IDENTITY,
  addElement,
  addElements,
  cloneElements,
  deleteElement,
  deleteElements,
  elementsMap,
  getElement,
  isIdentity,
  makeArrow,
  makeImage,
  makeShape,
  makeSticky,
  makeStroke,
  makeText,
  STICKY_FONT_SIZE,
  STICKY_SIZE,
  TEXT_FONT_SIZE,
  FRAME_TITLE_SIZE,
  alignDeltas,
  makeFrame,
  reorder,
  rotateAbout,
  type AlignMode,
  scaleAbout,
  transformElement,
  type Transform,
} from '@kayospace/board';
import { PenInput, StrokeBuilder, type InkPoint, type PressurePoint } from '@kayospace/ink';
import {
  decodeStroke,
  type Actor,
  type CanvasElement,
  type StrokePoint,
  type StrokeTool,
} from '@kayospace/model';
import {
  defaultCamera,
  fitBounds,
  rotateAt,
  screenToWorld,
  setRotationAt,
  viewBounds,
  zoomAt,
  type Camera,
} from './camera';
import { eraseFromPoints } from './erase';
import { ImageCache } from './images';
import { boxFromDrag, insideBox, snapAngle } from './shapes';
import { Navigation } from './navigation';
import {
  EXPORT_COLORS,
  HANDLE_SIZE,
  Renderer,
  rotateHandleWorld,
  SELECTION_PAD,
  samplesWorldBounds,
  type ActiveStroke,
  type PaintOverlay,
  type Rect,
} from './renderer';
import {
  corners,
  handleAt,
  itemInLasso,
  itemInRect,
  rectFromPoints,
  scaleFromHandle,
  unionBounds,
  type Pt,
} from './selection';
import { HIGHLIGHTER_COLOR, PEN_KINDS, Scene, STROKE_STREAMLINE } from './scene';
import { isFrame, nextFrameName } from './frames';
import { buildPdf, type PdfPage } from './pdf';
import type { Bounds } from '@kayospace/ink';

export type Tool = 'select' | 'pen' | 'eraser' | 'hand' | 'sticky' | 'text' | 'shape' | 'frame';
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

/** Цвета стикеров — светлые, текст на них тёмный в любой теме. */
export const STICKY_COLORS = ['#ffe58a', '#ffc4d1', '#b8e3c9', '#bcd7ff', '#dccbff', '#ffd3a8'];

/** Origin транзакций с этого устройства: только их отменяет «Отменить». */
export const LOCAL_ORIGIN = 'kayospace:local';

export interface EngineState {
  tool: Tool;
  color: string | null;
  size: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize: number;
  shapeKind: ShapeKind;
  /** Вид пера: перо, маркер, выделитель. */
  penKind: StrokeTool;
  stickyColor: string;
  /** Выделен ровно один фрейм — его id (для переименования). */
  selectedFrame: string | null;
  /** В выделении есть фрейм: поворот выключен. */
  selectionHasFrame: boolean;
  /** id стикера или текста, который сейчас редактируют. */
  editing: string | null;
  /** Поворот вида, радианы. */
  rotation: number;
  /** Что выделено: только стикеры, только «чернила» (линии, фигуры, текст), смесь. */
  selectionKind: 'sticky' | 'ink' | 'mixed' | null;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  elements: number;
  touchDraws: boolean;
  /** Сколько элементов выделено. */
  selected: number;
  /** Счётчик изменений выделения и его рамки — чтобы интерфейс перерисовал меню. */
  selectionRev: number;
  /** Идёт перемещение, масштаб или выделение лассо. */
  transforming: boolean;
  /** Есть что вставить. */
  canPaste: boolean;
  /** Показан предпросмотр правок ИИ. */
  aiPreview: boolean;
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
  shapeKind?: ShapeKind;
  penKind?: StrokeTool;
  stickyColor?: string;
  /** Рисовать пальцем (иначе палец двигает холст). */
  touchDraws?: boolean;
  /** Поворачивать вид двумя пальцами. */
  rotateWithFingers?: boolean;
  /** Откуда грузить картинки по id содержимого. */
  assets?: AssetLoader;
}

/** Хранилище картинок приложения: локальная копия или хаб. */
export interface AssetLoader {
  load(assetId: string): Promise<Blob | null>;
}

interface ActiveDraw {
  builder: StrokeBuilder;
  points: StrokePoint[];
  predicted: PressurePoint[];
  kind: StrokeTool;
  color: string | null;
  size: number;
  unit: number;
  hasPressure: boolean;
  paintedUpTo: number;
  prevTail: Rect | null;
}

type SelectGesture =
  | { kind: 'move'; start: Pt; t: Transform; moved: boolean; editOnTap?: string }
  | { kind: 'scale'; anchor: Pt; corner: Pt; t: Transform; moved: boolean }
  | { kind: 'rotate'; center: Pt; start: number; t: Transform; moved: boolean }
  | { kind: 'lasso'; points: Pt[] }
  | { kind: 'marquee'; start: Pt; end: Pt }
  | { kind: 'shape'; start: Pt; end: Pt }
  | { kind: 'frame'; start: Pt; end: Pt }
  | { kind: 'place'; start: Pt; moved: boolean };

/** Что экспортировать: выделение, фрейм или всю доску. */
export type ExportTarget = 'board' | 'selection' | { frame: string };

/** Буфер обмена — общий для всех досок в окне приложения. */
let clipboard: CanvasElement[] = [];
let clipboardText = '';

/** Правки ИИ: новые и изменённые элементы целиком и id удалённых. */
export interface AiDraft {
  elements: CanvasElement[];
  deleted: string[];
}

interface AiPreview {
  draft: AiDraft;
  doc: Y.Doc;
  scene: Scene;
  /** Тронутые ИИ элементы (подсветка) и удалённые (рисуем бледно из настоящей доски). */
  ids: Set<string>;
  rebuild: ReturnType<typeof setTimeout> | null;
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
  private readonly images: ImageCache;
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
  private gesture: SelectGesture | null = null;
  /** Shift зажат во время жеста (квадрат, угол 45°). */
  private gestureShift = false;
  private shapeKind: ShapeKind;
  private penKind: StrokeTool;
  private stickyColor: string;
  /** Редактируемый стикер или текст; новый ещё не в доске — появится, когда в нём будет текст. */
  private editing: { id: string; draft: CanvasElement | null } | null = null;
  /** Откуда взять набранный текст, если правку завершает сам холст (тап мимо, смена инструмента). */
  private editText: (() => string) | null = null;
  private readonly selection = new Set<string>();
  private selectionRev = 0;
  /** Последнее положение указателя над холстом (clientX/Y) — для вставки. */
  private pointer: Pt | null = null;
  private raf = 0;
  /** Предпросмотр черновика ИИ: копия доски с его правками, которую рисуем вместо доски. */
  private ai: AiPreview | null = null;
  private state: EngineState;
  private hasCamera: boolean;
  /** Время последней отрисовки, мс — для отладки и e2e-проверок. */
  lastPaintMs = 0;
  paints = 0;
  /** Камера сменилась после последнего кадра. */
  private cameraMoved = false;
  /** Таймер чистовой перерисовки после того, как вид перестал меняться. */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.shapeKind = opts.shapeKind ?? 'rect';
    this.penKind = opts.penKind ?? 'pen';
    this.stickyColor = opts.stickyColor ?? STICKY_COLORS[0]!;
    this.touchDraws = opts.touchDraws ?? false;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.style.overflow = 'hidden';
    host.style.userSelect = 'none';
    host.style.setProperty('-webkit-user-select', 'none');
    host.style.setProperty('-webkit-touch-callout', 'none');

    this.renderer = new Renderer(host);
    this.scene = new Scene(doc);
    this.images = new ImageCache(opts.assets ?? null, (assetId) => {
      // Картинка готова — перерисовать места, где она стоит.
      for (const item of this.scene.items.values()) {
        if (item.element.type === 'image' && item.element.props.assetId === assetId) {
          this.renderer.invalidateWorld(this.camera, item.bounds);
        }
      }
      this.schedule();
    });
    this.renderer.images = this.images;
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
    this.nav.rotateView = opts.rotateWithFingers ?? true;

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
          // Тап по холсту во время правки текста — сначала сохранить набранное.
          if (this.editing) this.finishEditing(null);
          this.undoManager.stopCapturing();
          const p = this.toWorld(info.point);
          if (this.tool === 'eraser' || info.eraser) {
            this.erase = { last: p, ringRect: null };
            this.eraseAt(p, p);
          } else if (this.tool === 'select') {
            this.selectStart(p, info.event, info.pointerType);
          } else if (this.tool === 'shape') {
            this.gestureShift = info.event.shiftKey;
            this.gesture = { kind: 'shape', start: p, end: p };
          } else if (this.tool === 'frame') {
            this.gestureShift = info.event.shiftKey;
            this.gesture = { kind: 'frame', start: p, end: p };
          } else if (this.tool === 'sticky' || this.tool === 'text') {
            this.gesture = { kind: 'place', start: p, moved: false };
          } else {
            this.startDraw(p, info.hasPressure);
          }
          this.schedule();
        },
        onMove: (points, predicted, event) => {
          this.gestureShift = event.shiftKey;
          if (this.draw) {
            for (const pt of points) {
              const w = this.toWorld(pt);
              this.draw.points.push(w);
              this.draw.builder.add(w);
            }
            this.draw.predicted = predicted.map((pt) => this.toWorld(pt));
            this.schedule();
          } else if (this.gesture) {
            for (const pt of points) this.selectMove(this.toWorld(pt));
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
        if (this.selection.size > 0) {
          // Выделенный элемент могли удалить или сдвинуть (в том числе с другого устройства).
          for (const id of this.selection) if (!this.scene.items.has(id)) this.selection.delete(id);
          this.selectionRev++;
          this.renderer.invalidateAll();
        }
        for (const b of dirty) this.renderer.invalidateWorld(this.camera, b);
        this.aiBoardChanged();
        this.schedule();
        this.emit();
      }),
    );
    const onStack = (): void => this.emit();
    this.undoManager.on('stack-item-added', onStack);
    this.undoManager.on('stack-item-popped', onStack);
    this.undoManager.on('stack-cleared', onStack);

    host.addEventListener('pointermove', this.onPointerTrack);
    host.addEventListener('pointerleave', this.onPointerLeave);
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
    if (this.editing) this.finishEditing(null);
    this.tool = tool;
    if (tool !== 'select') this.clearSelection();
    else this.renderer.invalidateAll();
    this.schedule();
    this.nav.handTool = tool === 'hand';
    this.updateCursor();
    this.emit();
  }

  setColor(color: string | null): void {
    // Есть выделение — перекрашиваем выделенные штрихи, инструмент не меняем.
    if (this.tool === 'select' && this.selection.size > 0) {
      this.recolorSelection(color);
      return;
    }
    this.color = color;
    if (this.tool !== 'pen' && this.tool !== 'text' && this.tool !== 'shape') this.setTool('pen');
    this.emit();
  }

  setSize(size: number): void {
    this.size = size;
    if (this.tool !== 'pen' && this.tool !== 'shape') this.setTool('pen');
    this.emit();
  }

  setShapeKind(kind: ShapeKind): void {
    this.shapeKind = kind;
    if (this.tool !== 'shape') this.setTool('shape');
    this.emit();
  }

  /** Вид пера: перо, маркер или выделитель. */
  setPenKind(kind: StrokeTool): void {
    this.penKind = kind;
    if (this.tool !== 'pen') this.setTool('pen');
    this.emit();
  }

  /** Цвет стикера: перекрашивает выделенные стикеры или задаёт цвет новых. */
  setStickyColor(color: string): void {
    if (this.tool === 'select' && this.selection.size > 0) {
      this.restyleSelection((el) => (el.type === 'sticky' ? { ...el.style, color } : null));
      return;
    }
    this.stickyColor = color;
    if (this.tool !== 'sticky') this.setTool('sticky');
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
    if (this.draw || this.erase || this.gesture) return;
    if (this.editing) this.finishEditing(null);
    this.undoManager.undo();
  }

  redo(): void {
    if (this.draw || this.erase || this.gesture) return;
    if (this.editing) this.finishEditing(null);
    this.undoManager.redo();
  }

  // ---------- Выделение ----------

  getSelection(): string[] {
    return [...this.selection];
  }

  /** Рамка выделения в мировых координатах (с учётом идущего жеста). */
  getSelectionBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const b = unionBounds(
      [...this.selection].flatMap((id) => {
        const item = this.scene.items.get(id);
        return item ? [item.bounds] : [];
      }),
    );
    return b;
  }

  select(ids: Iterable<string>): void {
    this.selection.clear();
    for (const id of ids) if (this.scene.items.has(id)) this.selection.add(id);
    if (this.selection.size > 0 && this.tool !== 'select') {
      this.tool = 'select';
      this.nav.handTool = false;
      this.updateCursor();
    }
    this.selectionChanged();
  }

  selectAll(): void {
    this.select([...this.scene.items.keys()].filter((id) => this.scene.ownerOf(id) === id));
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.selectionChanged();
  }

  deleteSelection(): void {
    if (this.selection.size === 0 || this.gesture) return;
    this.undoManager.stopCapturing();
    deleteElements(this.doc, [...this.withContents(this.selection)], LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
    this.clearSelection();
  }

  /**
   * Скопировать выделенное во внутренний буфер. Возвращает текст для системного буфера:
   * тексты стикеров и надписей (их можно вставить в другую программу) или подпись «Kayospace: …».
   * По этому тексту вставка понимает, что в системном буфере — наши элементы.
   */
  copySelection(): string | null {
    const els = this.selectedElements(true);
    if (els.length === 0) return null;
    clipboard = els.map((el) => structuredClone(el));
    const texts = els
      .map((el) => (el.type === 'sticky' || el.type === 'text' ? el.props.content.trim() : ''))
      .filter(Boolean);
    clipboardText = texts.length ? texts.join('\n\n') : `Kayospace: элементов — ${els.length}`;
    this.emit();
    return clipboardText;
  }

  /** Текст в системном буфере — это наши скопированные элементы? */
  isOwnClipboardText(text: string): boolean {
    return clipboard.length > 0 && text === clipboardText;
  }

  /** Вставить текст надписью: под указатель или в центр экрана. */
  insertText(text: string): string | null {
    const content = text.replace(/\r\n?/g, '\n').trim();
    if (!content) return null;
    const z = this.camera.zoom;
    const size = TEXT_FONT_SIZE / z;
    // Ширина — по самой длинной строке, но не шире 560 экранных пикселей.
    const probe = makeText(content, { x: 0, y: 0, w: 1e6, actor: this.opts.actor });
    const sized = { ...probe, style: { ...probe.style, size } };
    const w = Math.min(560 / z, Math.max(80 / z, this.renderer.textWidth(content, size) + 4 / z));
    const { height } = this.renderer.measureNote({ ...sized, w }, content);
    const r = this.host.getBoundingClientRect();
    const at = this.pointer
      ? screenToWorld(this.camera, this.pointer.x - r.left, this.pointer.y - r.top)
      : screenToWorld(this.camera, this.renderer.width / 2, this.renderer.height / 2);
    const el = {
      ...sized,
      ...this.viewBox(at, 0, 0, w, height),
      ...(this.color ? { style: { ...sized.style, color: this.color } } : {}),
    };
    this.insert([el]);
    return el.id;
  }

  cutSelection(): void {
    this.copySelection();
    this.deleteSelection();
  }

  /** Копия выделенного рядом с оригиналом. */
  duplicateSelection(): void {
    const els = this.selectedElements(true);
    if (els.length === 0 || this.gesture) return;
    const d = 24 / this.camera.zoom;
    this.insert(cloneElements(els, d, d, this.opts.actor));
  }

  /** Вставить из буфера: под указатель, если он над холстом, иначе в центр экрана. */
  paste(): void {
    if (clipboard.length === 0 || this.gesture) return;
    const b = unionBounds(
      clipboard.map((el) => ({ minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h })),
    )!;
    const r = this.host.getBoundingClientRect();
    const target = this.pointer
      ? screenToWorld(this.camera, this.pointer.x - r.left, this.pointer.y - r.top)
      : screenToWorld(this.camera, this.renderer.width / 2, this.renderer.height / 2);
    const dx = target.x - (b.minX + b.maxX) / 2;
    const dy = target.y - (b.minY + b.maxY) / 2;
    this.insert(cloneElements(clipboard, dx, dy, this.opts.actor));
  }

  /**
   * Вставить картинку: по центру экрана (или в точке экрана at), не больше 60% экрана.
   * blob — чтобы показать сразу, не дожидаясь загрузки из хранилища.
   */
  insertImage(
    assetId: string,
    natural: { w: number; h: number },
    opts: { blob?: Blob; at?: Pt; alt?: string } = {},
  ): string {
    const z = this.camera.zoom;
    const maxW = (this.renderer.width * 0.6) / z;
    const maxH = (this.renderer.height * 0.6) / z;
    // Не крупнее исходного размера в экранных пикселях — мелкая иконка не раздувается.
    const k = Math.min(maxW / natural.w, maxH / natural.h, 1 / z);
    const w = natural.w * k;
    const h = natural.h * k;
    const c = opts.at
      ? screenToWorld(this.camera, opts.at.x, opts.at.y)
      : screenToWorld(this.camera, this.renderer.width / 2, this.renderer.height / 2);
    // Вид повёрнут — картинка встаёт ровно относительно экрана.
    const rotation = -(this.camera.rotation ?? 0);
    const el = {
      ...makeImage(
        assetId,
        { x: c.x - w / 2, y: c.y - h / 2, w, h },
        {
          naturalW: natural.w,
          naturalH: natural.h,
          actor: this.opts.actor,
          ...(opts.alt ? { alt: opts.alt } : {}),
        },
      ),
      rotation,
    };
    if (opts.blob) void this.images.put(assetId, opts.blob);
    this.insert([el]);
    return el.id;
  }

  /** Сдвинуть выделенное на экранные пиксели (стрелки). */
  nudgeSelection(dx: number, dy: number): void {
    if (this.selection.size === 0 || this.gesture) return;
    this.commitTransform({ s: 1, tx: dx / this.camera.zoom, ty: dy / this.camera.zoom }, true);
  }

  // ---------- Порядок слоёв и выравнивание ----------

  /** Выделенное — поверх всего (front) или под всё (back). Фреймы остаются под элементами. */
  arrange(where: 'front' | 'back'): void {
    const els = this.selectedElements();
    if (els.length === 0 || this.gesture) return;
    const all = [...this.scene.items.values()].map((it) => it.element);
    const z = reorder(els, all, where);
    if (z.size === 0) return;
    const map = elementsMap(this.doc);
    const now = Date.now();
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const el of els) {
        const next = z.get(el.id);
        if (next) map.set(el.id, { ...el, z: next, updatedBy: this.opts.actor, updatedAt: now });
      }
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
  }

  /** Выровнять или распределить выделенное (по рамкам; рисунки на стикерах едут со стикером). */
  align(mode: AlignMode): void {
    if (this.selection.size < 2 || this.gesture) return;
    const boxes = [...this.selection].flatMap((id) => {
      const item = this.scene.items.get(id);
      return item ? [{ id, ...item.bounds }] : [];
    });
    const deltas = alignDeltas(boxes, mode);
    if (deltas.size === 0) return;
    const map = elementsMap(this.doc);
    const now = Date.now();
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const [id, d] of deltas) {
        // Фрейм едет вместе с содержимым.
        for (const eid of this.withContents([id])) {
          const el = getElement(this.doc, eid);
          if (el)
            map.set(eid, transformElement(el, { s: 1, tx: d.dx, ty: d.dy }, this.opts.actor, now));
        }
      }
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
  }

  // ---------- Фреймы ----------

  /** Фреймы доски — для списка и экспорта. */
  getFrames(): {
    id: string;
    name: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  }[] {
    return this.scene.frames();
  }

  /** Переименовать фрейм. */
  renameFrame(id: string, name: string): void {
    const el = getElement(this.doc, id);
    const n = name.trim();
    if (!isFrame(el) || !n || n === el.props.name) return;
    this.undoManager.stopCapturing();
    addElement(
      this.doc,
      { ...el, props: { ...el.props, name: n }, updatedBy: this.opts.actor, updatedAt: Date.now() },
      LOCAL_ORIGIN,
    );
    this.undoManager.stopCapturing();
  }

  /** Показать область (мировые координаты) целиком, с полями. */
  zoomToBounds(b: { minX: number; minY: number; maxX: number; maxY: number }): void {
    this.setCamera(
      fitBounds(b, this.renderer.width, this.renderer.height, 48, this.camera.rotation ?? 0),
    );
  }

  /** Перейти к фрейму и выделить его. */
  goToFrame(id: string): void {
    const f = this.scene.frames().find((fr) => fr.id === id);
    if (!f) return;
    this.zoomToBounds(f.bounds);
  }

  // ---------- ИИ: предпросмотр черновика ----------

  /**
   * Показать правки ИИ поверх доски, не меняя её: рисуем копию доски с этими правками,
   * тронутые элементы подсвечены, удалённые — бледные. null — убрать предпросмотр.
   */
  setAiPreview(draft: AiDraft | null): void {
    this.dropAiPreview();
    if (draft && (draft.elements.length > 0 || draft.deleted.length > 0)) {
      this.ai = this.buildAiPreview(draft);
      this.clearSelection();
      // Если правки за краем экрана — показать их вместе с видимой частью.
      const b = this.aiBounds();
      const v = this.visibleBounds();
      if (b && !(b.minX >= v.minX && b.maxX <= v.maxX && b.minY >= v.minY && b.maxY <= v.maxY)) {
        const all = {
          minX: Math.min(b.minX, v.minX),
          minY: Math.min(b.minY, v.minY),
          maxX: Math.max(b.maxX, v.maxX),
          maxY: Math.max(b.maxY, v.maxY),
        };
        const fit = fitBounds(
          all,
          this.renderer.width,
          this.renderer.height,
          48,
          this.camera.rotation ?? 0,
        );
        this.setCamera(fit.zoom > this.camera.zoom ? this.camera : fit);
      }
    }
    this.renderer.invalidateAll();
    this.schedule();
    this.emit();
  }

  /** Перенести правки ИИ в доску одним шагом (его можно отменить). Возвращает id новых и изменённых. */
  applyAiPreview(): string[] {
    const ai = this.ai;
    if (!ai) return [];
    const { elements, deleted } = ai.draft;
    this.setAiPreview(null);
    if (this.editing) this.finishEditing(null);
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const el of elements) addElement(this.doc, el);
      for (const id of deleted) deleteElement(this.doc, id);
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
    const ids = elements.map((el) => el.id).filter((id) => this.scene.ownerOf(id) === id);
    if (ids.length > 0) this.select(ids);
    return ids;
  }

  /** Рамка правок ИИ (мировые координаты). */
  private aiBounds() {
    const ai = this.ai;
    if (!ai) return null;
    return unionBounds(
      [...ai.ids].flatMap((id) => {
        const item = ai.scene.items.get(id) ?? this.scene.items.get(id);
        return item ? [item.bounds] : [];
      }),
    );
  }

  private buildAiPreview(draft: AiDraft): AiPreview {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.doc));
    doc.transact(() => {
      for (const el of draft.elements) addElement(doc, el);
      for (const id of draft.deleted) deleteElement(doc, id);
    });
    return {
      draft,
      doc,
      scene: new Scene(doc),
      ids: new Set([...draft.elements.map((el) => el.id), ...draft.deleted]),
      rebuild: null,
    };
  }

  /** Доска изменилась (в том числе с другого устройства) — пересобрать копию, не чаще раза в 300 мс. */
  private aiBoardChanged(): void {
    const ai = this.ai;
    if (!ai || ai.rebuild) return;
    ai.rebuild = setTimeout(() => {
      if (this.ai !== ai) return;
      const next = this.buildAiPreview(ai.draft);
      ai.rebuild = null;
      this.dropAiPreview();
      this.ai = next;
      this.renderer.invalidateAll();
      this.schedule();
    }, 300);
  }

  private dropAiPreview(): void {
    const ai = this.ai;
    if (!ai) return;
    if (ai.rebuild) clearTimeout(ai.rebuild);
    ai.scene.destroy();
    ai.doc.destroy();
    this.ai = null;
  }

  /**
   * Картинка выделенного (или видимой части доски) для ИИ: PNG, длинная сторона до maxSide пикселей.
   * Без сетки и рамок выделения — только содержимое.
   */
  exportImage(maxSide = 1600): Promise<Blob | null> {
    const b = this.getSelectionBounds() ?? this.visibleBounds();
    const pad = 16 / this.camera.zoom;
    const area = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
    const w = area.maxX - area.minX;
    const h = area.maxY - area.minY;
    if (!(w > 0 && h > 0)) return Promise.resolve(null);
    const k = Math.min(maxSide / Math.max(w, h), 3 * this.camera.zoom * (this.renderer.dpr || 1));
    const canvas = this.renderer.exportRegion(this.scene, area, k);
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  // ---------- Экспорт ----------

  /** Область экспорта: выделение, фрейм (без заголовка) или вся доска; null — нечего экспортировать. */
  exportArea(target: ExportTarget): Bounds | null {
    if (typeof target === 'object') {
      const el = this.scene.items.get(target.frame)?.element;
      return isFrame(el) ? { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h } : null;
    }
    const b = target === 'selection' ? this.getSelectionBounds() : this.scene.contentBounds();
    if (!b) return null;
    const pad = 32;
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  }

  /**
   * Нарисовать область для экспорта: светлая тема, без сетки и рамок выделения.
   * Чёткость — до 2 пикселей на единицу мира, но не больше 8192 по стороне и ~16 Мп всего.
   */
  async renderExport(area: Bounds, scale = 2): Promise<HTMLCanvasElement | null> {
    const w = area.maxX - area.minX;
    const h = area.maxY - area.minY;
    if (!(w > 0 && h > 0)) return null;
    const k = Math.min(scale, 8192 / Math.max(w, h), Math.sqrt(16_000_000 / (w * h)));
    // Картинки — дождаться загрузки, иначе в файле будут серые заглушки.
    const assets: string[] = [];
    for (const item of this.scene.query(area)) {
      if (item.element.type === 'image') assets.push(item.element.props.assetId);
    }
    await this.images.ready(assets);
    return this.renderer.exportRegion(this.scene, area, k, EXPORT_COLORS);
  }

  /** PNG выделения, фрейма или всей доски. */
  async exportPng(target: ExportTarget): Promise<Blob | null> {
    const area = this.exportArea(target);
    const canvas = area ? await this.renderExport(area) : null;
    if (!canvas) return null;
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  /** PDF: по странице на фрейм (сверху вниз, слева направо); фреймов нет — вся доска одной страницей. */
  async exportPdf(title: string): Promise<Uint8Array | null> {
    const frames = this.scene.frames();
    const areas = frames.length > 0 ? frames.map((f) => f.bounds) : [this.exportArea('board')];
    const pages: PdfPage[] = [];
    for (const area of areas) {
      if (!area) continue;
      const canvas = await this.renderExport(area);
      if (!canvas) continue;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) continue;
      pages.push({
        jpeg: new Uint8Array(await blob.arrayBuffer()),
        width: canvas.width,
        height: canvas.height,
        density: canvas.width / (area.maxX - area.minX),
      });
    }
    return pages.length > 0 ? buildPdf(pages, title) : null;
  }

  private insert(els: CanvasElement[]): void {
    this.undoManager.stopCapturing();
    addElements(this.doc, els, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
    this.select(els.map((el) => el.id));
  }

  /** Выделенные вместе с их рисунками (штрихами на стикерах). */
  private withChildren(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      out.add(id);
      for (const c of this.scene.childrenOf(id)) out.add(c);
    }
    return out;
  }

  /** Как withChildren, а у фреймов — ещё и всё, что лежит внутри (с вложенными фреймами). */
  private withContents(ids: Iterable<string>): Set<string> {
    const owners = new Set<string>();
    const visit = (id: string): void => {
      if (owners.has(id)) return;
      owners.add(id);
      if (isFrame(this.scene.items.get(id)?.element)) {
        for (const inner of this.scene.frameContents(id)) visit(inner);
      }
    };
    for (const id of ids) visit(id);
    return this.withChildren(owners);
  }

  private hasFrameSelected(): boolean {
    for (const id of this.selection) if (isFrame(this.scene.items.get(id)?.element)) return true;
    return false;
  }

  /** Элементы выделения; contents — с содержимым фреймов (перенос, копия, удаление). */
  private selectedElements(contents = false): CanvasElement[] {
    const ids = contents ? this.withContents(this.selection) : this.withChildren(this.selection);
    return [...ids].flatMap((id) => {
      const el = getElement(this.doc, id);
      return el ? [el] : [];
    });
  }

  /** Перекрасить «чернила» в выделении: линии, фигуры, стрелки, текст (стикеры — своей палитрой). */
  private recolorSelection(color: string | null): void {
    this.restyleSelection((el) => {
      if (el.type === 'sticky') return null;
      const style = { ...el.style };
      if (color) style.color = color;
      else delete style.color;
      return style;
    });
  }

  private restyleSelection(fn: (el: CanvasElement) => CanvasElement['style'] | null): void {
    const map = elementsMap(this.doc);
    const now = Date.now();
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const id of this.selection) {
        const el = getElement(this.doc, id);
        if (!el) continue;
        const style = fn(el);
        if (style) map.set(el.id, { ...el, style, updatedBy: this.opts.actor, updatedAt: now });
      }
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
  }

  // ---------- Стикеры и текст ----------

  /** Элемент, который сейчас редактируют (из доски или ещё не созданный). */
  getEditingElement(): CanvasElement | null {
    if (!this.editing) return null;
    return this.editing.draft ?? getElement(this.doc, this.editing.id) ?? null;
  }

  /** Поле ввода сообщает, как прочитать набранный текст. */
  setEditTextSource(fn: (() => string) | null): void {
    this.editText = fn;
  }

  startEditing(id: string): void {
    const el = getElement(this.doc, id);
    if (!el || (el.type !== 'sticky' && el.type !== 'text')) return;
    if (this.editing) this.finishEditing(null);
    this.editing = { id, draft: null };
    this.selection.clear();
    this.selection.add(id);
    this.selectionChanged();
  }

  /**
   * Закончить правку. text = null — оставить как есть. Пустой текст удаляет заметку.
   * Высота подгоняется под текст; у стикера — не меньше ширины.
   */
  finishEditing(text: string | null): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    if (text === null && this.editText) text = this.editText();
    const el = ed.draft ?? getElement(this.doc, ed.id);
    if (el && (el.type === 'sticky' || el.type === 'text') && text !== null) {
      const content = text.replace(/\s+$/u, '');
      if (!content.trim()) {
        if (!ed.draft) deleteElement(this.doc, el.id, LOCAL_ORIGIN);
        this.selection.delete(el.id);
      } else if (content !== el.props.content || ed.draft) {
        const { height } = this.renderer.measureNote(el, content);
        // Стикер не растёт: шрифт сам подбирается под его размер.
        const h = el.type === 'sticky' ? el.h : height;
        const next = {
          ...el,
          h,
          props: { ...el.props, content },
          updatedBy: this.opts.actor,
          updatedAt: Date.now(),
        } as CanvasElement;
        this.undoManager.stopCapturing();
        addElement(this.doc, next, LOCAL_ORIGIN);
        this.undoManager.stopCapturing();
        this.selection.clear();
        this.selection.add(next.id);
      }
    }
    this.selectionChanged();
  }

  /** Новый стикер или текст в точке (мировые координаты) — сразу в режиме правки. */
  private placeNote(kind: 'sticky' | 'text', p: Pt): void {
    const z = this.camera.zoom;
    const now = Date.now();
    const actor = this.opts.actor;
    let draft: CanvasElement;
    if (kind === 'sticky') {
      const s = STICKY_SIZE / z;
      draft = makeSticky('', { x: 0, y: 0, color: this.stickyColor, actor, now });
      draft = {
        ...draft,
        ...this.viewBox(p, 0, 0, s, s),
        style: { ...draft.style, size: STICKY_FONT_SIZE / z },
      };
    } else {
      const size = TEXT_FONT_SIZE / z;
      const w = 320 / z;
      const h = size * 1.3;
      draft = makeText('', {
        x: 0,
        y: 0,
        w,
        actor,
        now,
        ...(this.color ? { color: this.color } : {}),
      });
      // Тап — левый край первой строки.
      draft = {
        ...draft,
        ...this.viewBox(p, w / 2, -size * 0.65 + h / 2, w, h),
        style: { ...draft.style, size },
      };
    }
    if (this.editing) this.finishEditing(null);
    this.editing = { id: draft.id, draft };
    // После заметки — снова выделение, как в Miro: следующий тап не плодит пустые стикеры.
    this.tool = 'select';
    this.nav.handTool = false;
    this.updateCursor();
    this.selection.clear();
    this.selectionChanged();
  }

  /** Элемент, к которому можно привязать конец стрелки: стикер, текст или фигура под точкой. */
  private attachTarget(p: Pt): string | null {
    const items = this.scene.query({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      const t = it.element.type;
      if (t !== 'sticky' && t !== 'text' && t !== 'shape') continue;
      const b = it.bounds;
      if (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY) return it.id;
    }
    return null;
  }

  /** Фигура по жесту (мировые координаты). Тап без движения ставит фигуру стандартного размера. */
  private draftShape(g: { start: Pt; end: Pt }): CanvasElement | null {
    const z = this.camera.zoom;
    const actor = this.opts.actor;
    const size = this.size / z;
    const color = this.color ?? undefined;
    const tiny = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * z < 4;
    const opts = { size, actor, ...(color ? { color } : {}) };
    if (this.shapeKind === 'line' || this.shapeKind === 'arrow') {
      if (tiny) return null;
      const end = this.gestureShift ? snapAngle(g.start, g.end) : g.end;
      return makeArrow(g.start, end, {
        ...opts,
        heads: this.shapeKind === 'arrow' ? 'end' : 'none',
      });
    }
    // Рамку считаем в осях экрана: при повёрнутом виде фигура ровная относительно экрана.
    const r = this.camera.rotation ?? 0;
    let box: { x: number; y: number; w: number; h: number; rotation: number };
    if (tiny) {
      box = this.viewBox(g.start, 0, 0, 160 / z, 100 / z);
    } else {
      const c = Math.cos(r);
      const sn = Math.sin(r);
      const dx = g.end.x - g.start.x;
      const dy = g.end.y - g.start.y;
      const v = { x: dx * c - dy * sn, y: dx * sn + dy * c }; // смещение в осях экрана
      const b = boxFromDrag({ x: 0, y: 0 }, v, this.gestureShift);
      box = this.viewBox(g.start, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h);
    }
    const { rotation, ...rect } = box;
    return { ...makeShape(this.shapeKind, rect, opts), rotation };
  }

  /** Фрейм по жесту: протянули — по рамке, тап — 960 × 600 экранных пикселей с центром в точке. */
  private draftFrame(g: { start: Pt; end: Pt }): CanvasElement {
    const z = this.camera.zoom;
    const tiny = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * z < 8;
    let box: { x: number; y: number; w: number; h: number };
    if (tiny) {
      const w = 960 / z;
      const h = 600 / z;
      box = { x: g.start.x - w / 2, y: g.start.y - h / 2, w, h };
    } else {
      const b = boxFromDrag(g.start, g.end, this.gestureShift);
      box = { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    const names = this.scene.frames().map((f) => f.name);
    return makeFrame(nextFrameName(names), box, {
      actor: this.opts.actor,
      titleSize: FRAME_TITLE_SIZE / z,
    });
  }

  /**
   * Рамка, ровная относительно экрана: центр — в точке anchor плюс смещение (ox, oy) в осях экрана
   * (мировые единицы), размер w × h. При повёрнутом виде элемент получает обратный поворот.
   */
  private viewBox(
    anchor: Pt,
    ox: number,
    oy: number,
    w: number,
    h: number,
  ): { x: number; y: number; w: number; h: number; rotation: number } {
    const r = this.camera.rotation ?? 0;
    const c = Math.cos(-r);
    const s = Math.sin(-r);
    const cx = anchor.x + ox * c - oy * s;
    const cy = anchor.y + ox * s + oy * c;
    return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: r ? -r : 0 };
  }

  /** Применить преобразование к выделению; contents — вместе с содержимым фреймов (перенос). */
  private commitTransform(t: Transform, contents = false): void {
    if (isIdentity(t)) return;
    const map = elementsMap(this.doc);
    const now = Date.now();
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const el of this.selectedElements(contents)) {
        map.set(el.id, transformElement(el, t, this.opts.actor, now));
      }
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing();
  }

  private selectionKind(): EngineState['selectionKind'] {
    let sticky = false;
    let ink = false;
    for (const id of this.selection) {
      const type = this.scene.items.get(id)?.element.type;
      if (type === 'sticky') sticky = true;
      else if (type !== 'frame') ink = true;
    }
    return sticky && ink ? 'mixed' : sticky ? 'sticky' : ink ? 'ink' : null;
  }

  private selectionChanged(): void {
    this.selectionRev++;
    this.renderer.invalidateAll();
    this.schedule();
    this.emit();
  }

  private selectStart(p: Pt, e: PointerEvent, pointerType: string): void {
    const z = this.camera.zoom;
    const additive = e.shiftKey;
    const b = this.getSelectionBounds();
    if (b && !additive) {
      const grabR = (pointerType === 'mouse' ? HANDLE_SIZE : HANDLE_SIZE * 1.8) / z;
      const [, rot] = rotateHandleWorld(b, z);
      if (!this.hasFrameSelected() && Math.hypot(p.x - rot.x, p.y - rot.y) <= grabR) {
        const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
        const start = Math.atan2(p.y - center.y, p.x - center.x);
        this.gesture = { kind: 'rotate', center, start, t: IDENTITY, moved: false };
        this.selectionChanged();
        return;
      }
      const pad = SELECTION_PAD / z;
      const padded = {
        minX: b.minX - pad,
        minY: b.minY - pad,
        maxX: b.maxX + pad,
        maxY: b.maxY + pad,
      };
      // Пальцем и пером попасть в ручку труднее, чем мышью.
      const grab = (pointerType === 'mouse' ? HANDLE_SIZE : HANDLE_SIZE * 1.8) / z;
      const h = handleAt(padded, p.x, p.y, grab);
      if (h >= 0) {
        // Неподвижен противоположный угол самих элементов (без отступа рамки);
        // масштаб считаем от точки, где схватили ручку, — в начале он ровно 1.
        const anchor = corners(b)[(h + 2) % 4]!;
        this.gesture = { kind: 'scale', anchor, corner: p, t: IDENTITY, moved: false };
        this.selectionChanged();
        return;
      }
      if (p.x >= padded.minX && p.x <= padded.maxX && p.y >= padded.minY && p.y <= padded.maxY) {
        const only = this.selection.size === 1 ? [...this.selection][0]! : null;
        const t = only ? this.scene.items.get(only)?.element.type : undefined;
        this.gesture = {
          kind: 'move',
          start: p,
          t: IDENTITY,
          moved: false,
          ...(only && (t === 'sticky' || t === 'text') ? { editOnTap: only } : {}),
        };
        this.selectionChanged();
        return;
      }
    }
    const hit = this.scene.pick(p.x, p.y, (pointerType === 'mouse' ? 6 : 10) / z);
    if (hit) {
      const t = this.scene.items.get(hit)?.element.type;
      // Повторный тап по уже выбранному стикеру или тексту — правка.
      const editOnTap =
        !additive &&
        this.selection.size === 1 &&
        this.selection.has(hit) &&
        (t === 'sticky' || t === 'text')
          ? hit
          : undefined;
      if (additive && this.selection.has(hit)) {
        this.selection.delete(hit);
      } else {
        if (!additive && !this.selection.has(hit)) this.selection.clear();
        this.selection.add(hit);
        this.gesture = {
          kind: 'move',
          start: p,
          t: IDENTITY,
          moved: false,
          ...(editOnTap ? { editOnTap } : {}),
        };
      }
      this.selectionChanged();
      return;
    }
    if (!additive) this.selection.clear();
    this.gesture =
      pointerType === 'mouse'
        ? { kind: 'marquee', start: p, end: p }
        : { kind: 'lasso', points: [p] };
    this.selectionChanged();
  }

  private selectMove(p: Pt): void {
    const g = this.gesture;
    if (!g) return;
    const z = this.camera.zoom;
    if (g.kind === 'move') {
      const tx = p.x - g.start.x;
      const ty = p.y - g.start.y;
      if (!g.moved && Math.hypot(tx, ty) * z < 3) return; // дрожь руки — ещё не перетаскивание
      g.moved = true;
      g.t = { s: 1, tx, ty };
    } else if (g.kind === 'rotate') {
      let a = Math.atan2(p.y - g.center.y, p.x - g.center.x) - g.start;
      const step = Math.PI / 12; // 15°
      if (this.gestureShift) a = Math.round(a / step) * step;
      else {
        // Мягкая привязка к прямым углам — чтобы легко вернуть ровно.
        const right = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(a - right) < (4 * Math.PI) / 180) a = right;
      }
      g.moved = true;
      g.t = rotateAbout(g.center.x, g.center.y, a);
    } else if (g.kind === 'scale') {
      g.moved = true;
      g.t = scaleAbout(g.anchor.x, g.anchor.y, scaleFromHandle(g.anchor, g.corner, p));
    } else if (g.kind === 'shape' || g.kind === 'frame') {
      g.end = p;
    } else if (g.kind === 'place') {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) * z > 8) g.moved = true;
      return;
    } else if (g.kind === 'lasso') {
      const last = g.points[g.points.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) * z < 2) return;
      g.points.push(p);
    } else {
      g.end = p;
    }
    this.renderer.invalidateAll();
    this.schedule();
  }

  private selectEnd(cancel: boolean): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (!cancel) {
      if ((g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate') && g.moved) {
        // Перенос фрейма везёт содержимое; размер фрейма меняется без него.
        this.commitTransform(g.t, g.kind === 'move');
      } else if (g.kind === 'move' && g.editOnTap) {
        this.startEditing(g.editOnTap);
        return;
      } else if (g.kind === 'shape') {
        let el = this.draftShape(g);
        if (el?.type === 'arrow') {
          // Конец на стикере, тексте или фигуре — стрелка привязывается и потом тянется за ними.
          const from = this.attachTarget(g.start);
          const to = this.attachTarget(g.end);
          el = {
            ...el,
            props: {
              ...el.props,
              ...(from && from !== to ? { start: { kind: 'element' as const, id: from } } : {}),
              ...(to && to !== from ? { end: { kind: 'element' as const, id: to } } : {}),
            },
          };
        }
        if (el) addElement(this.doc, el, LOCAL_ORIGIN);
      } else if (g.kind === 'frame') {
        const frame = this.draftFrame(g);
        addElement(this.doc, frame, LOCAL_ORIGIN);
        this.undoManager.stopCapturing();
        // Дальше — выделение: фрейм выбран, его можно сразу переименовать.
        this.tool = 'select';
        this.nav.handTool = false;
        this.updateCursor();
        this.selection.clear();
        this.selection.add(frame.id);
      } else if (g.kind === 'place' && !g.moved) {
        const kind = this.tool === 'text' ? 'text' : 'sticky';
        const z = this.camera.zoom;
        // Тап по существующей заметке — правка, по пустому месту — новая.
        const hit = this.scene.pick(g.start.x, g.start.y, 4 / z);
        const t = hit ? this.scene.items.get(hit)?.element.type : undefined;
        if (hit && (t === 'sticky' || t === 'text')) this.startEditing(hit);
        else this.placeNote(kind, g.start);
        return;
      } else if (g.kind === 'lasso' && g.points.length >= 3) {
        const area = unionBounds(
          g.points.map((q) => ({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y })),
        )!;
        for (const item of this.scene.query(area)) {
          if (itemInLasso(item, g.points)) this.selection.add(this.scene.ownerOf(item.id));
        }
      } else if (g.kind === 'marquee') {
        const r = rectFromPoints(g.start, g.end);
        if ((r.maxX - r.minX) * this.camera.zoom > 3 || (r.maxY - r.minY) * this.camera.zoom > 3) {
          for (const item of this.scene.query(r)) {
            if (itemInRect(item, r)) this.selection.add(this.scene.ownerOf(item.id));
          }
        }
      }
    }
    this.selectionChanged();
  }

  // ---------- Камера ----------

  setCamera(c: Camera): void {
    if (
      c.x === this.camera.x &&
      c.y === this.camera.y &&
      c.zoom === this.camera.zoom &&
      (c.rotation ?? 0) === (this.camera.rotation ?? 0)
    ) {
      return;
    }
    if (!Number.isFinite(c.x + c.y + c.zoom)) return;
    const zoomChanged =
      c.zoom !== this.camera.zoom || (c.rotation ?? 0) !== (this.camera.rotation ?? 0);
    this.camera = c;
    this.hasCamera = true;
    // Картинку переносит кадр (renderer.moveTo): сдвиг — без перерисовки всего экрана.
    this.cameraMoved = true;
    this.schedule();
    for (const cb of [...this.cameraListeners]) cb(c);
    if (zoomChanged) this.emit();
  }

  /** Поставить мировую точку в центр экрана (масштаб и поворот — прежние). */
  centerOn(p: Pt): void {
    const c = screenToWorld(this.camera, this.renderer.width / 2, this.renderer.height / 2);
    this.setCamera({ ...this.camera, x: this.camera.x + p.x - c.x, y: this.camera.y + p.y - c.y });
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
    this.setCamera(
      fitBounds(b, this.renderer.width, this.renderer.height, 48, this.camera.rotation ?? 0),
    );
  }

  /** Вернуть вид без поворота (вокруг центра экрана). */
  resetRotation(): void {
    this.setCamera(
      setRotationAt(this.camera, this.renderer.width / 2, this.renderer.height / 2, 0),
    );
  }

  /** Повернуть вид на угол (радианы) вокруг центра экрана. */
  rotateView(da: number): void {
    this.setCamera(rotateAt(this.camera, this.renderer.width / 2, this.renderer.height / 2, da));
  }

  setRotateWithFingers(on: boolean): void {
    this.nav.rotateView = on;
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
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.input.destroy();
    this.nav.destroy();
    this.resizeObserver.disconnect();
    for (const fn of this.cleanups) fn();
    this.undoManager.destroy();
    this.dropAiPreview();
    this.scene.destroy();
    this.images.destroy();
    this.host.removeEventListener('pointermove', this.onPointerTrack);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
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
    const kind = this.penKind;
    const spec = PEN_KINDS[kind];
    const size = this.size * spec.scale * unit;
    const builder = new StrokeBuilder({
      color: '',
      size,
      thinning: spec.thinning,
      streamline: STROKE_STREAMLINE,
      simulatePressure: kind === 'pen' ? !hasPressure : false,
      unit,
    });
    builder.add(p);
    this.draw = {
      builder,
      points: [p],
      predicted: [],
      kind,
      // Выделитель без выбранного цвета — жёлтый: полупрозрачные «чернила» выглядели бы серыми.
      color: kind === 'highlighter' ? (this.color ?? HIGHLIGHTER_COLOR) : this.color,
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
        if (!el) continue;
        if (el.type === 'shape' || el.type === 'arrow') {
          deleteElement(this.doc, id); // фигуру ластик убирает целиком
          continue;
        }
        if (el.type !== 'stroke') continue;
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
            ...(el.parentId ? { parentId: el.parentId } : {}),
          });
        }
      }
    }, LOCAL_ORIGIN);
  }

  private endGesture(cancel: boolean): void {
    if (this.gesture) this.selectEnd(cancel);
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
          tool: d.kind,
          hasPressure: d.hasPressure,
          style: { size: d.size, ...(d.color ? { color: d.color } : {}) },
          actor: this.opts.actor,
          unit: d.unit,
        });
        // Нарисовали поверх стикера — рисунок становится его частью.
        const parent = this.stickyUnder(d.points);
        addElement(this.doc, parent ? { ...el, parentId: parent } : el, LOCAL_ORIGIN);
      }
    }
    this.undoManager.stopCapturing();
    this.schedule();
  }

  /** Верхний стикер, внутри которого лежит большая часть точек штриха. */
  private stickyUnder(points: readonly StrokePoint[]): string | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const items = this.scene.query({ minX, minY, maxX, maxY });
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.element.type !== 'sticky') continue;
      let inside = 0;
      for (const p of points) if (insideBox(it.element, p.x, p.y)) inside++;
      if (inside >= points.length * 0.7) return it.id;
    }
    return null;
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
        active = { samples: b.samples, tail, color: d.color, alpha: PEN_KINDS[d.kind].alpha };
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
      if (this.cameraMoved) {
        this.cameraMoved = false;
        // Тяжёлая доска (полная перерисовка дольше 12 мс): при зуме растягиваем готовую картинку,
        // а чисто перерисовываем реже — не чаще раза в 120 мс и так, чтобы на чистовую уходило
        // не больше четверти времени (на медленном устройстве перерисовка сама длится долго), —
        // и когда зум остановится.
        const r = this.renderer;
        const heavy = r.lastFullMs > 12;
        const due = performance.now() - r.lastFullAt > Math.max(120, r.lastFullMs * 3);
        r.moveTo(this.camera, heavy && !due && !this.draw && !this.gesture);
        this.settleSoon();
      }
      if (this.renderer.needsPaint) {
        const overlay: PaintOverlay = { active, ring, editing: this.editing?.id ?? null };
        const g = this.gesture;
        if (g?.kind === 'shape') overlay.draft = this.draftShape(g);
        if (g?.kind === 'frame') overlay.draft = this.draftFrame(g);
        if (this.selection.size > 0) {
          const bounds = this.getSelectionBounds();
          if (bounds) {
            overlay.selection = {
              bounds,
              ids: this.selection,
              rotatable: !this.hasFrameSelected(),
              handles:
                this.tool === 'select' &&
                !this.editing &&
                (!g || g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate'),
            };
          }
        }
        if (g && (g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate') && g.moved) {
          overlay.preview = {
            ids:
              g.kind === 'move'
                ? this.withContents(this.selection)
                : this.withChildren(this.selection),
            t: g.t,
          };
        } else if (g?.kind === 'lasso') {
          overlay.lasso = g.points;
        } else if (g?.kind === 'marquee') {
          overlay.marquee = rectFromPoints(g.start, g.end);
        }
        const ai = this.ai;
        if (ai) {
          overlay.ai = {
            ids: ai.ids,
            deleted: ai.draft.deleted.flatMap((id) => {
              const item = this.scene.items.get(id);
              return item ? [item] : [];
            }),
          };
        }
        this.renderer.paint(this.camera, ai?.scene ?? this.scene, overlay);
        this.paints++;
      }
    } catch (err) {
      console.error('[kayospace] ошибка отрисовки', err);
      this.renderer.invalidateAll();
    } finally {
      this.lastPaintMs = performance.now() - t0;
    }
  };

  /** Картинка приблизительная (сдвиг на дробные пиксели, растяжение) — перерисовать начисто, когда вид устоится. */
  private settleSoon(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.renderer.approx) {
        this.renderer.invalidateAll();
        this.schedule();
      }
    }, 140);
  }

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
      frame: v('--canvas-frame', c.frame),
      frameLine: v('--canvas-frame-line', c.frameLine),
    };
  }

  private updateCursor(): void {
    let cursor = this.tool === 'select' ? 'default' : this.tool === 'text' ? 'text' : 'crosshair';
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
      shapeKind: this.shapeKind,
      penKind: this.penKind,
      stickyColor: this.stickyColor,
      selectedFrame: this.singleFrame(),
      selectionHasFrame: this.hasFrameSelected(),
      editing: this.editing?.id ?? null,
      rotation: this.camera.rotation ?? 0,
      selectionKind: this.selectionKind(),
      zoom: this.camera.zoom,
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo(),
      elements: this.scene.size,
      touchDraws: this.touchDraws,
      selected: this.selection.size,
      selectionRev: this.selectionRev,
      transforming: this.gesture !== null,
      canPaste: clipboard.length > 0,
      aiPreview: this.ai !== null,
    };
  }

  private singleFrame(): string | null {
    if (this.selection.size !== 1) return null;
    const id = [...this.selection][0]!;
    return isFrame(this.scene.items.get(id)?.element) ? id : null;
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
    if (mod && e.code === 'KeyA') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    // Ctrl/⌘ C, X, V — через события copy/cut/paste (их слушает приложение): так работает
    // системный буфер обмена — текст и картинки из других программ и обратно.
    if (mod && e.code === 'KeyD') {
      e.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (e.code === 'Delete' || e.code === 'Backspace') {
      if (this.selection.size === 0) return;
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (e.code === 'Escape') {
      this.clearSelection();
      return;
    }
    if (e.code === 'Enter' && this.selection.size === 1 && !mod) {
      const id = [...this.selection][0]!;
      const t = this.scene.items.get(id)?.element.type;
      if (t === 'sticky' || t === 'text') {
        e.preventDefault();
        this.startEditing(id);
        return;
      }
    }
    if (e.code.startsWith('Arrow') && this.selection.size > 0 && !mod) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        e.code
      ] ?? [0, 0];
      this.nudgeSelection(dir[0]! * step, dir[1]! * step);
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
      return;
    }
    // Ctrl/⌘ ] — на передний план, Ctrl/⌘ [ — на задний.
    if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft') && this.selection.size > 0) {
      e.preventDefault();
      this.arrange(e.code === 'BracketRight' ? 'front' : 'back');
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
    if (e.shiftKey && e.code === 'BracketLeft') this.rotateView(-Math.PI / 12);
    else if (e.shiftKey && e.code === 'BracketRight') this.rotateView(Math.PI / 12);
    else if (e.shiftKey && e.code === 'Backslash') this.resetRotation();
    else if (e.shiftKey && e.code === 'Digit1') this.zoomToFit();
    else if (e.shiftKey && e.code === 'Digit0') this.resetZoom();
    else if (e.shiftKey) return;
    else if (e.code === 'KeyV') this.setTool('select');
    else if (e.code === 'KeyN') this.setTool('sticky');
    else if (e.code === 'KeyT') this.setTool('text');
    else if (e.code === 'KeyF') this.setTool('frame');
    else if (e.code === 'KeyM') this.setPenKind('marker');
    else if (e.code === 'KeyI') this.setPenKind('highlighter');
    else if (e.code === 'KeyR') this.setShapeKind('rect');
    else if (e.code === 'KeyO') this.setShapeKind('ellipse');
    else if (e.code === 'KeyL') this.setShapeKind('line');
    else if (e.code === 'KeyA') this.setShapeKind('arrow');
    else if (e.code === 'KeyP' || e.code === 'KeyB') this.setPenKind('pen');
    else if (e.code === 'KeyE') this.setTool('eraser');
    else if (e.code === 'KeyH') this.setTool('hand');
  };

  private onPointerTrack = (e: PointerEvent): void => {
    // Только запоминаем: раскладку (getBoundingClientRect) читаем при вставке, не на каждом движении.
    this.pointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerLeave = (): void => {
    this.pointer = null;
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
