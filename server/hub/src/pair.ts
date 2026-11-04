/** Выдача кода подключения через запущенный хаб — для `pnpm pair` и тестов. */

import { encode } from 'uqr';

export interface Pairing {
  code: string;
  expiresAt: number;
  hub: string;
  link: string;
}

/** «123456» → «123 456». */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export async function requestPairing(hubUrl: string, token: string): Promise<Pairing> {
  let res: Response;
  try {
    res = await fetch(`${hubUrl}/api/devices/pair`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new Error(`хаб не отвечает по ${hubUrl}. Он запущен?`);
  }
  if (res.status === 401) throw new Error('хаб не принял HUB_TOKEN');
  if (res.status === 404)
    throw new Error('эта версия хаба не умеет подключать устройства — обновите хаб');
  if (!res.ok) throw new Error(`хаб ответил ${res.status}`);
  return (await res.json()) as Pairing;
}

/**
 * QR для терминала: два ряда модулей в одной строке («▀»: верх — цвет текста, низ — фон).
 * Цвета заданы явно (чёрный по белому), поэтому QR читается и в тёмной, и в светлой теме терминала.
 */
export function terminalQr(text: string, quiet = 3): string {
  const qr = encode(text, { ecc: 'M', border: 0 });
  const n = qr.size + quiet * 2;
  const dark = (x: number, y: number): boolean => {
    const i = x - quiet;
    const j = y - quiet;
    return i >= 0 && j >= 0 && i < qr.size && j < qr.size && qr.data[j]![i]!;
  };
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = dark(x, y) ? 30 : 97; // чёрный / ярко-белый текст
      const bottom = y + 1 < n && dark(x, y + 1) ? 40 : 107; // чёрный / ярко-белый фон
      line += `\x1b[${top};${bottom}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}
