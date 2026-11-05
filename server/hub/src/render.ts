/**
 * Картинка доски для агентов (решение 0015): элементы → SVG → PNG (resvg).
 * Агент видит то же, что человек: рукописное, рисунки, картинки, стикеры и фреймы — и может
 * прочитать почерк или схему, которые в тексте доски не выразить.
 *
 * Отрисовка упрощённая: штрих — линия средней толщины (без нажима), текст переносится по словам
 * с оценкой ширины символа. Для чтения моделью этого достаточно.
 */

import { Resvg } from '@resvg/resvg-js';
import { decodeStroke, type CanvasElement } from '@kayospace/model';

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageData {
  mime: string;
  data: Buffer;
}

const INK = '#1c1f26';
const STICKY_INK = '#1c1f26';
const STICKY_COLOR = '#ffe58a';
const HIGHLIGHTER = '#f5d90a';
const FONT = "'DejaVu Sans', 'Inter', 'Helvetica', sans-serif";
/** Средняя ширина символа относительно кегля (для переноса строк). */
const CHAR_W = 0.58;
const LINE = 1.3;
/** Сколько байт картинок можно вложить в одну отрисовку. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const n = (v: number): string => String(Math.round(v * 100) / 100);
const color = (c: string | undefined, fallback: string): string =>
  c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;

/** Строки текста, перенесённые по словам под ширину (длинное слово режется). */
export function wrapLines(text: string, width: number, size: number): string[] {
  const max = Math.max(1, Math.floor(width / (size * CHAR_W)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > max) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(w.slice(0, max));
        w = w.slice(max);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= max) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

/** Кегль стикера: самый крупный, при котором текст помещается. */
function stickyFont(text: string, w: number, h: number): { size: number; lines: string[] } {
  for (let size = 28; size >= 9; size -= 1) {
    const pad = size * 0.9;
    const lines = wrapLines(text, w - pad * 2, size);
    if (lines.length * size * LINE <= h - pad * 2) return { size, lines };
  }
  const size = 9;
  return { size, lines: wrapLines(text, w - 16, size) };
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  size: number,
  fill: string,
  opts: { anchor?: 'start' | 'middle'; weight?: number } = {},
): string {
  const tspans = lines
    .map(
      (l, i) => `<tspan x="${n(x)}" dy="${i === 0 ? n(size) : n(size * LINE)}">${esc(l)}</tspan>`,
    )
    .join('');
  return `<text y="${n(y)}" font-family="${FONT}" font-size="${n(size)}" fill="${fill}"${
    opts.anchor === 'middle' ? ' text-anchor="middle"' : ''
  }${opts.weight ? ` font-weight="${opts.weight}"` : ''}>${tspans}</text>`;
}

function rotated(el: CanvasElement, body: string): string {
  if (!el.rotation) return body;
  const deg = (el.rotation * 180) / Math.PI;
  return `<g transform="rotate(${n(deg)} ${n(el.x + el.w / 2)} ${n(el.y + el.h / 2)})">${body}</g>`;
}

type Point = { x: number; y: number };

/** Где отрезок из центра элемента к точке to выходит за рамку элемента (плюс зазор). */
export function rectExit(from: Point, to: Point, el: CanvasElement, gap = 0): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const hw = el.w / 2 + gap;
  const hh = el.h / 2 + gap;
  const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity, 1);
  return { x: from.x + dx * k, y: from.y + dy * k };
}

function center(el: CanvasElement): { x: number; y: number } {
  return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
}

