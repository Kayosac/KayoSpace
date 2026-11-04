/**
 * Сцена: элементы доски в виде, готовом к отрисовке, и пространственный индекс.
 * Следит за Yjs-документом: любое изменение (своё, с другого устройства, от агента) обновляет сцену
 * и сообщает, какие участки мира нужно перерисовать.
 */

import type * as Y from 'yjs';
import { getElement, listElements, observeElements } from '@kayospace/board';
import {
  decodeStroke,
  type ArrowElement,
  type CanvasElement,
  type StrokeElement,
} from '@kayospace/model';
import {
  samplesBounds,
  strokeSamples,
  type Bounds,
  type Sample,
  type StrokeStyle,
} from '@kayospace/ink';
import { GridIndex } from './grid-index';
import { arrowEnds, outlineDistance, shapeBounds, type ResolveBounds } from './shapes';

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
  /** Стрелка: концы с учётом привязки к элементам. */
  ends?: [{ x: number; y: number }, { x: number; y: number }];
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
  /** Стрелки, привязанные к элементу: id элемента → id стрелок. */
  private readonly dependents = new Map<string, Set<string>>();
  readonly resolve: ResolveBounds = (id) => this.items.get(id)?.bounds;

  constructor(readonly doc: Y.Doc) {
    const all = listElements(doc);
    for (const el of all) this.upsert(el);
    // Стрелки могли загрузиться раньше элементов, к которым привязаны, — пересчитываем.
    for (const el of all) if (el.type === 'arrow' && this.dependsOnOthers(el)) this.upsert(el);
    this.stopObserving = observeElements(doc, (c) => {
      const dirty: Bounds[] = [];
      const changed = new Set([...c.added, ...c.updated, ...c.deleted]);
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
      // Элемент сдвинули или удалили — привязанные к нему стрелки тянутся следом.
      for (const id of changed) {
        for (const arrowId of this.dependents.get(id) ?? []) {
          if (changed.has(arrowId)) continue;
          const old = this.items.get(arrowId);
          const el = getElement(doc, arrowId);
          if (!old || !el) continue;
          dirty.push(old.bounds);
          const item = this.upsert(el);
          if (item) dirty.push(item.bounds);
        }
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

  /** Верхний элемент под точкой (штрих — с допуском r от линии), или null. */
  pick(x: number, y: number, r: number): string | null {
    const box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    const items = this.query(box);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.element.type === 'arrow') {
        const reach = r + (item.element.style.size ?? 2) / 2;
        if (outlineDistance(item.element, x, y, this.resolve) <= reach) return item.id;
        continue;
      }
      if (item.element.type !== 'stroke') {
        const b = item.bounds;
        if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return item.id;
        continue;
      }
      for (const s of item.samples) {
        const reach = r + s.r;
        if ((s.x - x) ** 2 + (s.y - y) ** 2 <= reach * reach) return item.id;
      }
    }
    return null;
  }

  /** Штрихи, которых касается круг радиуса r (мировые координаты) — для ластика. */
  hitTest(x: number, y: number, r: number): string[] {
    const hits: string[] = [];
    const box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    for (const id of this.index.query(box)) {
      const item = this.items.get(id);
      if (!item) continue;
      const type = item.element.type;
      if (type === 'shape' || type === 'arrow') {
        // Фигуру и стрелку ластик задевает только по линии, а не по пустой середине.
        if (
          outlineDistance(item.element, x, y, this.resolve) <=
          r + (item.element.style.size ?? 2) / 2
        ) {
          hits.push(id);
        }
        continue;
      }
      if (type !== 'stroke') continue; // стикеры и текст ластик не трогает
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
    if (el.type === 'shape' || el.type === 'arrow') {
      const bounds = shapeBounds(el, this.resolve);
      const item: SceneItem = {
        id: el.id,
        z: el.z,
        element: el,
        bounds,
        samples: [],
        color: el.style.color ?? null,
      };
      if (el.type === 'arrow') {
        item.ends = arrowEnds(el, this.resolve);
        this.track(el);
      }
      this.items.set(el.id, item);
      this.index.insert(el.id, bounds);
      return item;
    }
    if (el.type !== 'stroke') return null; // картинки и фреймы — в следующих шагах
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
    const item = this.items.get(id);
    if (item?.element.type === 'arrow') this.untrack(id);
    this.items.delete(id);
    this.index.remove(id);
  }

  private dependsOnOthers(el: ArrowElement): boolean {
    return el.props.start.kind === 'element' || el.props.end.kind === 'element';
  }

  private track(el: ArrowElement): void {
    this.untrack(el.id);
    for (const end of [el.props.start, el.props.end]) {
      if (end.kind !== 'element') continue;
      let set = this.dependents.get(end.id);
      if (!set) this.dependents.set(end.id, (set = new Set()));
      set.add(el.id);
    }
  }

  private untrack(arrowId: string): void {
    for (const [target, set] of this.dependents) {
      set.delete(arrowId);
      if (set.size === 0) this.dependents.delete(target);
    }
  }
}
