/**
 * Доступ к хабу.
 *
 * Без токена хаб рассчитан на один компьютер или домашнюю сеть: MCP принимает запросы только с localhost.
 * С токеном (HUB_TOKEN) хаб можно выставлять в интернет за HTTPS:
 *   - синхронизация: ws(s)://…/sync/<доска>?token=… (браузерный WebSocket не умеет заголовки);
 *   - REST и MCP: заголовок Authorization: Bearer <токен>;
 *   - MCP дополнительно проверяет Host и Origin (защита от DNS rebinding).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Код закрытия WebSocket при неверном токене — клиент по нему перестаёт переподключаться. */
export { CLOSE_UNAUTHORIZED } from '@kayospace/sync';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Сравнение токенов за постоянное время. */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1];
}

/** Токен из заголовка или из параметра ?token= (для WebSocket). */
export function requestToken(req: IncomingMessage, url: URL): string | undefined {
  return bearerToken(req) ?? url.searchParams.get('token') ?? undefined;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  // «[::1]:4000» → «[::1]», «example.com:443» → «example.com»
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

/** Host — локальный или публичный домен хаба. */
export function hostAllowed(req: IncomingMessage, publicHost?: string): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = hostnameOf(host);
  return LOCAL_HOSTS.has(name) || (!!publicHost && name === publicHost.toLowerCase());
}

/** Origin отсутствует (не браузер) или совпадает с локальным/публичным адресом хаба. */
export function originAllowed(req: IncomingMessage, publicHost?: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const name = new URL(origin).hostname.toLowerCase();
    return LOCAL_HOSTS.has(name) || (!!publicHost && name === publicHost.toLowerCase());
  } catch {
    return false;
  }
}
