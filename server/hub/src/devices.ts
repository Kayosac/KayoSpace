/**
 * Подключённые устройства и одноразовые коды подключения (решение 0008).
 *
 *   - Подключённое устройство (или администратор с HUB_TOKEN) просит код: 6 цифр, живёт 5 минут, одноразовый.
 *   - Новое устройство отдаёт код хабу и получает свой долгоживущий токен `kd_<id>_<секрет>`.
 *   - На хабе хранится только SHA-256 секрета (data/devices.json), на устройстве — в хранилище ОС.
 *   - «Отключить» удаляет запись: токен перестаёт действовать сразу, открытые соединения закрываются.
 *
 * Защита от перебора кода: каждая неверная попытка засчитывается всем действующим кодам; после 5 неверных
 * попыток коды сгорают. Плюс не больше 10 попыток в минуту с одного адреса.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

export const CODE_TTL_MS = 5 * 60 * 1000;
/** Сколько неверных попыток выдерживает код. */
export const CODE_MAX_FAILURES = 5;
/** Попыток ввода кода в минуту с одного адреса. */
export const CLAIM_PER_MINUTE = 10;
/** Одновременно действующих кодов (на случай, если кнопку «Добавить» жмут много раз). */
const MAX_ACTIVE_CODES = 10;
/** Дату последнего входа обновляем не чаще раза в минуту — чтобы не писать на диск на каждый запрос. */
const SEEN_GRANULARITY_MS = 60 * 1000;

export interface DeviceInfo {
  id: string;
  name: string;
  /** macos, windows, android, browser… — как назвало себя устройство. */
  platform: string;
  /** Unix-время, мс. */
  createdAt: number;
  lastSeenAt: number;
  /** Кто выдал код: id устройства или «admin» (HUB_TOKEN, `pnpm pair`). */
  addedBy: string;
}

interface StoredDevice extends DeviceInfo {
  /** SHA-256 секрета (hex). */
  secretHash: string;
}

interface PendingCode {
  exp: number;
  failures: number;
  createdBy: string;
}

export type ClaimResult =
  | { ok: true; token: string; device: DeviceInfo }
  | { ok: false; error: 'invalid' | 'rate-limited' | 'bad-request' };

const TOKEN_RE = /^kd_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Похож ли токен на токен устройства (быстрая проверка без поиска). */
export function isDeviceToken(token: string | null | undefined): boolean {
  return !!token && TOKEN_RE.test(token);
}

