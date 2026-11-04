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

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
    h.startsWith('[')
  );
}
