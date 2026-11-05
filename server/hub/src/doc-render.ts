/**
 * Документы и таблицы картинкой (решение 0022): страницы A4 для PDF и миниатюра для карточки на доске.
 * Своя простая вёрстка в SVG (resvg): заголовки, абзацы с жирным и курсивом, списки, чек-листы,
 * цитаты, код, разделитель, фрагменты досок картинкой; таблица — сеткой с шапкой на каждой странице.
 * Ширина текста оценивается по символам — как у картинки доски для агентов.
 */

import type * as Y from 'yjs';
import { getBoardName, getElement, listElements } from '@kayospace/board';
import { cellText, readPage, readTable, type Column } from '@kayospace/page';

type JSONContent = ReturnType<typeof readPage>;
import { boardSvg, contentArea, loadImages, renderPng } from './render';

/** A4 при 96 dpi. */
export const PAGE_W = 794;
export const PAGE_H = 1123;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

const FONT = "'DejaVu Sans', 'Inter', 'Helvetica', sans-serif";
const MONO = "'DejaVu Sans Mono', 'Menlo', monospace";
const INK = '#1c1f26';
const MUTED = '#6c7080';
const LINE_C = '#d9d6cf';
const ACCENT = '#3e63dd';
const GREEN = '#2f9e66';

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const n = (v: number): string => String(Math.round(v * 100) / 100);

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
}

/** Ширина слова: оценка по символам (DejaVu широкий). */
const charW = (r: Run): number => (r.code ? 0.62 : r.bold ? 0.63 : 0.57);
const width = (t: string, r: Run, size: number): number => t.length * size * charW(r);

/** Кусок строки, положенный на экран. */
interface Item {
  /** Высота строки или блока. */
  h: number;
  /** Отступ перед блоком (у первого на странице не нужен). */
  gap: number;
  /** SVG блока с верхним краем в y. */
  draw: (y: number) => string;
}