function elementSvg(
  el: CanvasElement,
  byId: ReadonlyMap<string, CanvasElement>,
  images: ReadonlyMap<string, ImageData>,
): string {
  switch (el.type) {
    case 'frame': {
      const title = el.style.size ?? 14;
      return (
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" rx="8" fill="#ffffff" stroke="rgba(28,31,38,0.2)" stroke-width="1.5"/>` +
        textBlock([el.props.name], el.x + 2, el.y - title * 1.6, title, '#555a66', { weight: 600 })
      );
    }
    case 'doc': {
      // Карточка документа или таблицы (решение 0021): метка, название, начало текста.
      const pad = 16;
      const table = el.props.doc.startsWith('tb_');
      const titleLines = wrapLines(
        el.props.title || (table ? 'Таблица' : 'Документ'),
        el.w - pad * 2,
        18,
      ).slice(0, 2);
      const room = Math.max(
        0,
        Math.floor((el.h - pad * 2 - 22 - titleLines.length * 18 * LINE - 8) / (14 * LINE)),
      );
      const body = (el.props.excerpt ?? '')
        .split('\n')
        .flatMap((l) => wrapLines(l, el.w - pad * 2, 14))
        .slice(0, room);
      return rotated(
        el,
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" rx="10" fill="#ffffff" stroke="rgba(28,31,38,0.18)" stroke-width="1.5"/>` +
          `<rect x="${n(el.x)}" y="${n(el.y)}" width="4" height="${n(el.h)}" rx="2" fill="${table ? '#2f9e66' : '#3e63dd'}"/>` +
          textBlock([table ? 'ТАБЛИЦА' : 'ДОКУМЕНТ'], el.x + pad, el.y + pad - 2, 11, '#6c7080', {
            weight: 600,
          }) +
          textBlock(titleLines, el.x + pad, el.y + pad + 18, 18, INK, { weight: 700 }) +
          textBlock(
            body,
            el.x + pad,
            el.y + pad + 26 + titleLines.length * 18 * LINE,
            14,
            '#555a66',
          ),
      );
    }
    case 'sticky': {
      const { size, lines } = stickyFont(el.props.content, el.w, el.h);
      const top = el.y + Math.max(size * 0.9, (el.h - lines.length * size * LINE) / 2);
      return rotated(
        el,
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" rx="6" fill="${color(el.style.color, STICKY_COLOR)}"/>` +
          textBlock(lines, el.x + size * 0.9, top, size, STICKY_INK, { weight: 500 }),
      );
    }
    case 'text': {
      const size = el.style.size ?? 20;
      return rotated(
        el,
        textBlock(
          wrapLines(el.props.content, el.w, size),
          el.x,
          el.y,
          size,
          color(el.style.color, INK),
        ),
      );
    }
    case 'shape': {
      const stroke = color(el.style.color, INK);
      const sw = el.style.size ?? 2;
      const body =
        el.props.shape === 'ellipse'
          ? `<ellipse cx="${n(el.x + el.w / 2)}" cy="${n(el.y + el.h / 2)}" rx="${n(el.w / 2)}" ry="${n(el.h / 2)}" fill="none" stroke="${stroke}" stroke-width="${n(sw)}"/>`
          : el.props.shape === 'line'
            ? `<line x1="${n(el.x)}" y1="${n(el.y)}" x2="${n(el.x + el.w)}" y2="${n(el.y + el.h)}" stroke="${stroke}" stroke-width="${n(sw)}" stroke-linecap="round"/>`
            : `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="none" stroke="${stroke}" stroke-width="${n(sw)}"/>`;
      const label = el.props.label
        ? textBlock(
            wrapLines(el.props.label, el.w, 16),
            el.x + el.w / 2,
            el.y + el.h / 2 - 10,
            16,
            stroke,
            {
              anchor: 'middle',
            },
          )
        : '';
      return rotated(el, body + label);
    }
    case 'arrow': {
      const end = (e: (typeof el.props)['start']): { x: number; y: number } | null => {
        if (e.kind === 'point') return { x: e.x, y: e.y };
        const t = byId.get(e.id);
        return t ? center(t) : null;
      };
      const a0 = end(el.props.start);
      const b0 = end(el.props.end);
      if (!a0 || !b0) return '';
      // Конец, привязанный к элементу, — на краю элемента, а не в его центре.
      const edge = (e: (typeof el.props)['start'], from: Point, to: Point): Point => {
        if (e.kind === 'point') return from;
        const t = byId.get(e.id);
        return t ? rectExit(from, to, t, 6) : from;
      };
      const a = edge(el.props.start, a0, b0);
      const b = edge(el.props.end, b0, a0);
      const stroke = color(el.style.color, INK);
      const sw = el.style.size ?? 2;
      const head = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        const len = 10 + sw * 3;
        const p1 = { x: to.x - len * Math.cos(ang - 0.45), y: to.y - len * Math.sin(ang - 0.45) };
        const p2 = { x: to.x - len * Math.cos(ang + 0.45), y: to.y - len * Math.sin(ang + 0.45) };
        return `<polygon points="${n(to.x)},${n(to.y)} ${n(p1.x)},${n(p1.y)} ${n(p2.x)},${n(p2.y)}" fill="${stroke}"/>`;
      };
      const heads = el.props.heads ?? 'end';
      return (
        `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${stroke}" stroke-width="${n(sw)}" stroke-linecap="round"/>` +
        (heads !== 'none' ? head(a, b) : '') +
        (heads === 'both' ? head(b, a) : '')
      );
    }
    case 'stroke': {
      let pts: { x: number; y: number }[];
      try {
        pts = decodeStroke(el.props.points);
      } catch {
        return '';
      }
      if (pts.length === 0) return '';
      const tool = el.props.tool ?? 'pen';
      const fill =
        tool === 'highlighter' ? color(el.style.color, HIGHLIGHTER) : color(el.style.color, INK);
      const opacity = tool === 'highlighter' ? 0.35 : tool === 'marker' ? 0.85 : 1;
      const width = el.style.size ?? 4;
      const d = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${n(el.x + p.x)} ${n(el.y + p.y)}`)
        .join('');
      // Точка (одиночное касание) — кружок.
      const path = pts.length === 1 ? `${d}l0.01 0` : d;
      return `<path d="${path}" fill="none" stroke="${fill}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`;
    }
    case 'image': {
      const img = images.get(el.props.assetId);
      if (img) {
        return rotated(
          el,
          `<image x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" preserveAspectRatio="none" href="data:${img.mime};base64,${img.data.toString('base64')}"/>`,
        );
      }
      return rotated(
        el,
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="#eceae4" stroke="#c9c6bd"/>` +
          textBlock(
            [el.props.alt ? `Картинка: ${el.props.alt}` : 'Картинка'],
            el.x + 8,
            el.y + 8,
            14,
            '#6c7080',
          ),
      );
    }
  }
}

/** Рамка элементов с учётом заголовков фреймов. */
export function contentArea(elements: readonly CanvasElement[]): Area | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const top = el.type === 'frame' ? el.y - (el.style.size ?? 14) * 1.8 : el.y;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * SVG области доски. Масштаб — чтобы длинная сторона была не больше maxSize пикселей
 * и не крупнее 2 пикселей на единицу доски.
 */
export function boardSvg(
  elements: readonly CanvasElement[],
  area: Area,
  opts: { maxSize?: number; images?: ReadonlyMap<string, ImageData> } = {},
): { svg: string; width: number; height: number; scale: number } {
  const maxSize = opts.maxSize ?? 1600;
  const scale = Math.min(2, maxSize / Math.max(area.w, area.h, 1));
  const width = Math.max(1, Math.round(area.w * scale));
  const height = Math.max(1, Math.round(area.h * scale));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const inArea = (el: CanvasElement): boolean =>
    el.x <= area.x + area.w &&
    el.x + el.w >= area.x &&
    el.y <= area.y + area.h &&
    el.y + el.h >= area.y;
  const body = [...elements]
    .filter((el) => el.type === 'arrow' || inArea(el))
    .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0))
    .map((el) => elementSvg(el, byId, opts.images ?? new Map()))
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}">` +
    `<rect x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" fill="#f6f5f1"/>` +
    body +
    '</svg>';
  return { svg, width, height, scale };
}

export function renderPng(svg: string): Buffer {
  const r = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
    imageRendering: 0,
    shapeRendering: 2,
  });
  return r.render().asPng();
}

/** Картинки, которые есть на доске, — сколько поместится в лимит. */
export async function loadImages(
  elements: readonly CanvasElement[],
  assets: {
    get(id: string): Promise<Buffer | null>;
    head(id: string): Promise<{ type: string } | null>;
  } | null,
): Promise<Map<string, ImageData>> {
  const out = new Map<string, ImageData>();
  if (!assets) return out;
  let total = 0;
  for (const el of elements) {
    if (el.type !== 'image' || out.has(el.props.assetId)) continue;
    const head = await assets.head(el.props.assetId);
    if (!head || !/^image\/(png|jpeg|gif)$/.test(head.type)) continue;
    const data = await assets.get(el.props.assetId);
    if (!data || total + data.length > MAX_IMAGE_BYTES) continue;
    total += data.length;
    out.set(el.props.assetId, { mime: head.type, data });
  }
  return out;
}
