/**
 * Подключение этого устройства к хабу: адрес (в настройках), токен устройства (в хранилище ОС),
 * переход со старого общего токена и режим разработки. Без React — для useSyncExternalStore и тестов.
 */

import { HubError, claim, detectPlatform, register, type Hub } from './devices';
import { DEV_HUB } from './config';
import { HUB_TOKEN_KEY, type SecretStore } from './secrets';
import type { WorkspaceSettings } from './settings';

export interface ConnectionState {
  /** Токен ещё читается из хранилища ОС. */
  loading: boolean;
  /** Хаб, с которым работает устройство; null — только на этом устройстве. */
  hub: Hub | null;
  /** Локальный хаб разработки (`pnpm dev`). */
  dev: boolean;
  /** Устройство отключили на хабе — нужно подключить заново. */
  revoked: boolean;
}

type Settings = Pick<WorkspaceSettings, 'hubUrl' | 'hubToken' | 'syncOn'>;

export interface ConnectionDeps {
  secrets: SecretStore;
  /** Настройки при запуске и их изменение (адрес хаба хранится в настройках, токен — нет). */
  settings: Settings;
  updateSettings: (patch: Partial<WorkspaceSettings>) => void;
  fetch?: typeof fetch;
  /** Хаб разработки; по умолчанию — из окружения. */
  devHub?: string | null;
  tauri?: boolean;
  userAgent?: string;
}

export class Connection {
  private state: ConnectionState;
  private token: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly devHub: string | null;
  private settings: Settings;

  constructor(private readonly deps: ConnectionDeps) {
    this.settings = { ...deps.settings };
    this.devHub = deps.devHub === undefined ? DEV_HUB : deps.devHub;
    this.state = this.devHub
      ? { loading: false, hub: { url: this.devHub, token: '' }, dev: true, revoked: false }
      : { loading: true, hub: null, dev: false, revoked: false };
  }

  getState(): ConnectionState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get platform(): string {
    return detectPlatform(this.deps.userAgent, this.deps.tauri ?? false);
  }

  /** Прочитать токен; старый общий токен из настроек — обменять на свой. */
  async init(): Promise<void> {
    if (this.devHub) return;
    try {
      this.token = await this.deps.secrets.get(HUB_TOKEN_KEY);
    } catch (err) {
      console.warn('[kayospace] хранилище секретов недоступно', err);
      this.token = null;
    }
    const s = this.settings;
    const legacy = s.hubToken.trim();
    let rejected = false;
    if (legacy && s.hubUrl.trim() && !this.token) rejected = await this.migrate(s.hubUrl, legacy);
    else if (legacy && this.token) this.update({ hubToken: '' });
    this.refresh({ loading: false, revoked: rejected });
  }

  /** Подключить устройство по коду. Ошибка — HubError с понятным текстом. */
  async connect(hubUrl: string, code: string, name: string): Promise<void> {
    const r = await claim(
      hubUrl.trim(),
      code,
      { name: name.trim(), platform: this.platform },
      this.deps.fetch,
    );
    await this.deps.secrets.set(HUB_TOKEN_KEY, r.token);
    this.token = r.token;
    this.update({ hubUrl: hubUrl.trim(), hubToken: '', syncOn: true });
    this.refresh({ revoked: false });
  }

  /** Забыть хаб на этом устройстве (после отключения на хабе или по кнопке). */
  async forget(): Promise<void> {
    this.token = null;
    try {
      await this.deps.secrets.remove(HUB_TOKEN_KEY);
    } catch {
      /* уже нет */
    }
    this.update({ hubToken: '', syncOn: false });
    this.refresh({ revoked: false });
  }

  /** Хаб сообщил, что токен больше не действует (устройство отключили). */
  async markRevoked(): Promise<void> {
    if (this.devHub || this.state.revoked || !this.state.hub) return;
    this.token = null;
    try {
      await this.deps.secrets.remove(HUB_TOKEN_KEY);
    } catch {
      /* уже нет */
    }
    this.update({ hubToken: '' });
    this.refresh({ revoked: true });
  }

  /** Настройки поменялись снаружи (адрес, «синхронизировать») — пересчитать хаб. */
  settingsChanged(s: Settings): void {
    this.settings = { hubUrl: s.hubUrl, hubToken: s.hubToken, syncOn: s.syncOn };
    if (!this.devHub && !this.state.loading) this.refresh({});
  }

  private update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.deps.updateSettings(patch);
  }

  /** true — хаб не принял старый токен: устройство нужно подключить заново. */
  private async migrate(hubUrl: string, legacy: string): Promise<boolean> {
    try {
      const r = await register(
        hubUrl,
        legacy,
        { name: '', platform: this.platform },
        this.deps.fetch,
      );
      await this.deps.secrets.set(HUB_TOKEN_KEY, r.token);
      this.token = r.token;
      this.update({ hubToken: '' });
      return false;
    } catch (err) {
      const status = err instanceof HubError ? err.status : 0;
      if (status === 401 || status === 403) {
        // Общий токен уже не подходит — подключаться заново по коду.
        this.update({ hubToken: '' });
        return true;
      } else {
        // Хаб недоступен или старый: пока работаем по старому токену, обменяем при следующем запуске.
        this.token = legacy;
        return false;
      }
    }
  }

  private refresh(patch: Partial<ConnectionState>): void {
    const s = this.settings;
    const hub =
      this.devHub !== null
        ? { url: this.devHub, token: '' }
        : s.syncOn && s.hubUrl.trim() && this.token
          ? { url: s.hubUrl.trim(), token: this.token }
          : null;
    const next = { ...this.state, ...patch, hub };
    const same =
      next.loading === this.state.loading &&
      next.revoked === this.state.revoked &&
      next.hub?.url === this.state.hub?.url &&
      next.hub?.token === this.state.hub?.token;
    if (same) return;
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}