/** Слова со стилями → строки шириной не больше w. */
function wrapRuns(runs: readonly Run[], w: number, size: number): Run[][] {
  const words: Run[] = [];
  for (const r of runs) {
    const parts = r.text.split(/(\s+)/);
    for (const p of parts) if (p) words.push({ ...r, text: p });
  }
  const lines: Run[][] = [];
  let line: Run[] = [];
  let lw = 0;
  for (const word of words) {
    if (word.text === '\n') {
      lines.push(line);
      line = [];
      lw = 0;
      continue;
    }
    const space = /^\s+$/.test(word.text);
    const ww = width(word.text, word, size);
    if (!space && lw + ww > w && line.length) {
      while (line.length && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
      lines.push(line);
      line = [];
      lw = 0;
    }
    if (space && !line.length) continue;
    // Слово длиннее строки — режем.
    if (!space && ww > w) {
      const max = Math.max(1, Math.floor(w / (size * charW(word))));
      let rest = word.text;
      while (rest.length > max) {
        lines.push([...line, { ...word, text: rest.slice(0, max) }]);
        line = [];
        lw = 0;
        rest = rest.slice(max);
      }
      line.push({ ...word, text: rest });
      lw += width(rest, word, size);
      continue;
    }
    line.push(word);
    lw += ww;
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

function lineSvg(
  line: readonly Run[],
  x: number,
  y: number,
  size: number,
  fill: string,
  extra = '',
): string {
  if (!line.length) return '';
  const spans = line
    .map((r) => {
      const attrs = [
        r.bold ? 'font-weight="700"' : '',
        r.italic ? 'font-style="italic"' : '',
        r.code ? `font-family="${MONO}"` : '',
        r.strike ? 'text-decoration="line-through"' : '',
        r.link ? `fill="${ACCENT}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<tspan ${attrs}>${esc(r.text)}</tspan>`;
    })
    .join('');
  return `<text x="${n(x)}" y="${n(y + size * 1.05)}" font-family="${FONT}" font-size="${n(size)}" fill="${fill}" xml:space="preserve"${extra}>${spans}</text>`;
}

function runsOf(nodes: readonly JSONContent[] = []): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') out.push({ text: '\n' });
    if (node.type !== 'text' || !node.text) continue;
    const m = new Set((node.marks ?? []).map((x) => x.type));
    out.push({
      text: node.text,
      ...(m.has('bold') ? { bold: true } : {}),
      ...(m.has('italic') ? { italic: true } : {}),
      ...(m.has('code') ? { code: true } : {}),
      ...(m.has('strike') ? { strike: true } : {}),
      ...(m.has('link') ? { link: true } : {}),
    });
  }
  return out;
}

/** Строки текста блока — по элементу на строку, чтобы страница могла разорваться между ними. */
function textItems(
  runs: readonly Run[],
  x: number,
  w: number,
  size: number,
  opts: { fill?: string; gap?: number; lh?: number; bold?: boolean; strike?: boolean } = {},
): Item[] {
  const lh = size * (opts.lh ?? 1.5);
  const styled = runs.map((r) => ({
    ...r,
    ...(opts.bold ? { bold: true } : {}),
    ...(opts.strike ? { strike: true } : {}),
  }));
  return wrapRuns(styled, w, size).map((line, i) => ({
    h: lh,
    gap: i === 0 ? (opts.gap ?? 0) : 0,
    draw: (y) => lineSvg(line, x, y + (lh - size * 1.25) / 2, size, opts.fill ?? INK),
  }));
}

export interface EmbedImage {
  png: Buffer;
  w: number;
  h: number;
}

type EmbedLoader = (board: string, frame: string | null) => Promise<EmbedImage | null>;

async function blockItems(
  node: JSONContent,
  x: number,
  w: number,
  embed: EmbedLoader,
  depth = 0,
): Promise<Item[]> {
  switch (node.type) {
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const size = level === 1 ? 26 : level === 2 ? 21 : 18;
      return textItems(runsOf(node.content), x, w, size, { bold: true, gap: size * 0.8, lh: 1.3 });
    }
    case 'paragraph': {
      const runs = runsOf(node.content);
      if (!runs.length) return [{ h: 15 * 1.5, gap: 6, draw: () => '' }];
      return textItems(runs, x, w, 15, { gap: 6 });
    }
    case 'blockquote': {
      const inner: Item[] = [];
      for (const c of node.content ?? [])
        inner.push(...(await blockItems(c, x + 16, w - 16, embed, depth)));
      return inner.map((it, i) => ({
        ...it,
        gap: i === 0 ? 8 : it.gap,
        draw: (y) =>
          `<rect x="${n(x)}" y="${n(y)}" width="3" height="${n(it.h)}" fill="${ACCENT}"/>` +
          it.draw(y).replaceAll(`fill="${INK}"`, `fill="${MUTED}"`),
      }));
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((t) => t.text ?? '').join('');
      const lines = text.split('\n');
      const size = 13;
      const lh = size * 1.45;
      return lines.map((l, i) => ({
        h: lh + (i === 0 ? 8 : 0) + (i === lines.length - 1 ? 8 : 0),
        gap: i === 0 ? 8 : 0,
        draw: (y) =>
          `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(lh + (i === 0 ? 8 : 0) + (i === lines.length - 1 ? 8 : 0))}" fill="#f1efe9"/>` +
          lineSvg(
            [{ text: l, code: true }],
            x + 12,
            y + (i === 0 ? 8 : 0) + (lh - size * 1.25) / 2,
            size,
            INK,
          ),
      }));
    }
    case 'horizontalRule':
      return [
        {
          h: 20,
          gap: 6,
          draw: (y) =>
            `<line x1="${n(x)}" y1="${n(y + 10)}" x2="${n(x + w)}" y2="${n(y + 10)}" stroke="${LINE_C}"/>`,
        },
      ];
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const out: Item[] = [];
      let i = 0;
      for (const item of node.content ?? []) {
        i++;
        const [first, ...rest] = item.content ?? [];
        const checked = item.attrs?.checked === true;
        const indent = 24;
        const lines =
          first?.type === 'paragraph'
            ? textItems(runsOf(first.content), x + indent, w - indent, 15, {
                fill: node.type === 'taskList' && checked ? MUTED : INK,
                strike: node.type === 'taskList' && checked,
              })
            : [];
        if (!lines.length) lines.push({ h: 22.5, gap: 0, draw: () => '' });
        const marker = lines[0]!;
        const kind = node.type;
        const num = i;
        const draw0 = marker.draw;
        out.push({
          ...marker,
          gap: out.length === 0 ? 6 : 2,
          draw: (y) => {
            const cy = y + marker.h / 2;
            let m: string;
            if (kind === 'taskList') {
              m =
                `<rect x="${n(x + 2)}" y="${n(cy - 7)}" width="14" height="14" rx="3" fill="${checked ? GREEN : 'none'}" stroke="${checked ? GREEN : MUTED}" stroke-width="1.5"/>` +
                (checked
                  ? `<path d="M${n(x + 5)} ${n(cy)} l3 3 l6 -6" fill="none" stroke="#fff" stroke-width="1.8"/>`
                  : '');
            } else if (kind === 'orderedList') {
              m = `<text x="${n(x)}" y="${n(cy + 5)}" font-family="${FONT}" font-size="15" fill="${MUTED}">${num}.</text>`;
            } else {
              m = `<circle cx="${n(x + 7)}" cy="${n(cy)}" r="${depth ? 2.5 : 3}" fill="${INK}"/>`;
            }
            return m + draw0(y);
          },
        });
        out.push(...lines.slice(1));
        for (const c of rest)
          out.push(...(await blockItems(c, x + indent, w - indent, embed, depth + 1)));
      }
      return out;
    }
    case 'boardEmbed': {
      const a = node.attrs ?? {};
      const img = await embed(String(a.board ?? ''), (a.frame as string | null) ?? null);
      const title = String(a.title ?? a.board ?? '');
      if (!img) {
        return [
          {
            h: 48,
            gap: 10,
            draw: (y) =>
              `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="48" rx="8" fill="#f1efe9" stroke="${LINE_C}"/>` +
              lineSvg([{ text: `Фрагмент доски: ${title}` }], x + 14, y + 13, 14, MUTED),
          },
        ];
      }
      const k = Math.min(w / img.w, 480 / img.h, 1.5);
      const iw = img.w * k;
      const ih = img.h * k;
      const href = `data:image/png;base64,${img.png.toString('base64')}`;
      return [
        {
          h: ih + 26,
          gap: 10,
          draw: (y) =>
            `<rect x="${n(x)}" y="${n(y)}" width="${n(iw)}" height="${n(ih)}" rx="6" fill="#f6f5f1" stroke="${LINE_C}"/>` +
            `<image x="${n(x)}" y="${n(y)}" width="${n(iw)}" height="${n(ih)}" href="${href}"/>` +
            lineSvg([{ text: title }], x, y + ih + 6, 13, MUTED),
        },
      ];
    }
    default: {
      const out: Item[] = [];
      for (const c of node.content ?? []) out.push(...(await blockItems(c, x, w, embed, depth)));
      return out;
    }
  }
}

