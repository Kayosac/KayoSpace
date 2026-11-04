/** Список досок: недавние на устройстве + доски с хаба. */

import type { RecentBoard } from './settings';

export interface BoardEntry {
  id: string;
  name: string | null;
  /** Сколько элементов (известно только у досок с хаба). */
  elements?: number;
  onHub: boolean;
}

/** Склеить доски с хаба и недавние на этом устройстве: недавние — первыми. */
export function mergeBoards(
  recent: readonly RecentBoard[],
  hub: readonly { id: string; name: string | null; elements: number }[],
): BoardEntry[] {
  const byId = new Map<string, BoardEntry>();
  for (const r of recent) {
    // Служебные документы (воркспейс) — не доски.
    if (!r.id.startsWith('_')) byId.set(r.id, { id: r.id, name: r.name, onHub: false });
  }
  for (const h of hub) {
    if (h.id.startsWith('_')) continue;
    const prev = byId.get(h.id);
    byId.set(h.id, {
      id: h.id,
      name: h.name ?? prev?.name ?? null,
      elements: h.elements,
      onHub: true,
    });
  }
  return [...byId.values()];
}

export function matchesQuery(b: BoardEntry, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (b.name ?? '').toLowerCase().includes(s) || b.id.toLowerCase().includes(s);
}
