/**
 * Удалённые доски (решение 0016): через 7 дней после удаления хаб стирает доску насовсем —
 * файл, корзину и соединения — и ставит в воркспейсе отметку purged (устройства сотрут свои копии).
 * До этого доска лежит на диске как была: «Вернуть» просто снимает отметку.
 */

import {
  DELETED_BOARD_KEEP_MS,
  WORKSPACE_ID,
  deletedBoards,
  markBoardPurged,
} from '@kayospace/board';
import type { BoardStore } from './store';

export const REAPER_ORIGIN = 'hub-reaper';

/** Стереть доски, удалённые больше 7 дней назад. Возвращает их id. */
export async function reapDeletedBoards(
  store: BoardStore,
  hooks: { purge(id: string): Promise<void> },
  now: number = Date.now(),
): Promise<string[]> {
  const ws = await store.get(WORKSPACE_ID);
  const due = [...deletedBoards(ws)]
    .filter(([, d]) => !d.purged && now - d.at >= DELETED_BOARD_KEEP_MS)
    .map(([id]) => id);
  for (const id of due) {
    await hooks.purge(id);
    await store.purge(id);
    markBoardPurged(ws, id, REAPER_ORIGIN);
  }
  // Стёртую доску могло снова прислать устройство, которое долго было без сети, — стираем ещё раз.
  for (const [id, d] of deletedBoards(ws)) {
    if (d.purged && (await store.has(id))) {
      await hooks.purge(id);
      await store.purge(id);
    }
  }
  return due;
}
