/**
 * Сцена: элементы доски в виде, готовом к отрисовке, и пространственный индекс.
 * Следит за Yjs-документом: любое изменение (своё, с другого устройства, от агента) обновляет сцену
 * и сообщает, какие участки мира нужно перерисовать.
 */

import type * as Y from 'yjs';
import { getElement, listElements, observeElements } from '@kayospace/board';
import { decodeStroke, type CanvasElement, type StrokeElement } from '@kayospace/model';
import {
  samplesBounds,
  strokeSamples,
  type Bounds,
  type Sample,
  type StrokeStyle,
} from '@kayospace/ink';
import { GridIndex } from './grid-index';

/** Параметры линии, общие для всех устройств: штрих пересчитывается из точек одинаково везде. */
export const STROKE_THINNING = 0.6;
export const STROKE_STREAMLINE = 0.25;

export interface SceneItem {
  id: string;
  z: string;
  element: CanvasElement;
  bounds: Bounds;
  samples: Sample[];
  /** null — цвет чернил темы (чёрный в светлой, светлый в тёмной). */
  color: string | null;
  /** Кеш контура для отрисовки (создаётся при первой отрисовке). */
  path?: Path2D;
  /** Стикер или текст: строки после переноса (заполняет отрисовка). */
  lines?: string[];
}

export function strokeStyleFor(el: StrokeElement): StrokeStyle {
  return {
    color: el.style.color ?? '',
    size: el.style.size ?? 4,
    thinning: STROKE_THINNING,
    streamline: STROKE_STREAMLINE,
    simulatePressure: !el.props.hasPressure,
    unit: el.props.unit ?? 1,
  };
}

export class Scene {
  readonly items = new Map<string, SceneItem>();
  readonly index = new GridIndex();
  private readonly listeners = new Set<(dirty: Bounds[]) => void>();
  private readonly stopObserving: () => void;

  constructor(readonly doc: Y.Doc) {
    for (const el of listElements(doc)) this.upsert(el);
    this.stopObserving = observeElements(doc, (c) => {
      const dirty: Bounds[] = [];
      for (const id of c.deleted) {
        const old = this.items.get(id);
        if (old) {
          dirty.push(old.bounds);
          this.remove(id);
        }
      }
      for (const id of [...c.added, ...c.updated]) {
        const old = this.items.get(id);
        if (old) dirty.push(old.bounds);
        const el = getElement(doc, id);
        const item = el ? this.upsert(el) : null;
        if (item) dirty.push(item.bounds);
        else if (old) this.remove(id);
      }
      if (dirty.length > 0) for (const cb of [...this.listeners]) cb(dirty);
    });
  }

  get size(): number {
    return this.items.size;
  }

  onChange(cb: (dirty: Bounds[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Элементы, задевающие область, в порядке слоёв. */
  query(view: Bounds): SceneItem[] {
    const out: SceneItem[] = [];
    for (const id of this.index.query(view)) {
      const item = this.items.get(id);
      if (item) out.push(item);
    }
    return out.sort((a, b) => (a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1));
  }

  /** Штрихи, которых касается круг радиуса r (мировые координаты) — для ластика. */
  hitTest(x: number, y: number, r: number): string[] {
    const hits: string[] = [];
    const box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    for (const id of this.index.query(box)) {
      const item = this.items.get(id);
      if (!item || item.element.type !== 'stroke') continue; // ластик стирает только рукописное
      for (const s of item.samples) {
        const reach = r + s.r;
        const dx = s.x - x;
        const dy = s.y - y;
        if (dx * dx + dy * dy <= reach * reach) {
          hits.push(id);
          break;
        }
      }
    }
    return hits;
  }

  /** Рамка всего содержимого доски. */
  contentBounds(): Bounds | null {
    let b: Bounds | null = null;
    for (const item of this.items.values()) {
      b = b
        ? {
            minX: Math.min(b.minX, item.bounds.minX),
            minY: Math.min(b.minY, item.bounds.minY),
            maxX: Math.max(b.maxX, item.bounds.maxX),
            maxY: Math.max(b.maxY, item.bounds.maxY),
          }
        : { ...item.bounds };
    }
    return b;
  }

  destroy(): void {
    this.stopObserving();
    this.listeners.clear();
    this.items.clear();
    this.index.clear();
  }

  private upsert(el: CanvasElement): SceneItem | null {
    if (el.type === 'sticky' || el.type === 'text') {
      // Пока только показываем (стикеры от агентов); редактирование — шаг 1.3.
      const bounds = { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
      const item: SceneItem = {
        id: el.id,
        z: el.z,
        element: el,
        bounds,
        samples: [],
        color: el.style.color ?? null,
      };
      this.items.set(el.id, item);
      this.index.insert(el.id, bounds);
      return item;
    }
    if (el.type !== 'stroke') return null; // остальные типы — в следующих шагах фазы 1
    const points = decodeStroke(el.props.points).map((p) => ({
      ...p,
      x: p.x + el.x,
      y: p.y + el.y,
    }));
    const samples = strokeSamples(points, strokeStyleFor(el));
    const bounds = samplesBounds(samples);
    if (!bounds) return null;
    const item: SceneItem = {
      id: el.id,
      z: el.z,
      element: el,
      bounds,
      samples,
      color: el.style.color ?? null,
    };
    this.items.set(el.id, item);
    this.index.insert(el.id, bounds);
    return item;
  }

  private remove(id: string): void {
    this.items.delete(id);
    this.index.remove(id);
  }
}
