/** Корзина доски на хабе (решение 0016): удалённое за 7 дней и «Вернуть». */

import { hubCall, type Hub } from './devices';

export interface TrashGroup {
  at: number;
  by: 'agent' | 'device';
  ids: string[];
  preview: string;
}

export async function listTrash(hub: Hub, board: string): Promise<TrashGroup[]> {
  const r = await hubCall<{ groups: TrashGroup[] }>(
    fetch,
    hub.url,
    `/api/trash/${encodeURIComponent(board)}`,
    {
      token: hub.token,
    },
  );
  return r.groups ?? [];
}

export async function restoreTrash(hub: Hub, board: string, ids: string[]): Promise<number> {
  const r = await hubCall<{ restored: number }>(
    fetch,
    hub.url,
    `/api/trash/${encodeURIComponent(board)}/restore`,
    { method: 'POST', token: hub.token, body: { ids } },
  );
  return r.restored;
}

/** «сегодня в 14:05», «вчера в 09:12», «3 ноября в 18:40». */
export function trashTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return `сегодня в ${time}`;
  if (day(at) === day(now - 86_400_000)) return `вчера в ${time}`;
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}`;
}
