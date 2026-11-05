/**
 * Файлы .md (решение 0023): импорт — документом с карточкой на доске, экспорт — файлом.
 */

import { getBoardName, setBoardName } from '@kayospace/board';
import { markdownTitle, pageFileMarkdown, stripFrontmatter, writePage } from '@kayospace/page';
import type * as Y from 'yjs';
import { BoardSession } from './session';
import type { Hub } from './devices';

export const MARKDOWN_ACCEPT = '.md,.markdown,text/markdown';

export function isMarkdown(f: { name: string; type: string }): boolean {
  return (
    /\.(md|markdown)$/i.test(f.name) || f.type === 'text/markdown' || f.type === 'text/x-markdown'
  );
}

export function markdownFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && isMarkdown(file)) out.push(file);
  }
  return out;
}

/** Название и тело документа из текста .md (название — из frontmatter, заголовка или имени файла). */
export function parseMarkdownFile(name: string, text: string): { title: string; body: string } {
  const title = markdownTitle(text) ?? (name.replace(/\.(md|markdown)$/i, '').trim() || 'Документ');
  const { body } = stripFrontmatter(text);
  // Первый заголовок, совпадающий с названием, не дублируем в теле.
  const h = /^#\s+(.+?)\s*#*\s*\n+/.exec(body.trimStart());
  const rest =
    h && h[1]!.replace(/[*_`~]/g, '') === title ? body.trimStart().slice(h[0].length) : body;
  return { title, body: rest };
}

/**
 * Записать в документ, который сейчас не открыт: своя сессия — дождаться локальной копии,
 * правка, дождаться хаба (если он есть) — и закрыть.
 */
export async function writeOffscreen(
  id: string,
  hub: Hub | null,
  apply: (doc: Y.Doc) => void,
): Promise<void> {
  const s = new BoardSession(id, hub);
  const until = (ok: () => boolean, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (ok()) return resolve();
      const t = setTimeout(done, ms);
      const stop = s.subscribe(() => ok() && done());
      function done(): void {
        clearTimeout(t);
        stop();
        resolve();
      }
    });
  try {
    await until(() => s.getState().loaded, 5000);
    apply(s.doc);
    if (hub) await until(() => s.getState().sync === 'synced', 6000);
    // Локальная копия (IndexedDB) пишется асинхронно — даём ей закончить.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    s.destroy();
  }
}

/** Документ из .md: новый id «pg_…», название и содержимое. */
export async function importMarkdown(
  id: string,
  file: File,
  hub: Hub | null,
): Promise<{ title: string }> {
  const { title, body } = parseMarkdownFile(file.name, await file.text());
  await writeOffscreen(id, hub, (doc) => {
    doc.transact(() => {
      setBoardName(doc, title);
      writePage(doc, body, 'replace');
    });
  });
  return { title };
}

/** Документ в .md: из открытого Yjs-документа. */
export function markdownOf(doc: Y.Doc, fallback: string): string {
  return pageFileMarkdown(doc, getBoardName(doc) ?? fallback);
}
