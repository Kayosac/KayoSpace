/**
 * Подключение устройства к хабу и список устройств (решение 0008).
 * Только запросы и разбор — без React, чтобы покрывать тестами.
 */

import { hubHttpUrl } from '@kayospace/sync';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  addedBy: string;
}

export interface Pairing {
  code: string;
  expiresAt: number;
  hub: string;
  link: string;
}

export interface Hub {
  url: string;
  /** Токен устройства; пустая строка — хаб без защиты (разработка). */
  token: string;
}

type Fetch = typeof fetch;

/** Ошибка запроса к хабу с понятным человеку текстом. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Что пришло по ссылке kayospace://connect?hub=…&code=… (из QR или системной камеры). */
export function parseConnectLink(link: string): { hub: string; code: string | null } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'kayospace:') return null;
  // kayospace://connect?… — «connect» попадает в host или в начало пути, в зависимости от платформы.
  const what = (url.host || url.pathname.replace(/^\/+/, '')).split('/')[0];
  if (what !== 'connect') return null;
  const hub = url.searchParams.get('hub')?.trim() ?? '';
  if (!hub || !hubHttpUrl(hub)) return null;
  const code = normalizeCode(url.searchParams.get('code') ?? '');
  return { hub, code };
}

/** 6 цифр из того, что ввёл человек («123 456», «123-456»); иначе null. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Платформа этого устройства — для имени по умолчанию и списка устройств. */
export function detectPlatform(ua: string = globalThis.navigator?.userAgent ?? '', tauri = false) {
  if (/Android/i.test(ua)) return tauri ? 'android' : 'browser';
  if (/iPhone|iPad/i.test(ua)) return tauri ? 'ios' : 'browser';
  if (!tauri) return 'browser';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

export const PLATFORM_NAMES: Record<string, string> = {
  macos: 'Mac',
  windows: 'Windows',
  android: 'Android',
  ios: 'iPhone / iPad',
  linux: 'Linux',
  browser: 'Браузер',
};

function base(hubUrl: string): string {
  const b = hubHttpUrl(hubUrl);
  if (!b) throw new HubError('Адрес не похож на адрес хаба', 0);
  return b;
}

async function call<T>(
  f: Fetch,
  hubUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await f(`${base(hubUrl)}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    if (err instanceof HubError) throw err;
    throw new HubError('Хаб не отвечает. Проверьте адрес и интернет.', 0);
  }
  if (res.status === 204) return undefined as T;
  let body: { error?: string } & Record<string, unknown> = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* не JSON */
  }
  if (!res.ok) {
    const msg =
      res.status === 401
        ? 'Устройство не подключено к этому хабу'
        : res.status === 404
          ? 'Хаб не умеет подключать устройства — обновите хаб'
          : (body.error ?? `Хаб ответил ${res.status}`);
    throw new HubError(msg, res.status);
  }
  return body as T;
}

/** Подключить это устройство по коду: вернёт токен устройства. */
export function claim(
  hubUrl: string,
  code: string,
  device: { name: string; platform: string },
  f: Fetch = fetch,
): Promise<{ token: string; device: DeviceInfo }> {
  return call(f, hubUrl, '/api/devices/claim', { method: 'POST', body: { code, ...device } });
}

/** Обменять старый общий токен (HUB_TOKEN из настроек) на свой токен устройства. */
export function register(
  hubUrl: string,
  adminToken: string,
  device: { name: string; platform: string },
  f: Fetch = fetch,
): Promise<{ token: string; device: DeviceInfo }> {
  return call(f, hubUrl, '/api/devices/register', {
    method: 'POST',
    token: adminToken,
    body: device,
  });
}

export function pair(hub: Hub, f: Fetch = fetch): Promise<Pairing> {
  return call(f, hub.url, '/api/devices/pair', { method: 'POST', token: hub.token, body: {} });
}

export function listDevices(
  hub: Hub,
  f: Fetch = fetch,
): Promise<{ devices: DeviceInfo[]; current: string | null }> {
  return call(f, hub.url, '/api/devices', { token: hub.token });
}

export function revokeDevice(hub: Hub, id: string, f: Fetch = fetch): Promise<void> {
  return call(f, hub.url, `/api/devices/${id}`, { method: 'DELETE', token: hub.token });
}

/** «5 минут назад», «вчера в 21:40», «3 марта» — когда устройство последний раз заходило. */
export function lastSeenText(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < 2 * 60_000) return 'только что';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} мин назад`;
  const d = new Date(at);
  const today = new Date(now);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return `сегодня в ${time}`;
  const yesterday = new Date(now - 24 * 3600_000);
  if (sameDay(d, yesterday)) return `вчера в ${time}`;
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}
