/**
 * Секреты устройства (токен хаба).
 *
 *   - В приложении (Tauri) — хранилище ОС: Keychain на macOS, Credential Manager на Windows,
 *     Android Keystore на Android (плагин secure-store в apps/app/src-tauri).
 *   - В браузере (разработка, проверки) — localStorage: защищённого хранилища там нет.
 */

import { STORAGE_NS } from './config';

export interface SecretStore {
  /** Где лежат секреты — для подсказки в настройках. */
  readonly kind: 'os' | 'browser' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

class OsSecretStore implements SecretStore {
  readonly kind = 'os';
  private async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(`plugin:secure-store|${cmd}`, args);
  }
  async get(key: string): Promise<string | null> {
    const r = await this.invoke<{ value?: string | null }>('get', { key });
    return r?.value ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.invoke('set', { key, value });
  }
  async remove(key: string): Promise<void> {
    await this.invoke('remove', { key });
  }
}

class BrowserSecretStore implements SecretStore {
  readonly kind = 'browser';
  private readonly mem = new Map<string, string>();
  private k(key: string): string {
    return `${STORAGE_NS}.secret.${key}`;
  }
  async get(key: string): Promise<string | null> {
    try {
      return globalThis.localStorage?.getItem(this.k(key)) ?? this.mem.get(key) ?? null;
    } catch {
      return this.mem.get(key) ?? null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    this.mem.set(key, value);
    try {
      globalThis.localStorage?.setItem(this.k(key), value);
    } catch {
      /* только в памяти до перезагрузки */
    }
  }
  async remove(key: string): Promise<void> {
    this.mem.delete(key);
    try {
      globalThis.localStorage?.removeItem(this.k(key));
    } catch {
      /* нечего удалять */
    }
  }
}

/** Секреты в памяти — для тестов. */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export function createSecretStore(): SecretStore {
  return isTauri() ? new OsSecretStore() : new BrowserSecretStore();
}

/** Ключ, под которым хранится токен устройства для хаба. */
export const HUB_TOKEN_KEY = 'hub-token';
