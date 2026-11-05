/**
 * Поиск текста по всем доскам (решение 0012): стикеры, тексты, подписи фигур и стрелок,
 * названия фреймов, подписи картинок, распознанное рукописное. Регистр не важен. Нужен и MCP (инструмент search),
 * и приложению (GET /api/search?q=…).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { elementText, listElements } from '@kayospace/board';
import { isPageId, pageMarkdown } from '@kayospace/page';
import type * as Y from 'yjs';
import { json } from './devices-api';

export interface SearchHit {
  board: string;
  boardName: string | null;
  id: string;
  type: string;
  text: string;
}

/** Совпадения: сначала те, где запрос — начало слова, потом остальные; не больше limit. */
export async function searchBoards(
  store: {
    list(): Promise<{ id: string; name: string | null }[]>;
    get(id: string): Promise<Y.Doc>;
  },
  query: string,
  limit = 50,
  /** Распознанное рукописное (решение 0018) — тоже ищется; попадание ведёт к первому штриху группы. */
  handwriting?: { entries(board: string): Promise<{ ids: string[]; text: string }[]> } | null,
): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const word: SearchHit[] = [];
  const rest: SearchHit[] = [];
  for (const info of await store.list()) {
    const doc = await store.get(info.id);
    // Документ (решение 0020): ищем по строкам страницы.
    if (isPageId(info.id)) {
      for (const line of pageMarkdown(doc).split('\n')) {
        const t = line.replace(/^(#{1,3}|>|[-*]( \[[ xX]\])?|\d+\.)\s+/, '').trim();
        const low = t.toLowerCase();
        const at = low.indexOf(q);
        if (!t || at < 0) continue;
        const hit = { board: info.id, boardName: info.name, id: '', type: 'page', text: t };
        (at === 0 || /[\s.,;:!?()«»"'-]/.test(low[at - 1]!) ? word : rest).push(hit);
      }
      continue;
    }
    for (const el of listElements(doc)) {
      const t = elementText(el);
      const low = t.toLowerCase();
      const at = low.indexOf(q);
      if (at < 0) continue;
      const hit = { board: info.id, boardName: info.name, id: el.id, type: el.type, text: t };
      (at === 0 || /[\s.,;:!?()«»"'-]/.test(low[at - 1]!) ? word : rest).push(hit);
    }
    for (const e of handwriting ? await handwriting.entries(info.id) : []) {
      const low = e.text.toLowerCase();
      const at = low.indexOf(q);
      if (at < 0) continue;
      const hit = {
        board: info.id,
        boardName: info.name,
        id: e.ids[0]!,
        type: 'handwriting',
        text: e.text,
      };
      (at === 0 || /[\s.,;:!?()«»"'-]/.test(low[at - 1]!) ? word : rest).push(hit);
    }
  }
  return [...word, ...rest].slice(0, limit);
}

/** GET /api/search?q=… — false, если адрес не наш. */
export async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Parameters<typeof searchBoards>[0],
  handwriting?: Parameters<typeof searchBoards>[3],
): Promise<boolean> {
  if (url.pathname !== '/api/search' || req.method !== 'GET') return false;
  const q = (url.searchParams.get('q') ?? '').slice(0, 200);
  json(res, 200, {
    hits: q.trim().length >= 2 ? await searchBoards(store, q, 50, handwriting) : [],
  });
  return true;
}
