/**
 * Страница ↔ markdown (решения 0020, 0023): так страницу читают и пишут агенты, так документы
 * импортируются из .md и экспортируются в .md. Туда и обратно без потерь:
 * заголовки (# … ######), абзацы, списки любой вложенности (-, 1.), чек-листы (- [ ] / - [x]),
 * цитаты (>, в том числе вложенные блоки), код (``` с языком), разделитель (---), таблицы (GFM),
 * картинки (![подпись](адрес)) и фрагмент доски — строка `[[board:<доска>#<фрейм>|Название]]`.
 * Внутри строк — **жирный**, *курсив*, `код`, ~~зачёркнутый~~ и [ссылки](https://…).
 */

import type { JSONContent } from '@tiptap/core';

type Mark = { type: string; attrs?: Record<string, unknown> };

// ---------- в markdown ----------

/** Символы разметки в обычном тексте экранируем, чтобы при чтении обратно они не стали разметкой. */
const escapeText = (t: string): string =>
  t
    .replace(/([\\*`[\]])/g, '\\$1')
    .replace(/~~/g, '\\~\\~')
    // «_» внутри слова (snake_case) разметкой не бывает — его не трогаем.
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (m) => m.replace('_', '\\_'));

/**
 * Строка с марками → markdown. Марки открываются и закрываются по ходу текста, а не у каждого
 * куска: «**жирный [ссылка](…)**» остаётся одним жирным отрезком со ссылкой внутри.
 */
function inlineToMd(nodes: readonly JSONContent[] = [], opts: { cell?: boolean } = {}): string {
  const ORDER = ['link', 'bold', 'italic', 'strike', 'underline'];
  const open: Mark[] = [];
  let out = '';
  const opener = (m: Mark): string =>
    m.type === 'link'
      ? '['
      : m.type === 'bold'
        ? '**'
        : m.type === 'italic'
          ? '*'
          : m.type === 'underline'
            ? '<u>'
            : '~~';
  const closer = (m: Mark): string =>
    m.type === 'link'
      ? `](${String(m.attrs?.href ?? '')})`
      : m.type === 'underline'
        ? '</u>'
        : opener(m);
  const same = (a: Mark, b: Mark): boolean =>
    a.type === b.type && (a.type !== 'link' || a.attrs?.href === b.attrs?.href);
  const closeFrom = (k: number): void => {
    while (open.length > k) out += closer(open.pop()!);
  };
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      closeFrom(0);
      out += opts.cell ? '<br>' : '  \n';
      continue;
    }
    if (n.type === 'image') {
      closeFrom(0);
      out += imageMd(n);
      continue;
    }
    if (n.type !== 'text') continue;
    const marks = ((n.marks ?? []) as Mark[])
      .filter((m) => ORDER.includes(m.type))
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    // Оставляем открытыми общие с предыдущим куском марки (по порядку), остальные закрываем.
    let keep = 0;
    while (keep < open.length && marks.some((m) => same(m, open[keep]!))) keep++;
    closeFrom(keep);
    for (const m of marks) {
      if (open.some((o) => same(o, m))) continue;
      open.push(m);
      out += opener(m);
    }
    const code = (n.marks ?? []).some((m) => m.type === 'code');
    let t = code ? `\`${n.text ?? ''}\`` : escapeText(n.text ?? '');
    if (opts.cell) t = t.replace(/\|/g, '\\|');
    out += t;
  }
  closeFrom(0);
  return out;
}

function imageMd(n: JSONContent): string {
  const a = n.attrs ?? {};
  const alt = String(a.alt ?? '').replace(/[[\]]/g, '');
  const title = a.title ? ` "${String(a.title).replace(/"/g, "'")}"` : '';
  return `![${alt}](${String(a.src ?? '')}${title})`;
}

/** Текст ячейки таблицы: абзацы ячейки — через <br>. */
function cellMd(cell: JSONContent): string {
  return (cell.content ?? [])
    .map((p) => inlineToMd(p.content, { cell: true }))
    .join('<br>')
    .trim();
}

