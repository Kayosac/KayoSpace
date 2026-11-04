/**
 * Доска как Yjs-документ (см. docs/PLAN.md, раздел 5).
 *
 * Раскладка документа:
 *   meta:     Y.Map — name, createdAt
 *   elements: Y.Map<id, CanvasElement> — каждый элемент целиком одним значением.
 *
 * Элемент хранится одним значением: правки разных элементов с разных устройств сливаются без конфликтов,
 * одновременная правка одного элемента решается по принципу «последний победил». Для штрихов
 * (неизменяемых после создания) и стикеров этого достаточно; текст с совместным редактированием
 * получит свой Y.XmlFragment, когда появится в фазе 1.
 */

import * as Y from 'yjs';
import type { Actor, CanvasElement, ElementId } from '@kayospace/model';

export const ELEMENTS = 'elements';
export const META = 'meta';

/** Происхождение транзакции: по нему отличаем свои правки от пришедших по сети. */
export type Origin = unknown;

export function createBoardDoc(name?: string): Y.Doc {
  const doc = new Y.Doc();
  if (name) setBoardName(doc, name);
  return doc;
}

export function elementsMap(doc: Y.Doc): Y.Map<CanvasElement> {
  return doc.getMap<CanvasElement>(ELEMENTS);
}

export function setBoardName(doc: Y.Doc, name: string, origin?: Origin): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>(META);
    meta.set('name', name);
    if (!meta.has('createdAt')) meta.set('createdAt', Date.now());
  }, origin);
}

export function getBoardName(doc: Y.Doc): string | undefined {
  const name = doc.getMap<unknown>(META).get('name');
  return typeof name === 'string' ? name : undefined;
}

export function addElement(doc: Y.Doc, element: CanvasElement, origin?: Origin): ElementId {
  doc.transact(() => elementsMap(doc).set(element.id, element), origin);
  return element.id;
}

export function addElements(doc: Y.Doc, elements: CanvasElement[], origin?: Origin): void {
  doc.transact(() => {
    const map = elementsMap(doc);
    for (const el of elements) map.set(el.id, el);
  }, origin);
}

/** Обновить поля элемента. Возвращает false, если элемента нет. */
export function updateElement(
  doc: Y.Doc,
  id: ElementId,
  patch: Partial<Omit<CanvasElement, 'id' | 'type'>>,
  actor: Actor,
  origin?: Origin,
): boolean {
  const map = elementsMap(doc);
  const current = map.get(id);
  if (!current) return false;
  doc.transact(() => {
    map.set(id, {
      ...current,
      ...patch,
      updatedBy: actor,
      updatedAt: Date.now(),
    } as CanvasElement);
  }, origin);
  return true;
}

export function deleteElement(doc: Y.Doc, id: ElementId, origin?: Origin): boolean {
  const map = elementsMap(doc);
  if (!map.has(id)) return false;
  doc.transact(() => map.delete(id), origin);
  return true;
}

export function deleteElements(doc: Y.Doc, ids: Iterable<ElementId>, origin?: Origin): void {
  doc.transact(() => {
    const map = elementsMap(doc);
    for (const id of ids) map.delete(id);
  }, origin);
}

export function getElement(doc: Y.Doc, id: ElementId): CanvasElement | undefined {
  return elementsMap(doc).get(id);
}

/** Все элементы в порядке слоёв (по z, затем по id). */
export function listElements(doc: Y.Doc): CanvasElement[] {
  return [...elementsMap(doc).values()].sort((a, b) =>
    a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1,
  );
}

export interface ElementChanges {
  added: ElementId[];
  updated: ElementId[];
  deleted: ElementId[];
  /** Своя ли это правка (origin транзакции) — пригодится, чтобы не перерисовывать дважды. */
  origin: Origin;
}

/** Подписка на изменения элементов. Возвращает функцию отписки. */
export function observeElements(doc: Y.Doc, cb: (changes: ElementChanges) => void): () => void {
  const map = elementsMap(doc);
  const handler = (event: Y.YMapEvent<CanvasElement>): void => {
    const changes: ElementChanges = {
      added: [],
      updated: [],
      deleted: [],
      origin: event.transaction.origin,
    };
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add') changes.added.push(key);
      else if (change.action === 'update') changes.updated.push(key);
      else changes.deleted.push(key);
    });
    cb(changes);
  };
  map.observe(handler);
  return () => map.unobserve(handler);
}
