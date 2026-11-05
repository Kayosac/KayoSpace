/**
 * Навигация по холсту: сдвиг и масштаб.
 *
 * - Трекпад: два пальца — сдвиг, щипок — масштаб (в Chrome/Edge приходит как wheel с ctrlKey,
 *   в Safari/WKWebView на macOS — как gesturestart/gesturechange).
 * - Мышь: колесо — сдвиг (Shift — по горизонтали), Ctrl/Cmd + колесо — масштаб;
 *   средняя кнопка, зажатый пробел или инструмент «рука» — перетаскивание.
 * - Сенсорный экран: один палец — сдвиг (если пальцем не рисуют), два — сдвиг и масштаб.
 *   Касания во время рисования пером и касания размером с ладонь игнорируются.
 */

import { normalizeAngle, panBy, rotateAt, setRotationAt, zoomAt, type Camera } from './camera';

export interface NavigationOptions {
  getCamera(): Camera;
  setCamera(c: Camera): void;
  /** Тип указателя, которым сейчас рисуют ('' — не рисуют). */
  drawingWith(): string;
  /** Начался жест двумя пальцами: штрих пальцем нужно отменить. */
  onMultiTouch?(): void;
  /** Начало и конец перетаскивания — для курсора. */
  onPanChange?(panning: boolean): void;
  /**
   * Короткое касание без движения: 2 пальца — отменить, 3 — повторить; один палец (когда палец
   * двигает холст) — с точкой касания (координаты элемента), например открыть карточку документа.
   */
  onTap?(fingers: number, at?: { x: number; y: number }): void;
}

/** Касание шире этого (CSS-пиксели) — скорее ладонь, чем палец. */
const PALM_SIZE = 30;
/** Ограничение шага колеса при масштабе: у мыши один щелчок = 100 и больше. */
const MAX_ZOOM_DELTA = 30;
const ZOOM_SPEED = 0.01;
/** Постоянная времени плавной прокрутки колесом мыши, мс. */
const SMOOTH_MS = 45;
/** Касание пальцами считается тапом, если короче этого (мс)… */
const TAP_MAX_MS = 350;
/** …и ни один палец не сдвинулся дальше этого (CSS-пиксели). */
const TAP_SLOP = 16;
/** Поворот вида начинается, только когда пальцы повернули больше этого: щипок не крутит холст случайно. */
const ROTATE_START = (12 * Math.PI) / 180;
/** У прямого угла вид «прилипает» к нему, если отпустить ближе этого. */
const ROTATE_SNAP = (6 * Math.PI) / 180;

interface TouchPoint {
  x: number;
  y: number;
}

interface WebKitGestureEvent extends UIEvent {
  scale: number;
  rotation?: number;
  clientX: number;
  clientY: number;
}

export class Navigation {
  /** Зажат пробел. */
  spaceDown = false;
  /** Выбран инструмент «рука». */
  handTool = false;
  /** Один палец двигает холст (иначе — рисует). */
  touchPans = true;
  /** Поворачивать вид двумя пальцами (и жестом трекпада в Safari). */
  rotateView = true;
  /** Накопленный за жест поворот пальцев и идёт ли уже поворот вида. */
  private twist = 0;
  private rotating = false;