function tableMd(n: JSONContent): string[] {
  const rows = n.content ?? [];
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => (r.content ?? []).length), 1);
  const row = (r: JSONContent): string => {
    const cells = (r.content ?? []).map(cellMd);
    while (cells.length < width) cells.push('');
    return `| ${cells.join(' | ')} |`;
  };
  return [row(rows[0]!), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(row)];
}

function blockToMd(n: JSONContent): string[] {
  switch (n.type) {
    case 'heading':
      return [
        `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inlineToMd(n.content)}`,
      ];
    case 'paragraph':
      return inlineToMd(n.content).split('\n');
    case 'blockquote':
      return blocksToLines(n.content ?? []).map((l) => (l ? `> ${l}` : '>'));
    case 'codeBlock': {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('');
      const fence = text.includes('```') ? '~~~' : '```';
      return [fence + (n.attrs?.language ?? ''), ...text.split('\n'), fence];
    }
    case 'horizontalRule':
      return ['---'];
    case 'image':
      return [imageMd(n)];
    case 'table':
      return tableMd(n);
    case 'boardEmbed': {
      const a = n.attrs ?? {};
      return [`[[board:${a.board}${a.frame ? `#${a.frame}` : ''}${a.title ? `|${a.title}` : ''}]]`];
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(n.attrs?.start ?? 1);
      return (n.content ?? []).flatMap((item, i) => {
        const [first, ...rest] = item.content ?? [];
        const marker =
          n.type === 'orderedList'
            ? `${start + i}.`
            : n.type === 'taskList'
              ? `- [${item.attrs?.checked ? 'x' : ' '}]`
              : '-';
        const pad = ' '.repeat(n.type === 'orderedList' ? marker.length + 1 : 2);
        const firstLines = first?.type === 'paragraph' ? inlineToMd(first.content).split('\n') : [];
        const blocks = first?.type === 'paragraph' ? rest : (item.content ?? []);
        const head = `${marker} ${firstLines[0] ?? ''}`.trimEnd();
        const more = firstLines.slice(1).map((l) => pad + l);
        // Вложенное: подсписки — без пустой строки, остальные блоки — через пустую строку.
        const nested = blocks.flatMap((c, k) => {
          const lines = blockToMd(c).map((l) => (l ? pad + l : l));
          const isList = /List$/.test(c.type ?? '');
          return isList && k === 0 ? lines : ['', ...lines];
        });
        return [head, ...more, ...nested];
      });
    }
    default:
      return n.content ? blocksToLines(n.content) : [];
  }
}

/** Блоки → строки: между блоками — пустая строка. */
function blocksToLines(blocks: readonly JSONContent[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const lines = blockToMd(b);
    if (!lines.length) continue;
    if (out.length) out.push('');
    out.push(...lines);
  }
  return out;
}

export function pageToMarkdown(doc: JSONContent): string {
  return blocksToLines(doc.content ?? [])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- из markdown ----------

const INLINE_RE =
  /(\\([\\*_`~[\]|]))|(`([^`]+)`)|(\*\*([^*]+?)\*\*|(?<![\p{L}\p{N}])__([^_]+?)__(?![\p{L}\p{N}]))|(~~([^~]+?)~~)|(\*([^*\s][^*]*?)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*?)_(?![\p{L}\p{N}]))|(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(\[([^\]]+)\]\(([^)\s]+)\))|(<br\s*\/?>)|(<u>(.+?)<\/u>)/gu;

/** Строка с разметкой → текстовые узлы с марками (марки вкладываются: **[ссылка](…)** и т. п.). */
export function inlineFromMd(src: string, marks: Mark[] = []): JSONContent[] {
  const out: JSONContent[] = [];
  const push = (text: string, m: Mark[] = marks) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Соседние куски с теми же марками — одним узлом.
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(m)) {
      last.text = (last.text ?? '') + text;
      return;
    }
    out.push({ type: 'text', text, ...(m.length ? { marks: m } : {}) });
  };
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    push(src.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1]) push(m[2]!);
    else if (m[3]) push(m[4]!, [...marks, { type: 'code' }]);
    else if (m[5]) out.push(...inlineFromMd(m[6] ?? m[7]!, [...marks, { type: 'bold' }]));
    else if (m[8]) out.push(...inlineFromMd(m[9]!, [...marks, { type: 'strike' }]));
    else if (m[10]) out.push(...inlineFromMd(m[11] ?? m[12]!, [...marks, { type: 'italic' }]));
    else if (m[13])
      push(m[0]); // картинка посреди строки — оставляем текстом
    else if (m[16]) {
      if (/^(https?:|mailto:|kayospace:)/.test(m[18]!))
        out.push(...inlineFromMd(m[17]!, [...marks, { type: 'link', attrs: { href: m[18] } }]));
      else push(m[0]);
    } else if (m[19]) out.push({ type: 'hardBreak' });
    else if (m[20]) out.push(...inlineFromMd(m[21]!, [...marks, { type: 'underline' }]));
  }
  push(src.slice(last));
  return out;
}

