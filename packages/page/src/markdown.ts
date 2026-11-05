/**
 * Страница ↔ markdown (решение 0020): так страницу читают и пишут агенты. Поддержаны блоки
 * редактора: заголовки (#…###), абзацы, списки (- и 1.), чек-листы (- [ ] / - [x]), цитаты (>),
 * код (```), разделитель (---) и фрагмент доски — строка `[[board:<доска>#<фрейм>|Название]]`.
 * Внутри строк — **жирный**, *курсив*, `код`, ~~зачёркнутый~~ и [ссылки](https://…).
 */

import type { JSONContent } from '@tiptap/core';

type Mark = { type: string; attrs?: Record<string, unknown> };

// ---------- в markdown ----------

function inlineToMd(nodes: readonly JSONContent[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type !== 'text') return '';
      let t = n.text ?? '';
      const marks = (n.marks ?? []) as Mark[];
      const has = (m: string) => marks.some((x) => x.type === m);
      if (has('code')) t = `\`${t}\``;
      if (has('bold')) t = `**${t}**`;
      if (has('italic')) t = `*${t}*`;
      if (has('strike')) t = `~~${t}~~`;
      const link = marks.find((x) => x.type === 'link');
      if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href)})`;
      return t;
    })
    .join('');
}

function blockToMd(n: JSONContent, indent = ''): string[] {
  switch (n.type) {
    case 'heading':
      return [`${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inlineToMd(n.content)}`];
    case 'paragraph':
      return [indent + inlineToMd(n.content)];
    case 'blockquote':
      return (n.content ?? []).flatMap((c) => blockToMd(c)).map((l) => `> ${l}`);
    case 'codeBlock':
      return ['```' + (n.attrs?.language ?? ''), inlineToMd(n.content), '```'];
    case 'horizontalRule':
      return ['---'];
    case 'boardEmbed': {
      const a = n.attrs ?? {};
      return [`[[board:${a.board}${a.frame ? `#${a.frame}` : ''}${a.title ? `|${a.title}` : ''}]]`];
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (n.content ?? []).flatMap((item, i) => {
        const [first, ...rest] = item.content ?? [];
        const marker =
          n.type === 'orderedList'
            ? `${i + 1}.`
            : n.type === 'taskList'
              ? `- [${item.attrs?.checked ? 'x' : ' '}]`
              : '-';
        const head = `${indent}${marker} ${first ? inlineToMd(first.content) : ''}`;
        const nested = rest.flatMap((c) => blockToMd(c, `${indent}  `));
        return [head, ...nested];
      });
    default:
      return n.content ? n.content.flatMap((c) => blockToMd(c, indent)) : [];
  }
}

export function pageToMarkdown(doc: JSONContent): string {
  const out: string[] = [];
  for (const block of doc.content ?? []) {
    const lines = blockToMd(block);
    if (lines.length === 0) continue;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n').trim();
}

// ---------- из markdown ----------

/** Строка с разметкой → текстовые узлы с марками. */
export function inlineFromMd(src: string): JSONContent[] {
  const out: JSONContent[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  const push = (text: string, marks?: Mark[]) => {
    if (!text) return;
    out.push({ type: 'text', text, ...(marks?.length ? { marks } : {}) });
  };
  for (const m of src.matchAll(re)) {
    push(src.slice(last, m.index));
    if (m[2]) push(m[2], [{ type: 'bold' }]);
    else if (m[3]) push(m[3], [{ type: 'italic' }]);
    else if (m[4]) push(m[4], [{ type: 'code' }]);
    else if (m[5]) push(m[5], [{ type: 'strike' }]);
    else if (m[6] && /^https?:\/\//.test(m[7]!))
      push(m[6], [{ type: 'link', attrs: { href: m[7] } }]);
    else push(m[0]);
    last = m.index! + m[0].length;
  }
  push(src.slice(last));
  return out;
}

const para = (text: string): JSONContent => {
  const content = inlineFromMd(text);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

export function markdownToPage(md: string): JSONContent {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: JSONContent[] = [];
  let i = 0;
  const listItem = (kind: 'bullet' | 'ordered' | 'task', line: string): JSONContent => {
    if (kind === 'task') {
      const m = /^\s*[-*] \[( |x|X)\] ?(.*)$/.exec(line)!;
      return { type: 'taskItem', attrs: { checked: m[1] !== ' ' }, content: [para(m[2]!)] };
    }
    const text = line.replace(/^\s*(?:[-*]|\d+\.) /, '');
    return { type: 'listItem', content: [para(text)] };
  };
  const kindOf = (line: string): 'bullet' | 'ordered' | 'task' | null =>
    /^\s*[-*] \[( |x|X)\]/.test(line)
      ? 'task'
      : /^\s*[-*] /.test(line)
        ? 'bullet'
        : /^\s*\d+\. /.test(line)
          ? 'ordered'
          : null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      blocks.push({
        type: 'heading',
        attrs: { level: h[1]!.length },
        content: inlineFromMd(h[2]!),
      });
      i++;
      continue;
    }
    const embed = /^\[\[board:([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?(?:\|(.+))?\]\]$/.exec(
      line.trim(),
    );
    if (embed) {
      blocks.push({
        type: 'boardEmbed',
        attrs: { board: embed[1], frame: embed[2] ?? null, title: embed[3] ?? null },
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push({
        type: 'codeBlock',
        attrs: { language: lang || null },
        ...(body.length ? { content: [{ type: 'text', text: body.join('\n') }] } : {}),
      });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>'))
        body.push(lines[i++]!.replace(/^> ?/, ''));
      blocks.push({
        type: 'blockquote',
        content: markdownToPage(body.join('\n')).content ?? [para('')],
      });
      continue;
    }
    const kind = kindOf(line);
    if (kind) {
      const items: JSONContent[] = [];
      while (i < lines.length && kindOf(lines[i]!) === kind)
        items.push(listItem(kind, lines[i++]!));
      blocks.push({
        type: kind === 'task' ? 'taskList' : kind === 'ordered' ? 'orderedList' : 'bulletList',
        content: items,
      });
      continue;
    }
    // Абзац — подряд идущие строки.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !kindOf(lines[i]!) &&
      !/^(#{1,3} |>|```)/.test(lines[i]!)
    )
      body.push(lines[i++]!.trim());
    blocks.push(para(body.join(' ')));
  }
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}
