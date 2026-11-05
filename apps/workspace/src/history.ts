/** История версий доски на хабе (решение 0018). */

import { hubHttpUrl } from '@kayospace/sync';
import { hubCall, type Hub } from './devices';

export interface Version {
  at: number;
  elements: number;
  authors: string[];
}

const path = (board: string) => `/api/history/${encodeURIComponent(board)}`;

export async function listVersions(hub: Hub, board: string): Promise<Version[]> {
  const r = await hubCall<{ versions: Version[] }>(fetch, hub.url, path(board), {
    token: hub.token,
  });
  return r.versions ?? [];
}

/** Картинка версии — ссылкой на blob (токен — в заголовке, а не в адресе). */
export async function versionPreview(hub: Hub, board: string, at: number): Promise<string | null> {
  const base = hubHttpUrl(hub.url);
  if (!base) return null;
  const res = await fetch(`${base}${path(board)}/${at}.png`, {
    headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
  });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

export async function restoreVersion(hub: Hub, board: string, at: number): Promise<number> {
  const r = await hubCall<{ changed: number }>(fetch, hub.url, `${path(board)}/${at}/restore`, {
    method: 'POST',
    token: hub.token,
    body: {},
  });
  return r.changed;
}

export async function copyVersion(
  hub: Hub,
  board: string,
  at: number,
): Promise<{ id: string; name: string }> {
  return hubCall(fetch, hub.url, `${path(board)}/${at}/copy`, {
    method: 'POST',
    token: hub.token,
    body: {},
  });
}

/** «Claude Code и человек» — кто менял доску до этой версии. */
export function authorsText(authors: readonly string[]): string {
  const names = authors.map((a) =>
    a === 'человек' ? 'вы' : a === 'claude-code' ? 'Claude Code' : a === 'chatgpt' ? 'ChatGPT' : a,
  );
  if (names.length === 0) return '';
  if (names.length === 1) return `правки: ${names[0]}`;
  return `правки: ${names.slice(0, -1).join(', ')} и ${names.at(-1)}`;
}