const para = (text: string): JSONContent => {
  const parts = text.split(/ {2,}\n|\\\n/);
  const content: JSONContent[] = [];
  parts.forEach((p, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...inlineFromMd(p.replace(/\n/g, ' ')));
  });
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const EMBED = /^\[\[board:([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?(?:\|(.+))?\]\]$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Ячейки строки таблицы: «| a | b |» → [a, b] (экранированный «\|» — внутри ячейки). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function tableNode(rows: string[][]): JSONContent {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (text: string, header: boolean): JSONContent => ({
    type: header ? 'tableHeader' : 'tableCell',
    content: text.split(/<br\s*\/?>/).map((p) => para(p.replace(/\\\|/g, '|'))),
  });
  return {
    type: 'table',
    content: rows.map((r, i) => {
      const cells = [...r];
      while (cells.length < width) cells.push('');
      return { type: 'tableRow', content: cells.map((c) => cell(c, i === 0)) };
    }),
  };
}

const indentOf = (l: string): number => /^ */.exec(l)![0].length;

/** Строки → блоки (рекурсивно для цитат и списков). */
function parseBlocks(lines: string[]): JSONContent[] {
  const blocks: JSONContent[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(mark)) body.push(lines[i++]!);
      i++;
      blocks.push({
        type: 'codeBlock',
        attrs: { language: fence[2] || null },
        ...(body.length ? { content: [{ type: 'text', text: body.join('\n') }] } : {}),
      });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const content = inlineFromMd(h[2]!);
      blocks.push({
        type: 'heading',
        attrs: { level: h[1]!.length },
        ...(content.length ? { content } : {}),
      });
      i++;
      continue;
    }
    const embed = EMBED.exec(line.trim());
    if (embed) {
      blocks.push({
        type: 'boardEmbed',
        attrs: { board: embed[1], frame: embed[2] ?? null, title: embed[3] ?? null },
      });
      i++;
      continue;
    }
    const img = IMAGE.exec(line.trim());
    if (img) {
      blocks.push({
        type: 'image',
        attrs: { src: img[2], alt: img[1] || null, title: img[3] ?? null },
      });
      i++;
      continue;
    }
    if (HR.test(line) && !LIST.exec(line)?.[3]) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'))
        rows.push(splitRow(lines[i++]!));
      blocks.push(tableNode(rows));
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^ {0,3}> ?/, ''));
      const inner = parseBlocks(body);
      blocks.push({ type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const r = parseList(lines, i);
      blocks.push(...r.blocks);
      i = r.next;
      continue;
    }
    // Абзац — подряд идущие строки, пока не начнётся другой блок.
    const body: string[] = [
      line.endsWith('  ') || line.endsWith('\\') ? line.trimStart() : line.trim(),
    ];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        !l.trim() ||
        FENCE.test(l) ||
        HEADING.test(l) ||
        /^ {0,3}>/.test(l) ||
        LIST.test(l) ||
        EMBED.test(l.trim()) ||
        IMAGE.test(l.trim()) ||
        HR.test(l) ||
        (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!))
      )
        break;
      body.push(l.endsWith('  ') || l.endsWith('\\') ? l : l.trim());
      i++;
    }
    blocks.push(para(body.join('\n')));
  }
  return blocks;
}

