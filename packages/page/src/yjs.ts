/**
 * Страница в Yjs (решение 0020): содержимое — Y.XmlFragment «page» того же документа, что и у доски
 * (синхронизация, хранение, корзина досок, проекты — общие). id страницы начинается с «pg_» —
 * так её видно по id сразу, ещё до загрузки (у досок «_» в id не бывает).
 */

import type { JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { markdownToPage, pageToMarkdown } from './markdown';
import { pageSchema } from './schema';

export const PAGE_FIELD = 'page';
export const PAGE_PREFIX = 'pg_';

export const isPageId = (id: string): boolean => id.startsWith(PAGE_PREFIX);

/** id новой страницы из названия: «pg_» + как у доски. */
export function pageIdFrom(boardLikeId: string): string {
  return `${PAGE_PREFIX}${boardLikeId}`.slice(0, 64);
}

export function readPage(doc: Y.Doc): JSONContent {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(PAGE_FIELD)) as JSONContent;
  return json.content?.length ? json : { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function pageMarkdown(doc: Y.Doc): string {
  return pageToMarkdown(readPage(doc));
}

/** Записать страницу: replace — целиком (меняется только отличающееся), append — в конец. */
export function writePage(
  doc: Y.Doc,
  markdown: string,
  mode: 'replace' | 'append' = 'replace',
  origin?: unknown,
): void {
  const add = markdownToPage(markdown);
  const next: JSONContent =
    mode === 'append'
      ? {
          type: 'doc',
          content: [
            ...(readPage(doc).content ?? []).filter(
              (b, i, all) => !(all.length === 1 && b.type === 'paragraph' && !b.content),
            ),
            ...(add.content ?? []),
          ],
        }
      : add;
  doc.transact(() => {
    prosemirrorJSONToYXmlFragment(pageSchema(), next, doc.getXmlFragment(PAGE_FIELD));
  }, origin);
}

/** Текст страницы одной строкой — для поиска. */
export function pageText(doc: Y.Doc): string {
  const walk = (n: JSONContent): string =>
    n.type === 'text'
      ? (n.text ?? '')
      : (n.content ?? []).map(walk).join(n.type === 'doc' ? '\n' : ' ');
  return walk(readPage(doc)).trim();
}

/** Начало документа для карточки на доске: первые строки текста без разметки. */
export function pageExcerpt(doc: Y.Doc, maxLines = 4, maxChars = 240): string {
  const lines: string[] = [];
  for (const raw of pageMarkdown(doc).split('\n')) {
    if (lines.length >= maxLines) break;
    if (/^\[\[board:/.test(raw) || /^(```|---)/.test(raw)) continue;
    const t = raw
      .replace(/^(#{1,3}|>)\s+/, '')
      .replace(/^[-*] \[[ xX]\] /, (m) => (/x/i.test(m) ? '☑ ' : '☐ '))
      .replace(/^[-*] /, '• ')
      .replace(/\*\*|~~|`/g, '')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (t) lines.push(t);
  }
  const s = lines.join('\n');
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}