  private readonly touches = new Map<number, TouchPoint>();
  private pinch: { cx: number; cy: number; d: number; a: number } | null = null;
  private pan: { id: number; x: number; y: number; touch: boolean } | null = null;
  private gestureScale = 1;
  private gestureRotation = 0;
  private rect: DOMRect;
  /** Текущий жест пальцами — кандидат в тап (двумя — отмена, тремя — повтор). */
  private tap: {
    start: number;
    fingers: number;
    camera: Camera;
    origin: Map<number, TouchPoint>;
    failed: boolean;
  } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly opts: NavigationOptions,
  ) {
    this.rect = el.getBoundingClientRect();
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
    el.addEventListener('gesturestart', this.onGestureStart as EventListener);
    el.addEventListener('gesturechange', this.onGestureChange as EventListener);
    el.addEventListener('gestureend', this.onGestureEnd);
  }

  /**
   * Заберёт ли навигация это нажатие. Перо спрашивает об этом до начала штриха.
   * Не зависит от порядка обработчиков: само касание e в учёт не идёт.
   */
  claims(e: PointerEvent): boolean {
    if (e.pointerType === 'mouse' && e.button === 1) return true;
    if (this.spaceDown || this.handTool) return true;
    if (e.pointerType === 'touch') {
      if (this.touchPans) return true;
      for (const id of this.touches.keys()) if (id !== e.pointerId) return true;
    }
    return false;
  }

  get isPanning(): boolean {
    return this.pan !== null || this.pinch !== null;
  }

  /** Сбросить жесты пальцами (например, коснулось перо — значит, это была ладонь). */
  cancelTouches(): void {
    const had = this.isPanning;
    this.tap = null;
    this.touches.clear();
    this.pinch = null;
    if (this.pan?.touch) this.pan = null;
    if (had && !this.isPanning) this.opts.onPanChange?.(false);
  }

  destroy(): void {
    if (this.smooth) cancelAnimationFrame(this.smooth.raf);
    this.smooth = null;
    const el = this.el;
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    el.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    el.removeEventListener('gesturechange', this.onGestureChange as EventListener);
    el.removeEventListener('gestureend', this.onGestureEnd);
  }

  private local(e: { clientX: number; clientY: number }): TouchPoint {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  private setPan(p: { id: number; x: number; y: number; touch: boolean } | null): void {
    const was = this.isPanning;
    this.pan = p;
    if (was !== this.isPanning) this.opts.onPanChange?.(this.isPanning);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.rect = this.el.getBoundingClientRect();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= this.rect.width;
      dy *= this.rect.height;
    }
    // Щелчок колеса мыши — большой рывок: его растягиваем на несколько кадров.
    // Трекпад шлёт мелкие частые шаги — их применяем сразу, без задержки.
    const notch = isWheelNotch(e);
    const cam = this.opts.getCamera();
    if (e.ctrlKey || e.metaKey) {
      const p = this.local(e);
      const d = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, dy));
      if (notch) this.smoothBy(0, 0, -d * ZOOM_SPEED, p);
      else this.opts.setCamera(zoomAt(cam, p.x, p.y, Math.exp(-d * ZOOM_SPEED)));
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    if (notch) this.smoothBy(dx, dy, 0, null);
    else this.opts.setCamera(panBy(cam, -dx, -dy));
  };

  /** Плавная прокрутка колесом: сколько ещё сдвинуть (CSS-пиксели) и приблизить (логарифм). */
  private smooth: {
    dx: number;
    dy: number;
    zoom: number;
    at: TouchPoint;
    last: number;
    raf: number;
  } | null = null;

  private smoothBy(dx: number, dy: number, zoom: number, at: TouchPoint | null): void {
    const s = (this.smooth ??= {
      dx: 0,
      dy: 0,
      zoom: 0,
      at: at ?? { x: 0, y: 0 },
      last: performance.now(),
      raf: requestAnimationFrame(this.stepSmooth),
    });
    s.dx += dx;
    s.dy += dy;
    s.zoom += zoom;
    if (at) s.at = at;
  }

  private stepSmooth = (now: number): void => {
    const s = this.smooth;
    if (!s) return;
    const dt = Math.max(1, Math.min(50, now - s.last));
    s.last = now;
    // Экспоненциальное приближение: за ~150 мс проходим почти весь путь.
    const f = 1 - Math.exp(-dt / SMOOTH_MS);
    const done = Math.abs(s.dx) < 0.5 && Math.abs(s.dy) < 0.5 && Math.abs(s.zoom) < 0.002;
    const k = done ? 1 : f;
    this.applySmooth(s.dx * k, s.dy * k, s.zoom * k);
    s.dx -= s.dx * k;
    s.dy -= s.dy * k;
    s.zoom -= s.zoom * k;
    if (done) this.smooth = null;
    else s.raf = requestAnimationFrame(this.stepSmooth);
  };

  private applySmooth(dx: number, dy: number, zoom: number): void {
    const s = this.smooth!;
    let cam = this.opts.getCamera();
    if (dx || dy) cam = panBy(cam, -dx, -dy);
    if (zoom) cam = zoomAt(cam, s.at.x, s.at.y, Math.exp(zoom));
    this.opts.setCamera(cam);
  }

  /** Довести плавную прокрутку сразу (началось перетаскивание или другой жест). */
  finishSmooth(): void {
    const s = this.smooth;
    if (!s) return;
    cancelAnimationFrame(s.raf);
    this.applySmooth(s.dx, s.dy, s.zoom);
    this.smooth = null;
  }

  private onGestureStart = (e: WebKitGestureEvent): void => {
    e.preventDefault();
    this.rect = this.el.getBoundingClientRect();
    this.gestureScale = 1;
    this.gestureRotation = 0;
    this.twist = 0;
    this.rotating = false;
  };

  private onGestureEnd = (e: Event): void => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.snapRotation(r.width / 2, r.height / 2);
  };

  private onGestureChange = (e: WebKitGestureEvent): void => {
    e.preventDefault();
    if (!(e.scale > 0)) return;
    const p = this.local(e);
    const factor = e.scale / this.gestureScale;
    this.gestureScale = e.scale;
    let cam = zoomAt(this.opts.getCamera(), p.x, p.y, factor);
    const rot = ((e.rotation ?? 0) * Math.PI) / 180;
    cam = this.applyTwist(cam, p.x, p.y, rot - this.gestureRotation);
    this.gestureRotation = rot;
    this.opts.setCamera(cam);
  };

  /** Добавить поворот пальцев к виду (с порогом начала). */
  private applyTwist(cam: Camera, cx: number, cy: number, da: number): Camera {
    if (!this.rotateView || !Number.isFinite(da)) return cam;
    this.twist += da;
    if (!this.rotating && Math.abs(this.twist) < ROTATE_START) return cam;
    this.rotating = true;
    return rotateAt(cam, cx, cy, da);
  }

  /** Конец жеста: почти прямой угол — ровно прямой. */
  private snapRotation(cx: number, cy: number): void {
    if (!this.rotating) return;
    this.rotating = false;
    this.twist = 0;
    const cam = this.opts.getCamera();
    const r = cam.rotation ?? 0;
    const right = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(r - right) < ROTATE_SNAP) {
      this.opts.setCamera(setRotationAt(cam, cx, cy, normalizeAngle(right)));
    }
  }

  private onDown = (e: PointerEvent): void => {
    this.finishSmooth();
    if (e.pointerType === 'touch') {
      // Пока рисуют пером, пальцы на экране — это ладонь.
      if (this.opts.drawingWith() === 'pen') return;
      if (e.width >= PALM_SIZE || e.height >= PALM_SIZE) return;
      const claimed = this.claims(e);
      this.rect = this.el.getBoundingClientRect();
      if (this.touches.size === 0) {
        this.tap = {
          start: e.timeStamp,
          fingers: 0,
          camera: this.opts.getCamera(),
          origin: new Map(),
          failed: false,
        };
      }
      this.touches.set(e.pointerId, this.local(e));
      if (this.tap) {
        if (e.timeStamp - this.tap.start > TAP_MAX_MS) this.tap.failed = true;
        this.tap.origin.set(e.pointerId, this.local(e));
        this.tap.fingers = Math.max(this.tap.fingers, this.touches.size);
      }
      if (this.touches.size >= 2) {
        if (this.opts.drawingWith() === 'touch') this.opts.onMultiTouch?.();
        this.capture(e);
        const was = this.isPanning;
        this.pan = null;
        this.pinch = this.pinchState();
        this.twist = 0;
        this.rotating = false;
        if (!was) this.opts.onPanChange?.(true);
      } else if (claimed) {
        this.capture(e);
        const p = this.local(e);
        this.setPan({ id: e.pointerId, x: p.x, y: p.y, touch: true });
      }
      return;
    }
    if (!this.claims(e)) {
      // Перо коснулось экрана — касания пальцами были ладонью.
      if (e.pointerType === 'pen') this.cancelTouches();
      return;
    }
    e.preventDefault();
    this.rect = this.el.getBoundingClientRect();
    this.capture(e);
    const p = this.local(e);
    this.setPan({ id: e.pointerId, x: p.x, y: p.y, touch: false });
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const here = this.local(e);
      this.touches.set(e.pointerId, here);
      const o = this.tap?.origin.get(e.pointerId);
      if (o && Math.hypot(here.x - o.x, here.y - o.y) > TAP_SLOP) this.tap!.failed = true;
      if (this.pinch) {
        const next = this.pinchState();
        if (!next) return;
        let cam = panBy(this.opts.getCamera(), next.cx - this.pinch.cx, next.cy - this.pinch.cy);
        if (this.pinch.d > 0 && next.d > 0)
          cam = zoomAt(cam, next.cx, next.cy, next.d / this.pinch.d);
        cam = this.applyTwist(cam, next.cx, next.cy, normalizeAngle(next.a - this.pinch.a));
        this.pinch = next;
        this.opts.setCamera(cam);
        return;
      }
    }
    if (this.pan && this.pan.id === e.pointerId) {
      const p = this.local(e);
      const dx = p.x - this.pan.x;
      const dy = p.y - this.pan.y;
      this.pan.x = p.x;
      this.pan.y = p.y;
      if (dx !== 0 || dy !== 0) this.opts.setCamera(panBy(this.opts.getCamera(), dx, dy));
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (this.touches.delete(e.pointerId)) {
      const tap = this.tap;
      if (tap && e.type === 'pointercancel') tap.failed = true;
      if (tap && this.touches.size === 0) {
        this.tap = null;
        if (!tap.failed && tap.fingers >= 2 && e.timeStamp - tap.start <= TAP_MAX_MS) {
          // Пальцы чуть сдвинули холст за время тапа — возвращаем как было.
          this.opts.setCamera(tap.camera);
          this.opts.onTap?.(tap.fingers);
        } else if (
          !tap.failed &&
          tap.fingers === 1 &&
          this.touchPans &&
          e.timeStamp - tap.start <= TAP_MAX_MS
        ) {
          const at = [...tap.origin.values()][0];
          if (at) this.opts.onTap?.(1, at);
        }
      }
      if (this.pinch) {
        if (this.touches.size >= 2) {
          this.pinch = this.pinchState();
        } else {
          const last = this.pinch;
          this.pinch = null;
          this.snapRotation(last.cx, last.cy);
          // Оставшийся палец продолжает сдвиг, если пальцем двигают холст.
          const [id, p] = [...this.touches.entries()][0] ?? [];
          if (id !== undefined && p && this.touchPans)
            this.pan = { id, x: p.x, y: p.y, touch: true };
          if (!this.isPanning) this.opts.onPanChange?.(false);
        }
      }
    }
    if (this.pan && this.pan.id === e.pointerId) this.setPan(null);
  };

  private pinchState(): { cx: number; cy: number; d: number; a: number } | null {
    const it = this.touches.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return null;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      d: Math.hypot(b.x - a.x, b.y - a.y),
      a: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  private capture(e: PointerEvent): void {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* синтетические события */
    }
  }
}

/**
 * Щелчок колеса мыши, а не трекпад: строки или страницы (Firefox), либо крупный шаг,
 * кратный 120 в устаревшем wheelDelta (Chrome, Edge, WebView2). Трекпад шлёт мелкие дробные шаги.
 */
export function isWheelNotch(e: {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  wheelDeltaY?: number;
}): boolean {
  if (e.deltaMode !== 0) return true;
  if (e.deltaX !== 0 || Math.abs(e.deltaY) < 50) return false;
  const legacy = e.wheelDeltaY;
  return legacy === undefined || (legacy !== 0 && legacy % 120 === 0);
}
