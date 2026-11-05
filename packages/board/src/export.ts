/**
 * Как доску видит агент: Markdown для чтения и компактный JSON для точных правок.
 * Порядок — как читает человек: сверху вниз полосами, внутри полосы слева направо.
 */

import { taskLine } from './tasks';
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
      return el.props.task
        ? `- Задача ${taskLine(el.props.task)} ${quote(el.props.content)} ${pos} [sticky:${el.id}]${who(el)}`
        : `- Стикер ${quote(el.props.content)} ${pos} [sticky:${el.id}]${who(el)}`;
    case 'text':
      return `- Текст ${quote(el.props.content)} ${pos} [text:${el.id}]${who(el)}`;
    case 'image':
      return `- Картинка${el.props.alt ? ' ' + quote(el.props.alt) : ''} ${pos} [image:${el.id}]${who(el)}`;
    case 'frame':
      return `- Фрейм ${quote(el.props.name)} ${pos} [frame:${el.id}]`;
    case 'shape':
      return `- Фигура ${el.props.shape}${el.props.label ? ' ' + quote(el.props.label) : ''} ${pos} [shape:${el.id}]`;
    case 'arrow': {
      const end = (e: (typeof el.props)['start']): string =>
        e.kind === 'element' ? e.id : `(${round(e.x)}, ${round(e.y)})`;
      const kind = el.props.heads === 'none' ? 'Линия' : 'Стрелка';
      return `- ${kind} ${end(el.props.start)} → ${end(el.props.end)}${el.props.label ? ' ' + quote(el.props.label) : ''} [arrow:${el.id}]`;
    }
    case 'doc': {
      const kind = el.props.doc.startsWith('tb_') ? 'Таблица' : 'Документ';
      return `- ${kind} ${quote(el.props.title ?? el.props.doc)} ${pos} [doc:${el.id}] → ${el.props.doc} (${el.props.doc.startsWith('tb_') ? 'read_table' : 'read_page'})${who(el)}`;
    }
    case 'stroke':
      return null; // штрихи описываются сводкой
  }
}

/** Область доски (мировые координаты) — чтобы читать не всю доску, а видимое или выделенное. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Элементы, задевающие область (решение 0020): то, что человек видит или выделил. */
export function elementsInRegion(elements: readonly CanvasElement[], r: Region): CanvasElement[] {
  return elements.filter(
    (el) => el.x <= r.x + r.w && el.x + el.w >= r.x && el.y <= r.y + r.h && el.y + el.h >= r.y,
  );
}

export function boardToMarkdown(
  doc: Y.Doc,
  boardId?: string,
  opts: { region?: Region } = {},
): string {
  const all = listElements(doc);
  const elements = opts.region ? elementsInRegion(all, opts.region) : all;
  const name = getBoardName(doc) ?? boardId ?? 'Без названия';
  const lines: string[] = [`# Доска: ${name}`, ''];
  if (boardId) lines.push(`id: ${boardId}`, '');
  if (opts.region) {
    const r = opts.region;
    lines.push(
      `Показана только область (${round(r.x)}, ${round(r.y)}) ${round(r.w)}×${round(r.h)}: ` +
        `${elements.length} из ${all.length} элементов доски. Вся доска — read_board без region.`,
      '',
    );
  }

  if (elements.length === 0) {
    lines.push(opts.region ? 'В этой области пусто.' : 'Доска пустая.');
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
      'Как это выглядит — view_board; распознанный текст (если включён) — ниже.',
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
export function boardToJSON(doc: Y.Doc, boardId?: string, opts: { region?: Region } = {}): unknown {
  const all = listElements(doc);
  const elements = opts.region ? elementsInRegion(all, opts.region) : all;
  return {
    id: boardId,
    name: getBoardName(doc) ?? null,
    ...(opts.region ? { region: opts.region, totalElements: all.length } : {}),
    elements: elements.map((el) =>
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
    case 'doc':
      return [el.props.title, el.props.excerpt].filter(Boolean).join('\n');
    default:
      return '';
  }
}
