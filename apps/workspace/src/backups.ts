/** Резервные копии досок на хабе: список и восстановление доски копией рядом с исходной. */

import { hubCall, HubError, type Hub } from './devices';

export interface BackupBoard {
  id: string;
  name: string | null;
  elements: number;
}

export interface BackupInfo {
  id: string;
  at: number;
  boards: BackupBoard[];
}

export async function listBackups(hub: Hub, f: typeof fetch = fetch): Promise<BackupInfo[]> {
  try {
    const r = await hubCall<{ backups: BackupInfo[] }>(f, hub.url, '/api/backups', {
      token: hub.token,
    });
    return r.backups;
  } catch (err) {
    if (err instanceof HubError && err.status === 404) {
      throw new HubError('Хаб пока не делает резервные копии — обновите хаб', 404);
    }
    throw err;
  }
}

export function restoreBoard(
  hub: Hub,
  backup: string,
  board: string,
  f: typeof fetch = fetch,
): Promise<{ id: string; name: string }> {
  return hubCall(f, hub.url, `/api/backups/${encodeURIComponent(backup)}/restore`, {
    method: 'POST',
    token: hub.token,
    body: { board },
  });
}

/** «5 ноября, 03:00». */
export function backupTime(at: number): string {
  return new Date(at).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