/** Строки → страницы: разрыв там, где следующая строка не помещается. */
function paginate(
  items: readonly Item[],
  header: (page: number) => { h: number; svg: string },
): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  let y = 0;
  const start = (): void => {
    const hd = header(pages.length);
    page = [hd.svg];
    y = MARGIN + hd.h;
  };
  start();
  let first = true;
  for (const it of items) {
    const gap = first ? 0 : it.gap;
    if (y + gap + it.h > PAGE_H - MARGIN && !first) {
      pages.push(page);
      start();
      first = true;
    }
    y += first ? 0 : gap;
    page.push(it.draw(y));
    y += it.h;
    first = false;
  }
  pages.push(page);
  return pages;
}

function pageSvg(body: readonly string[], scale = 1): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W * scale}" height="${PAGE_H * scale}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">` +
    `<rect width="${PAGE_W}" height="${PAGE_H}" fill="#ffffff"/>` +
    body.join('') +
    '</svg>'
  );
}

const titleHeader = (title: string) => (page: number) => {
  if (page > 0) return { h: 0, svg: '' };
  const lines = wrapRuns([{ text: title, bold: true }], CONTENT_W, 30);
  const svg = lines.map((l, i) => lineSvg(l, MARGIN, MARGIN + i * 30 * 1.25, 30, INK)).join('');
  return { h: lines.length * 30 * 1.25 + 14, svg };
};

const noHeader = () => ({ h: 0, svg: '' });

/** Фрагмент доски картинкой — для документа. */
export function embedLoader(
  store: {
    has(id: string): Promise<boolean>;
    get(id: string): Promise<Y.Doc>;
    isDeleted?(id: string): Promise<boolean>;
  },
  assets: Parameters<typeof loadImages>[1],
): EmbedLoader {
  return async (board, frame) => {
    if (!board || !(await store.has(board)) || (await store.isDeleted?.(board))) return null;
    const doc = await store.get(board);
    const all = listElements(doc);
    let area;
    if (frame) {
      const f = getElement(doc, frame);
      if (!f || f.type !== 'frame') return null;
      area = contentArea([f]);
    } else area = contentArea(all);
    if (!area) return null;
    const padded = { x: area.x - 16, y: area.y - 16, w: area.w + 32, h: area.h + 32 };
    const { svg, width, height } = boardSvg(all, padded, {
      maxSize: 1200,
      images: await loadImages(all, assets),
    });
    return { png: renderPng(svg), w: width / 2, h: height / 2 };
  };
}

/** Страницы документа (SVG A4). */
export async function pagePages(
  doc: Y.Doc,
  embed: EmbedLoader,
  scale = 1,
  /** Без заголовка документа — для миниатюры (название и так на карточке). */
  noTitle = false,
): Promise<string[]> {
  const json = readPage(doc);
  const items: Item[] = [];
  for (const b of json.content ?? [])
    items.push(...(await blockItems(b, MARGIN, CONTENT_W, embed)));
  const title = getBoardName(doc) ?? 'Без названия';
  return paginate(items, noTitle ? noHeader : titleHeader(title)).map((p) => pageSvg(p, scale));
}

