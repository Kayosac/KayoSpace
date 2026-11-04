import { isValidBoardId } from './protocol';

/**
 * Адрес хаба из того, что ввёл человек: «192.168.1.10:4000», «hub.example.com», «x.sslip.io:8443», «https://…».
 * Без схемы: IP, localhost и *.local — локальная сеть (ws://, порт по умолчанию 4000),
 * домен — хаб в интернете за HTTPS (wss://, порт как указан).
 * null — если адрес или имя доски не подходят.
 */
export function hubSyncUrl(input: string, board: string, token = ''): string | null {
  const raw = input.trim();
  if (!raw || !isValidBoardId(board)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `ws://${raw}`);
  } catch {
    return null;
  }
  if (!hasScheme && !isLocalHost(url.hostname)) url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.port && url.protocol === 'ws:') url.port = '4000';
  const q = token.trim() ? `?token=${encodeURIComponent(token.trim())}` : '';
  return `${url.protocol}//${url.host}/sync/${board}${q}`;
}

/**
 * Адрес HTTP API хаба (REST: /api/boards) по тому же вводу, что и hubSyncUrl:
 * локальная сеть — http:// с портом 4000 по умолчанию, домен — https://. null — если адрес не подходит.
 */
export function hubHttpUrl(input: string): string | null {
  const ws = hubSyncUrl(input, 'x');
  if (!ws) return null;
  const url = new URL(ws);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

/** Идентификатор новой доски из названия: латиница и цифры, иначе — по времени. */
export function boardIdFromName(name: string, now: number = Date.now()): string {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };
  const slug = [...name.toLowerCase()]
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Хвост из времени — чтобы две доски «План» на разных устройствах не слились в одну.
  const tail = Math.floor(now).toString(36).slice(-5);
  return slug ? `${slug}-${tail}` : `board-${tail}`;
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
    h.startsWith('[')
  );
}