type ListKind = 'bulletList' | 'orderedList' | 'taskList';

/** Список с вложенностью: подряд идущие пункты одного вида и отступа. */
function parseList(lines: string[], from: number): { blocks: JSONContent[]; next: number } {
  const first = LIST.exec(lines[from]!)!;
  const base = first[1]!.length;
  const kindOf = (m: RegExpExecArray): ListKind =>
    /^\d/.test(m[2]!) ? 'orderedList' : /^\[( |x|X)\]( |$)/.test(m[3]!) ? 'taskList' : 'bulletList';
  const blocks: JSONContent[] = [];
  let i = from;
  let current: { kind: ListKind; items: JSONContent[]; start: number } | null = null;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]!);
    if (!m || m[1]!.length !== base) {
      // Пустая строка, за которой идёт пункт того же уровня, — список продолжается.
      if (!lines[i]!.trim()) {
        let j = i;
        while (j < lines.length && !lines[j]!.trim()) j++;
        const n = j < lines.length ? LIST.exec(lines[j]!) : null;
        if (n && n[1]!.length === base) {
          i = j;
          continue;
        }
      }
      break;
    }
    const kind = kindOf(m);
    if (!current || current.kind !== kind) {
      if (current) blocks.push(listNode(current));
      current = { kind, items: [], start: kind === 'orderedList' ? parseInt(m[2]!, 10) : 1 };
    }
    // Отступ содержимого пункта: после маркера и пробела.
    const contentIndent = base + m[2]!.length + 1;
    let text = m[3]!;
    let checked = false;
    if (kind === 'taskList') {
      checked = /^\[(x|X)\]/.test(text);
      text = text.replace(/^\[( |x|X)\] ?/, '');
    }
    const body: string[] = [text];
    i++;
    // Продолжение пункта: строки с отступом больше базового (и пустые между ними).
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        let j = i;
        while (j < lines.length && !lines[j]!.trim()) j++;
        if (j < lines.length && indentOf(lines[j]!) > base) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) <= base) break;
      body.push(l.slice(Math.min(indentOf(l), Math.max(contentIndent, base + 2))));
      i++;
    }
    // Первая строка (и её продолжение до вложенного блока) — абзац пункта, остальное — блоки.
    let k = 1;
    while (k < body.length && body[k]!.trim() && !LIST.test(body[k]!) && !FENCE.test(body[k]!)) k++;
    const firstPara = para(body.slice(0, k).join('\n'));
    const rest = parseBlocks(body.slice(k));
    const content = [firstPara, ...rest];
    current.items.push(
      kind === 'taskList'
        ? { type: 'taskItem', attrs: { checked }, content }
        : { type: 'listItem', content },
    );
  }
  if (current) blocks.push(listNode(current));
  return { blocks, next: i };
}

function listNode(l: { kind: ListKind; items: JSONContent[]; start: number }): JSONContent {
  return {
    type: l.kind,
    ...(l.kind === 'orderedList' && l.start !== 1 ? { attrs: { start: l.start } } : {}),
    content: l.items,
  };
}

/** Заголовок файла .md (frontmatter) убираем: название документа берётся отдельно. */
export function stripFrontmatter(md: string): { body: string; title: string | null } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { body: md, title: null };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { body: md.slice(m[0].length), title: t ? t[1]! : null };
}

export function markdownToPage(md: string): JSONContent {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = parseBlocks(lines);
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

/** Название из файла .md: заголовок frontmatter, иначе первый заголовок первого уровня. */
export function markdownTitle(md: string): string | null {
  const { body, title } = stripFrontmatter(md);
  if (title) return title;
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return h ? h[1]!.replace(/[*_`~]/g, '') : null;
}