/** Ширины колонок: по самому длинному значению, вместе — по ширине страницы. */
function columnWidths(
  columns: readonly Column[],
  rows: ReturnType<typeof readTable>['rows'],
): number[] {
  const want = columns.map((c) => {
    if (c.type === 'checkbox') return 7;
    const longest = Math.max(
      c.name.length + 3,
      ...rows.slice(0, 200).map((r) => cellText(c, r.cells[c.id]).length),
    );
    return Math.min(28, Math.max(6, longest));
  });
  const total = want.reduce((s, v) => s + v, 0);
  return want.map((v) => (v / total) * CONTENT_W);
}

/** Страницы таблицы (SVG A4): шапка повторяется на каждой странице, внизу — итоги не нужны. */
export function tablePages(doc: Y.Doc, scale = 1, noTitle = false): string[] {
  const { columns, rows } = readTable(doc);
  const title = getBoardName(doc) ?? 'Без названия';
  const top = noTitle ? noHeader : titleHeader(title);
  if (!columns.length) return paginate([], top).map((p) => pageSvg(p, scale));
  const widths = columnWidths(columns, rows);
  const xs: number[] = [];
  widths.reduce((x, w) => (xs.push(x), x + w), MARGIN);
  const size = 13;
  const pad = 6;
  const head: Item = {
    h: size * 1.4 + pad * 2,
    gap: 0,
    draw: (y) =>
      `<rect x="${MARGIN}" y="${n(y)}" width="${CONTENT_W}" height="${n(size * 1.4 + pad * 2)}" fill="#f1efe9"/>` +
      columns
        .map((c, i) =>
          lineSvg(
            wrapRuns([{ text: c.name, bold: true }], widths[i]! - pad * 2, size)[0] ?? [],
            xs[i]! + pad,
            y + pad,
            size,
            INK,
          ),
        )
        .join(''),
  };
  const rowItems: Item[] = rows.map((r) => {
    const cells = columns.map((c, i) =>
      c.type === 'checkbox'
        ? []
        : wrapRuns([{ text: cellText(c, r.cells[c.id]) }], widths[i]! - pad * 2, size),
    );
    const lines = Math.max(1, ...cells.map((l) => l.length));
    const h = lines * size * 1.4 + pad * 2;
    return {
      h,
      gap: 0,
      draw: (y) =>
        `<line x1="${MARGIN}" y1="${n(y + h)}" x2="${MARGIN + CONTENT_W}" y2="${n(y + h)}" stroke="${LINE_C}"/>` +
        columns
          .map((c, i) => {
            const x = xs[i]! + pad;
            if (c.type === 'checkbox') {
              const on = r.cells[c.id] === true;
              const cx = xs[i]! + widths[i]! / 2;
              const cy = y + pad + (size * 1.4) / 2;
              return (
                `<rect x="${n(cx - 6)}" y="${n(cy - 6)}" width="12" height="12" rx="2.5" fill="${on ? GREEN : 'none'}" stroke="${on ? GREEN : MUTED}" stroke-width="1.3"/>` +
                (on
                  ? `<path d="M${n(cx - 3.5)} ${n(cy)} l2.5 2.5 l5 -5" fill="none" stroke="#fff" stroke-width="1.6"/>`
                  : '')
              );
            }
            const right = c.type === 'number';
            return cells[i]!.map((l, k) =>
              right
                ? lineSvg(
                    l,
                    xs[i]! + widths[i]! - pad,
                    y + pad + k * size * 1.4,
                    size,
                    INK,
                    ' text-anchor="end"',
                  )
                : lineSvg(l, x, y + pad + k * size * 1.4, size, c.type === 'url' ? ACCENT : INK),
            ).join('');
          })
          .join(''),
    };
  });
  const header = (page: number) => {
    const t = top(page);
    return { h: t.h + head.h, svg: t.svg + head.draw(MARGIN + t.h) };
  };
  return paginate(rowItems, header).map((p) => pageSvg(p, scale));
}

/** Миниатюра для карточки: верх первой страницы, в пропорции карточки (по умолчанию 320×200). */
export function thumbnailPng(firstPage: string, aspect = 320 / 200, width = 480): Buffer {
  const cropW = CONTENT_W + 32;
  const cropH = Math.min(PAGE_H, cropW / aspect);
  const svg = firstPage.replace(
    /width="[\d.]+" height="[\d.]+" viewBox="0 0 \d+ \d+"/,
    `width="${width}" height="${Math.round(width / aspect)}" viewBox="${MARGIN - 16} ${MARGIN - 16} ${cropW} ${n(cropH)}"`,
  );
  return renderPng(svg);
}
