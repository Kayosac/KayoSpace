/**
 * Открытая доска: Yjs-документ, локальное хранилище (IndexedDB) и, если настроено, синхронизация с хабом.
 * Доска работает и без сети: правки сохраняются локально и уезжают на хаб при подключении.
 */

import { IndexeddbPersistence } from 'y-indexeddb';
import { createBoardDoc } from '@kayospace/board';
import { SyncClient, hubSyncUrl, type SyncError, type SyncStatus } from '@kayospace/sync';

export type SessionSync = SyncStatus | 'off' | 'bad-address';

export interface SessionState {
  /** Локальная копия загружена из IndexedDB. */
  loaded: boolean;
  sync: SessionSync;
  error: SyncError | null;
}

export class BoardSession {
  readonly doc = createBoardDoc();
  private readonly persistence: IndexeddbPersistence | null;
  private readonly client: SyncClient | null = null;
  private readonly listeners = new Set<() => void>();
  private state: SessionState;

  constructor(
    readonly board: string,
    hub: { url: string; token: string } | null,
  ) {
    let sync: SessionSync = 'off';
    let persistence: IndexeddbPersistence | null = null;
    try {
      persistence = new IndexeddbPersistence(`kayospace:${board}`, this.doc);
    } catch (err) {
      console.warn('[kayospace] IndexedDB недоступен, доска не сохранится локально', err);
    }
    this.persistence = persistence;
    if (hub) {
      const url = hubSyncUrl(hub.url, board, hub.token);
      if (url) {
        this.client = new SyncClient(this.doc, { url, minDelayMs: 500, maxDelayMs: 5000 });
        sync = this.client.status;
        this.client.onStatus(() => this.update({}));
      } else {
        sync = 'bad-address';
      }
    }
    this.state = { loaded: !persistence, sync, error: null };
    persistence?.whenSynced.then(
      () => this.update({ loaded: true }),
      () => this.update({ loaded: true }),
    );
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Переподключиться немедленно (после сна, смены сети). */
  reconnect(): void {
    if (this.client && this.client.status !== 'connected' && this.client.status !== 'synced') {
      this.client.disconnect();
      this.client.connect();
    }
  }

  destroy(): void {
    this.listeners.clear();
    this.client?.destroy();
    void this.persistence?.destroy();
    this.doc.destroy();
  }

  private update(patch: Partial<SessionState>): void {
    const next: SessionState = {
      ...this.state,
      ...patch,
      ...(this.client ? { sync: this.client.status, error: this.client.lastError } : {}),
    };
    if (
      next.loaded === this.state.loaded &&
      next.sync === this.state.sync &&
      next.error === this.state.error
    ) {
      return;
    }
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}
