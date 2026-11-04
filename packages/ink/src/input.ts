/**
 * Ввод пера на базе Pointer Events.
 *
 * - собирает все промежуточные точки (getCoalescedEvents): перо шлёт события чаще, чем обновляется экран;
 * - по желанию отдаёт предсказанные точки (getPredictedEvents), чтобы рисовать чуть впереди пера;
 * - умеет слушать pointerrawupdate (меньше задержка, только в защищённом контексте Chromium);
 * - отсекает касания ладонью в режимах «только перо» и «авто»;
 * - восстанавливается, если система потеряла «отпускание» пера: иначе ввод навсегда
 *   считал бы штрих незаконченным и игнорировал новые касания.
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

/** Почему штрих завершён принудительно. */
export type RecoveryReason =
  /** Новое касание тем же пером, хотя «отпускания» не было. */
  | 'lost-up'
  /** Перо движется без нажатия (наведение) — касание уже закончилось. */
  | 'hover'
  /** Браузер отобрал захват указателя. */
  | 'lost-capture'
  /** Окно потеряло фокус или страница скрыта. */
  | 'blur';

export interface PenInputHandlers {
  onStart(info: StrokeStart): void;
  onMove(points: InkPoint[], predicted: InkPoint[], event: PointerEvent): void;
  /** Штрих закончен. event = null, если он завершён принудительно без события (потеря фокуса). */
  onEnd(event: PointerEvent | null): void;
  onCancel?(event: PointerEvent | null): void;
  /** Для статистики: каждое событие движения и сколько точек в нём склеено. */
  onSample?(event: PointerEvent, coalesced: readonly PointerEvent[]): void;
  /** Касание отброшено как ладонь. */
  onRejected?(event: PointerEvent): void;
  /** Штрих завершён принудительно (см. RecoveryReason). */
  onRecover?(reason: RecoveryReason): void;
}

export const supportsRawUpdate = (): boolean =>
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;

/** Касание пальцем без событий дольше этого времени считаем потерянным. */
const STALE_TOUCH_MS = 300;
/** Сколько движений подряд без нажатия нужно, чтобы считать касание законченным. */
const HOVER_MOVES_TO_END = 3;

export class PenInput {
  private active: number | null = null;
  private activeType = '';
  private lastActivity = 0;
  private hoverMoves = 0;
  private penSeen = false;
  private rect: DOMRect;
  private moveEvent: 'pointermove' | 'pointerrawupdate' = 'pointermove';
  private bound = false;

  constructor(
    private readonly el: HTMLElement,
    private options: PenInputOptions,
    private readonly handlers: PenInputHandlers,
  ) {
    this.rect = el.getBoundingClientRect();
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('lostpointercapture', this.onLostCapture);
    el.addEventListener('contextmenu', preventDefault);
    // Отпускание слушаем на окне: так оно не потеряется, даже если захват не сработал.
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
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
    this.el.removeEventListener('lostpointercapture', this.onLostCapture);
    this.el.removeEventListener('contextmenu', preventDefault);
    this.el.removeEventListener(this.moveEvent, this.onMove as EventListener);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private bindMove(): void {
    const wanted =
      this.options.useRawUpdate && supportsRawUpdate() ? 'pointerrawupdate' : 'pointermove';
    if (wanted === this.moveEvent && this.bound) return;
    this.el.removeEventListener(this.moveEvent, this.onMove as EventListener);
    this.moveEvent = wanted;
    this.el.addEventListener(this.moveEvent, this.onMove as EventListener);
    this.bound = true;
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

  /** Завершить текущий штрих. */
  private finish(e: PointerEvent | null, cancel: boolean): void {
    if (this.active === null) return;
    const id = this.active;
    this.active = null;
    try {
      if (this.el.hasPointerCapture?.(id)) this.el.releasePointerCapture(id);
    } catch {
      /* захват уже снят */
    }
    if (cancel) (this.handlers.onCancel ?? this.handlers.onEnd)(e);
    else this.handlers.onEnd(e);
  }

  private onDown = (e: PointerEvent): void => {
    if (this.active !== null) {
      const sameDevice = e.pointerType === this.activeType;
      const stale = e.timeStamp - this.lastActivity > STALE_TOUCH_MS;
      // Перо у устройства одно: новое касание пером значит, что «отпускание» потерялось.
      // Пальцев может быть несколько (ладонь), поэтому для них ждём паузы.
      if (sameDevice && (e.pointerType !== 'touch' || stale)) {
        this.handlers.onRecover?.('lost-up');
        this.finish(e, false);
      } else {
        if (!sameDevice) this.handlers.onRejected?.(e);
        return;
      }
    }
    if (!this.accepts(e)) {
      this.handlers.onRejected?.(e);
      return;
    }
    e.preventDefault();
    this.rect = this.el.getBoundingClientRect();
    this.active = e.pointerId;
    this.activeType = e.pointerType;
    this.lastActivity = e.timeStamp;
    this.hoverMoves = 0;
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
    // Перо без нажатия и без давления (наведение) или мышь без кнопок — касания уже нет.
    // Ждём несколько таких движений подряд, чтобы одиночный сбойный сэмпл не обрывал линию.
    const released =
      e.buttons === 0 &&
      (e.pointerType === 'mouse' || (e.pointerType === 'pen' && !(e.pressure > 0)));
    if (released) {
      if (++this.hoverMoves >= HOVER_MOVES_TO_END) {
        this.handlers.onRecover?.('hover');
        this.finish(e, false);
      }
      return;
    }
    this.hoverMoves = 0;
    this.lastActivity = e.timeStamp;
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
    if (e.pointerId === this.active) this.finish(e, false);
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.active) this.finish(e, true);
  };

  private onLostCapture = (e: PointerEvent): void => {
    // После обычного отпускания active уже null — сюда попадаем только при отобранном захвате.
    if (e.pointerId === this.active) {
      this.handlers.onRecover?.('lost-capture');
      this.finish(e, false);
    }
  };

  private onBlur = (): void => {
    if (this.active !== null) {
      this.handlers.onRecover?.('blur');
      this.finish(null, true);
    }
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onBlur();
  };

  private toPoint(e: PointerEvent): InkPoint {
    const isPen = e.pointerType === 'pen';
    // Мышь и палец давление не передают (0 или 0.5) — подставляем 0.5, форму штриха имитирует render.ts.
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
/** NaN тоже приводим к безопасному значению: некоторые устройства шлют мусор в pressure. */
const clamp01 = (v: number): number => (!(v > 0) ? 0 : v > 1 ? 1 : v);
