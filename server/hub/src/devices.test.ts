import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_PER_MINUTE,
  CODE_MAX_FAILURES,
  CODE_TTL_MS,
  DeviceRegistry,
  isDeviceToken,
  normalizeCode,
} from './devices';

let dir: string;
let now: number;
let reg: DeviceRegistry;
let ipCounter = 0;
/** Каждая попытка — с нового адреса, чтобы ограничение по адресу не мешало проверять сами коды. */
const ip = (): string => `10.0.0.${++ipCounter}`;

/** Код, которого точно нет среди действующих. */
const wrongCode = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kayospace-devices-'));
  now = 1_000_000;
  reg = new DeviceRegistry(join(dir, 'devices.json'), () => now);
  await reg.init();
});

describe('коды подключения', () => {
  it('6 цифр, действуют 5 минут', () => {
    const { code, expiresAt } = reg.createCode('admin');
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(now + CODE_TTL_MS);
  });

  it('код обменивается на токен устройства', () => {
    const { code } = reg.createCode('admin');
    const r = reg.claim({ code, name: 'Планшет', platform: 'android' }, ip());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isDeviceToken(r.token)).toBe(true);
    expect(r.device).toMatchObject({ name: 'Планшет', platform: 'android', addedBy: 'admin' });
    expect(reg.verify(r.token)?.id).toBe(r.device.id);
  });

  it('код одноразовый', () => {
    const { code } = reg.createCode('admin');
    expect(reg.claim({ code }, ip()).ok).toBe(true);
    expect(reg.claim({ code }, ip())).toEqual({ ok: false, error: 'invalid' });
  });

  it('истекает через 5 минут', () => {
    const a = reg.createCode('admin');
    const b = reg.createCode('admin');
    now += CODE_TTL_MS - 1000;
    expect(reg.claim({ code: a.code }, ip()).ok).toBe(true); // за секунду до конца ещё работает
    now += 1000;
    expect(reg.claim({ code: b.code }, ip())).toEqual({ ok: false, error: 'invalid' });
    expect(reg.activeCodes).toBe(0);
  });

  it('сгорает после 5 неверных попыток', () => {
    const { code } = reg.createCode('admin');
    for (let i = 0; i < CODE_MAX_FAILURES - 1; i++) {
      expect(reg.claim({ code: wrongCode(code) }, ip()).ok).toBe(false);
    }
    expect(reg.activeCodes).toBe(1);
    expect(reg.claim({ code: wrongCode(code) }, ip()).ok).toBe(false);
    expect(reg.activeCodes).toBe(0);
    // Даже правильный код больше не подходит.
    expect(reg.claim({ code }, ip())).toEqual({ ok: false, error: 'invalid' });
  });

  it('не больше 10 попыток в минуту с одного адреса', () => {
    const from = '203.0.113.7';
    for (let i = 0; i < CLAIM_PER_MINUTE; i++) reg.claim({ code: '000000' }, from);
    const { code } = reg.createCode('admin');
    expect(reg.claim({ code }, from)).toEqual({ ok: false, error: 'rate-limited' });
    now += 60_000;
    expect(reg.claim({ code }, from).ok).toBe(true);
  });

  it('принимает код с пробелом и дефисом, отвергает мусор', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('abcdef')).toBeNull();
    expect(normalizeCode(123456)).toBeNull();
    expect(reg.claim({ code: 'abc' }, ip())).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('устройства', () => {
  it('отключение отзывает токен и сообщает подписчикам', () => {
    const r = reg.issue({ name: 'Mac', platform: 'macos' }, 'admin');
    const revoked: string[] = [];
    reg.onRevoke((id) => revoked.push(id));
    expect(reg.revoke(r.device.id)).toBe(true);
    expect(reg.verify(r.token)).toBeNull();
    expect(revoked).toEqual([r.device.id]);
    expect(reg.revoke(r.device.id)).toBe(false);
  });

  it('чужой или подделанный токен не проходит', () => {
    const r = reg.issue({ platform: 'macos' }, 'admin');
    const forged = r.token.slice(0, -1) + (r.token.endsWith('A') ? 'B' : 'A');
    expect(reg.verify(forged)).toBeNull();
    expect(reg.verify('kd_0000000000000000_' + 'x'.repeat(43))).toBeNull();
    expect(reg.verify('hub-token')).toBeNull();
    expect(reg.verify(undefined)).toBeNull();
  });

  it('помнит время последнего входа', () => {
    const r = reg.issue({ platform: 'android' }, 'admin');
    now += 10 * 60_000;
    reg.verify(r.token);
    expect(reg.get(r.device.id)?.lastSeenAt).toBe(now);
  });

  it('на диске только хэши; после перезапуска токены действуют', async () => {
    const r = reg.issue({ name: 'Планшет', platform: 'android' }, 'admin');
    await reg.flush();
    const file = await readFile(join(dir, 'devices.json'), 'utf8');
    const secret = r.token.split('_').slice(2).join('_');
    expect(file).not.toContain(secret);
    expect(file).toContain('Планшет');

    const again = new DeviceRegistry(join(dir, 'devices.json'), () => now);
    await again.init();
    expect(again.verify(r.token)?.name).toBe('Планшет');
  });

  it('имя без управляющих символов, не длиннее 60; без имени — по платформе', () => {
    const a = reg.issue({ name: 'a\u0000b'.padEnd(100, 'x'), platform: 'macos' }, 'admin');
    expect(a.device.name).toMatch(/^abx+$/);
    expect(a.device.name.length).toBe(60);
    expect(reg.issue({ platform: 'android' }, 'admin').device.name).toBe('Android');
    expect(reg.issue({ platform: '<script>' }, 'admin').device.platform).toBe('script');
  });
});
