/**
 * REST устройств:
 *   POST   /api/devices/claim     — обменять код на токен устройства (без авторизации, с ограничением попыток)
 *   POST   /api/devices/pair      — выдать код подключения и ссылку kayospace://connect?hub=…&code=…
 *   POST   /api/devices/register  — только с HUB_TOKEN: сразу выдать токен устройства (переход со старых настроек)
 *   GET    /api/devices           — список подключённых устройств, current — id того, кто спрашивает
 *   DELETE /api/devices/<id>      — отключить устройство
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientIp } from './auth';
import type { DeviceInfo, DeviceRegistry } from './devices';

/** Кто обращается к хабу. */
export interface Access {
  /** HUB_TOKEN (или открытый хаб без токена). */
  admin: boolean;
  device: DeviceInfo | null;
}

/** Ссылка для QR: всё, что нужно новому устройству. */
export function connectLink(hub: string, code: string): string {
  return `kayospace://connect?hub=${encodeURIComponent(hub)}&code=${code}`;
}

/** Обмен кода — единственный адрес устройств без авторизации. */
export async function handleClaim(
  req: IncomingMessage,
  res: ServerResponse,
  devices: DeviceRegistry,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'Нужен JSON' });
  }
  const r = devices.claim(
    { code: body.code, name: body.name, platform: body.platform },
    clientIp(req),
  );
  if (r.ok) {
    console.log(`[hub] подключено устройство «${r.device.name}» (${r.device.platform})`);
    return json(res, 200, { token: r.token, device: r.device });
  }
  if (r.error === 'rate-limited') {
    res.setHeader('Retry-After', '60');
    return json(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
  }
  if (r.error === 'bad-request') return json(res, 400, { error: 'Код — 6 цифр' });
  json(res, 400, { error: 'Код не подошёл или истёк. Попросите новый.' });
}

/** Остальные адреса /api/devices — уже после проверки доступа. false — не наш адрес. */
export async function handleDevices(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  devices: DeviceRegistry,
  access: Access,
  publicUrl: string,
): Promise<boolean> {
  const p = url.pathname;
  if (p === '/api/devices' && req.method === 'GET') {
    json(res, 200, { devices: devices.list(), current: access.device?.id ?? null });
    return true;
  }
  if (p === '/api/devices/pair' && req.method === 'POST') {
    const { code, expiresAt } = devices.createCode(access.device?.id ?? 'admin');
    json(res, 200, { code, expiresAt, hub: publicUrl, link: connectLink(publicUrl, code) });
    return true;
  }
  if (p === '/api/devices/register' && req.method === 'POST') {
    if (!access.admin || access.device) {
      json(res, 403, { error: 'Только с ключом администратора (HUB_TOKEN)' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: 'Нужен JSON' });
      return true;
    }
    const { token, device } = devices.issue({ name: body.name, platform: body.platform }, 'admin');
    console.log(`[hub] устройство «${device.name}» перешло с HUB_TOKEN на свой токен`);
    json(res, 200, { token, device });
    return true;
  }
  const one = /^\/api\/devices\/([0-9a-f]{16})$/.exec(p);
  if (one && req.method === 'DELETE') {
    const device = devices.get(one[1]!);
    if (!device || !devices.revoke(device.id)) {
      json(res, 404, { error: 'Такого устройства нет' });
      return true;
    }
    console.log(`[hub] отключено устройство «${device.name}»`);
    res.writeHead(204);
    res.end();
    return true;
  }
  if (p === '/api/devices' || p.startsWith('/api/devices/')) {
    json(res, 404, { error: 'Не найдено' });
    return true;
  }
  return false;
}

function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new Error('слишком большой запрос'));
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const v = text ? (JSON.parse(text) as unknown) : {};
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('не объект');
        resolve(v as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
