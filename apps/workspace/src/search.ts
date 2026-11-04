/** Поиск текста по доскам: на хабе — по всем, без хаба — по открытой (решение 0012). */

import { hubCall, type Hub } from './devices';

export interface SearchHit {
  board: string;
  boardName: string | null;
  id: string;
  type: string;
  text: string;
}

export async function searchHub(
  hub: Hub,
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const f: typeof fetch = (input, init) => fetch(input, { ...init, signal });
  const r = await hubCall<{ hits: SearchHit[] }>(
    f,
    hub.url,
    `/api/search?q=${encodeURIComponent(query.trim())}`,
    { token: hub.token },
  );
  return r.hits ?? [];
}

/** Кусок текста вокруг совпадения: не длиннее max, многоточия там, где обрезано. */
export function snippet(text: string, query: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const at = Math.max(0, flat.toLowerCase().indexOf(query.trim().toLowerCase()));
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  const part = flat.slice(start, start + max).trim();
  return `${start > 0 ? '…' : ''}${part}${start + max < flat.length ? '…' : ''}`;
}