/** Привести код к 6 цифрам: «123 456», «123-456» → «123456»; иначе null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

function cleanName(input: unknown, fallback: string): string {
  // Без управляющих символов (переводы строк, нулевой байт и т. п.).
  const s =
    typeof input === 'string'
      ? [...input]
          .filter((ch) => ch >= ' ' && ch !== '\u007f')
          .join('')
          .trim()
      : '';
  return (s || fallback).slice(0, 60);
}

function cleanPlatform(input: unknown): string {
  const s = typeof input === 'string' ? input.toLowerCase().replace(/[^a-z0-9-]/g, '') : '';
  return s.slice(0, 20) || 'unknown';
}

export class DeviceRegistry {
  private devices = new Map<string, StoredDevice>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly attempts = new Map<string, number[]>();
  private readonly revokeListeners = new Set<(id: string) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: StoredDevice[] };
      for (const d of raw.devices ?? []) {
        if (d && typeof d.id === 'string' && typeof d.secretHash === 'string') {
          this.devices.set(d.id, d);
        }
      }
    } catch {
      /* файла ещё нет */
    }
  }

  /** Выдать код подключения. */
  createCode(createdBy: string): { code: string; expiresAt: number } {
    this.prune();
    if (this.codes.size >= MAX_ACTIVE_CODES) {
      // Самый старый код уступает место новому.
      const oldest = [...this.codes.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
      if (oldest) this.codes.delete(oldest[0]);
    }
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.codes.has(code));
    const expiresAt = this.now() + CODE_TTL_MS;
    this.codes.set(code, { exp: expiresAt, failures: 0, createdBy });
    return { code, expiresAt };
  }

  /** Сколько кодов сейчас действует (для тестов и отладки). */
  get activeCodes(): number {
    this.prune();
    return this.codes.size;
  }

  /** Обменять код на токен устройства. */
  claim(input: { code: unknown; name?: unknown; platform?: unknown }, ip: string): ClaimResult {
    const now = this.now();
    const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= CLAIM_PER_MINUTE) {
      this.attempts.set(ip, recent);
      return { ok: false, error: 'rate-limited' };
    }
    recent.push(now);
    this.attempts.set(ip, recent);
    if (this.attempts.size > 10_000) this.attempts.clear();

    const code = normalizeCode(input.code);
    if (!code) return { ok: false, error: 'bad-request' };
    this.prune();
    const pending = this.codes.get(code);
    if (!pending) {
      // Неверная попытка приближает к сгоранию все действующие коды.
      for (const [k, c] of this.codes) {
        c.failures += 1;
        if (c.failures >= CODE_MAX_FAILURES) this.codes.delete(k);
      }
      return { ok: false, error: 'invalid' };
    }
    this.codes.delete(code); // одноразовый
    const platform = cleanPlatform(input.platform);
    const { token, device } = this.add(
      cleanName(input.name, defaultName(platform)),
      platform,
      pending.createdBy,
    );
    return { ok: true, token, device };
  }

  /** Подключить устройство без кода — для обмена HUB_TOKEN на свой токен (старые настройки). */
  issue(input: { name?: unknown; platform?: unknown }, addedBy: string) {
    const platform = cleanPlatform(input.platform);
    return this.add(cleanName(input.name, defaultName(platform)), platform, addedBy);
  }

  /** Устройство по его токену; заодно отмечает время последнего входа. null — токен не действует. */
  verify(token: string | null | undefined): DeviceInfo | null {
    const m = token ? TOKEN_RE.exec(token) : null;
    if (!m) return null;
    const d = this.devices.get(m[1]!);
    if (!d) return null;
    if (!timingSafeEqual(sha256(m[2]!), Buffer.from(d.secretHash, 'hex'))) return null;
    const now = this.now();
    if (now - d.lastSeenAt >= SEEN_GRANULARITY_MS) {
      d.lastSeenAt = now;
      this.save();
    }
    return publicInfo(d);
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map(publicInfo).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): DeviceInfo | null {
    const d = this.devices.get(id);
    return d ? publicInfo(d) : null;
  }

  /** Переименовать устройство. */
  rename(id: string, name: unknown): DeviceInfo | null {
    const d = this.devices.get(id);
    if (!d) return null;
    d.name = cleanName(name, d.name);
    this.save();
    return publicInfo(d);
  }

  /** Отключить устройство: токен перестаёт действовать сразу. */
  revoke(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    this.save();
    for (const cb of [...this.revokeListeners]) cb(id);
    return true;
  }

  onRevoke(cb: (id: string) => void): () => void {
    this.revokeListeners.add(cb);
    return () => this.revokeListeners.delete(cb);
  }

  /** Записи на диск — строго по очереди: две одновременные делили бы один временный файл. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const run = async (): Promise<void> => {
      const tmp = `${this.file}.tmp`;
      const body = JSON.stringify({ devices: [...this.devices.values()] }, null, 1);
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.file);
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  private add(name: string, platform: string, addedBy: string) {
    let id: string;
    do id = randomBytes(8).toString('hex');
    while (this.devices.has(id));
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    const stored: StoredDevice = {
      id,
      name,
      platform,
      createdAt: now,
      lastSeenAt: now,
      addedBy,
      secretHash: sha256(secret).toString('hex'),
    };
    this.devices.set(id, stored);
    this.save();
    return { token: `kd_${id}_${secret}`, device: publicInfo(stored) };
  }

  private prune(): void {
    const now = this.now();
    for (const [k, c] of this.codes) if (c.exp <= now) this.codes.delete(k);
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error('[hub] не удалось сохранить устройства', err));
    }, 200);
  }
}

function publicInfo(d: StoredDevice): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    addedBy: d.addedBy,
  };
}

function defaultName(platform: string): string {
  return (
    {
      macos: 'Mac',
      windows: 'Windows',
      android: 'Android',
      ios: 'iPhone / iPad',
      linux: 'Linux',
      browser: 'Браузер',
    }[platform] ?? 'Устройство'
  );
}
