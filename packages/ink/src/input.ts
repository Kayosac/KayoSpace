/**
 * Ввод пера на базе Pointer Events.
 *
 * - собирает все промежуточные точки (getCoalescedEvents): перо шлёт события чаще, чем обновляется экран;
 * - по желанию отдаёт предсказанные точки (getPredictedEvents), чтобы рисовать чуть впереди пера;
 * - умеет слушать pointerrawupdate (меньше задержка, только в защищённом контексте Chromium);
 * - отсекает касания ладонью в режимах «только перо» и «авто».
 */

import type { StrokePoint } from '@kayospace/model';

/** Точка в координатах элемента. t — абсолютное время события (event.timeStamp, мс). */
export type InkPoint = StrokePoint;

export type PalmMode = 'all' | 'pen-only' | 'auto';

export interface PenInputOptions {
  palm: PalmMode;
  usePredicted: boolean;
  useRawUpdate: boolean;
}

export interface StrokeStart {
  pointerType: string;
  hasPressure: boolean;
  /** Нажата кнопка-ластик (обратный конец пера) или боковая кнопка. */
  eraser: boolean;
  point: InkPoint;
  event: PointerEvent;
}

export interface PenInputHandlers {
  onStart(info: StrokeStart): void;
  onMove(points: InkPoint[], predicted: InkPoint[], event: PointerEvent): void;
  onEnd(event: PointerEvent): void;
  onCancel?(event: PointerEvent): void;
  /** Для статистики: каждое событие движения и сколько точек в нём склеено. */
  onSample?(event: PointerEvent, coalesced: readonly PointerEvent[]): void;
  /** Касание отброшено как ладонь. */
  onRejected?(event: PointerEvent): void;
}

export const supportsRawUpdate = (): boolean =>
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;

export class PenInput {
  private active: number | null = null;
  private activeType = '';
  private penSeen = false;
  private rect: DOMRect;
  private moveEvent: 'pointermove' | 'pointerrawupdate' = 'pointermove';

  constructor(
    private readonly el: HTMLElement,
    private options: PenInputOptions,
    private readonly handlers: PenInputHandlers,
  ) {
    this.rect = el.getBoundingClientRect();
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('contextmenu', preventDefault);
    this.bindMove();
  }

  setOptions(next: Partial<PenInputOptions>): void {
    this.options = { ...this.options, ...next };
    this.bindMove();
  }

  get isDrawing(): boolean {
    return this.active !== null;
  }

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('contextmenu', preventDefault);
    this.el.removeEventListener(this.moveEvent, this.onMove as EventListener);
  }

  private bindMove(): void {
    const wanted =
      this.options.useRawUpdate && supportsRawUpdate() ? 'pointerrawupdate' : 'pointermove';
    if (wanted === this.moveEvent && this.el.dataset.inkBound === '1') return;
    this.el.removeEventListener(this.moveEvent, this.onMove as EventListener);
    this.moveEvent = wanted;
    this.el.addEventListener(this.moveEvent, this.onMove as EventListener);
    this.el.dataset.inkBound = '1';
  }

  private accepts(e: PointerEvent): boolean {
    if (e.pointerType === 'pen') {
      this.penSeen = true;
      return true;
    }
    if (e.pointerType === 'touch') {
      if (this.options.palm === 'pen-only') return false;
      if (this.options.palm === 'auto' && this.penSeen) return false;
    }
    return true;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.active !== null) {
      // Второе касание во время штриха (обычно ладонь) — игнорируем.
      if (e.pointerType !== this.activeType) this.handlers.onRejected?.(e);
      return;
    }
    if (!this.accepts(e)) {
      this.handlers.onRejected?.(e);
      return;
    }
    e.preventDefault();
    this.rect = this.el.getBoundingClientRect();
    this.active = e.pointerId;
    this.activeType = e.pointerType;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* бывает при синтетических событиях */
    }
    this.handlers.onStart({
      pointerType: e.pointerType,
      hasPressure: e.pointerType === 'pen',
      eraser: (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0,
      point: this.toPoint(e),
      event: e,
    });
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.active) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const events = coalesced.length > 0 ? coalesced : [e];
    const predicted = this.options.usePredicted ? (e.getPredictedEvents?.() ?? []) : [];
    this.handlers.onSample?.(e, events);
    this.handlers.onMove(
      events.map((ev) => this.toPoint(ev)),
      predicted.map((ev) => this.toPoint(ev)),
      e,
    );
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.active) return;
    this.active = null;
    this.handlers.onEnd(e);
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.active) return;
    this.active = null;
    (this.handlers.onCancel ?? this.handlers.onEnd)(e);
  };

  private toPoint(e: PointerEvent): InkPoint {
    const isPen = e.pointerType === 'pen';
    // Мышь и палец давление не передают (0 или 0.5) — подставляем 0.5, а форму штриха имитирует perfect-freehand.
    const p = isPen ? clamp01(e.pressure) : 0.5;
    return {
      x: e.clientX - this.rect.left,
      y: e.clientY - this.rect.top,
      p,
      tx: e.tiltX ?? 0,
      ty: e.tiltY ?? 0,
      t: e.timeStamp,
    };
  }
}

const preventDefault = (e: Event): void => e.preventDefault();
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
