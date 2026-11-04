/**
 * Как доску видит агент: Markdown для чтения и компактный JSON для точных правок.
 * Порядок — как читает человек: сверху вниз полосами, внутри полосы слева направо.
 */

import type * as Y from 'yjs';
import type { CanvasElement } from '@kayospace/model';
import { decodeStroke } from '@kayospace/model';
import { getBoardName, listElements } from './board';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Высота «строки чтения»: элементы, чьи верхние края ближе этого, считаются одной строкой. */
const ROW = 80;

export function readingOrder(elements: readonly CanvasElement[]): CanvasElement[] {
  return [...elements].sort((a, b) => {
    const ra = Math.floor(a.y / ROW);
    const rb = Math.floor(b.y / ROW);
    return ra !== rb ? ra - rb : a.x - b.x;
  });
}

export function elementBounds(elements: readonly CanvasElement[]): Bounds | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  return { minX, minY, maxX, maxY };
}

const round = (v: number): number => Math.round(v);
const who = (el: CanvasElement): string =>
  el.createdBy.kind === 'agent' ? ` — добавил агент ${el.createdBy.name}` : '';
const quote = (s: string): string => `«${s.replace(/\s+/g, ' ').trim()}»`;

function describe(el: CanvasElement): string | null {
  const pos = `(${round(el.x)}, ${round(el.y)})`;
  switch (el.type) {
    case 'sticky':
      return `- Стикер ${quote(el.props.content)} ${pos} [sticky:${el.id}]${who(el)}`;
    case 'text':
      return `- Текст ${quote(el.props.content)} ${pos} [text:${el.id}]${who(el)}`;
    case 'image':
      return `- Картинка${el.props.alt ? ' ' + quote(el.props.alt) : ''} ${pos} [image:${el.id}]${who(el)}`;
    case 'frame':
      return `- Фрейм ${quote(el.props.name)} ${pos} [frame:${el.id}]`;
    case 'shape':
      return `- Фигура ${el.props.shape}${el.props.label ? ' ' + quote(el.props.label) : ''} ${pos} [shape:${el.id}]`;
    case 'arrow':
      return `- Стрелка${el.props.label ? ' ' + quote(el.props.label) : ''} [arrow:${el.id}]`;
    case 'stroke':
      return null; // штрихи описываются сводкой
  }
}

export function boardToMarkdown(doc: Y.Doc, boardId?: string): string {
  const elements = listElements(doc);
  const name = getBoardName(doc) ?? boardId ?? 'Без названия';
  const lines: string[] = [`# Доска: ${name}`, ''];
  if (boardId) lines.push(`id: ${boardId}`, '');

  if (elements.length === 0) {
    lines.push('Доска пустая.');
    return lines.join('\n');
  }

  const strokes = elements.filter((e) => e.type === 'stroke');
  const others = readingOrder(elements.filter((e) => e.type !== 'stroke'));

  if (others.length > 0) {
    lines.push('## Элементы', '');
    for (const el of others) {
      const line = describe(el);
      if (line) lines.push(line);
    }
    lines.push('');
  }

  if (strokes.length > 0) {
    const b = elementBounds(strokes)!;
    const points = strokes.reduce((n, s) => n + (s.type === 'stroke' ? pointCount(s) : 0), 0);
    lines.push(
      '## Рукописное',
      '',
      `Штрихов: ${strokes.length}, точек: ${points}, область (${round(b.minX)}, ${round(b.minY)}) — ` +
        `(${round(b.maxX)}, ${round(b.maxY)}).`,
      'Распознавание рукописного текста и картинка доски для агентов появятся в следующих версиях.',
      '',
    );
  }

  const b = elementBounds(elements)!;
  lines.push(
    `Всего элементов: ${elements.length}. Занятая область: (${round(b.minX)}, ${round(b.minY)}) — ` +
      `(${round(b.maxX)}, ${round(b.maxY)}).`,
  );
  return lines.join('\n');
}

function pointCount(el: CanvasElement): number {
  if (el.type !== 'stroke') return 0;
  const bytes = el.props.points;
  return bytes.byteLength >= 6 ? decodeStroke(bytes).length : 0;
}

/** Компактный JSON: всё, кроме точек штрихов (вместо них — количество). */
export function boardToJSON(doc: Y.Doc, boardId?: string): unknown {
  return {
    id: boardId,
    name: getBoardName(doc) ?? null,
    elements: listElements(doc).map((el) =>
      el.type === 'stroke'
        ? { ...el, props: { ...el.props, points: undefined, pointCount: pointCount(el) } }
        : el,
    ),
  };
}

/** Свободное место для нового элемента: справа от занятой области, на уровне её верха. */
export function freeSpot(doc: Y.Doc, gap = 40): { x: number; y: number } {
  const b = elementBounds(listElements(doc));
  if (!b) return { x: 100, y: 100 };
  return { x: Math.round(b.maxX + gap), y: Math.round(b.minY) };
}

/** Текстовое содержимое элемента — для поиска. */
export function elementText(el: CanvasElement): string {
  switch (el.type) {
    case 'sticky':
    case 'text':
      return el.props.content;
    case 'image':
      return el.props.alt ?? '';
    case 'frame':
      return el.props.name;
    case 'shape':
    case 'arrow':
      return el.props.label ?? '';
    default:
      return '';
  }
}
