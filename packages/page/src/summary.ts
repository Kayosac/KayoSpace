/**
 * Карточка документа или таблицы на доске (решение 0021): что на ней написано — первые строки
 * документа или колонки и число строк таблицы. Название — из метаданных документа (как у доски).
 */

import type * as Y from 'yjs';
import { artifactExcerpt, isArtifactId, readArtifact } from './artifact';
import { isTableId, readTable } from './table';
import { isPageId, pageExcerpt } from './yjs';

export type DocKind = 'page' | 'table' | 'artifact';

/** Что за документ по id: «pg_» — страница, «tb_» — таблица, «ar_» — артефакт, иначе — не документ. */
export function docKind(id: string): DocKind | null {
  return isPageId(id) ? 'page' : isTableId(id) ? 'table' : isArtifactId(id) ? 'artifact' : null;
}

/** Документ или таблица — то, что открывается не холстом. */
export const isDocId = (id: string): boolean => docKind(id) !== null;

export function tableExcerpt(doc: Y.Doc): string {
  const { columns, rows } = readTable(doc);
  if (!columns.length) return 'Пустая таблица';
  const n = rows.length;
  const word =
    n % 10 === 1 && n % 100 !== 11
      ? 'строка'
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
        ? 'строки'
        : 'строк';
  return `${n} ${word} · ${columns.map((c) => c.name).join(', ')}`.slice(0, 240);
}

export function docExcerpt(id: string, doc: Y.Doc): string {
  const kind = docKind(id);
  if (kind === 'table') return tableExcerpt(doc);
  if (kind === 'artifact') return artifactExcerpt(readArtifact(doc));
  return pageExcerpt(doc);
}
