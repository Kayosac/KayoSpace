/**
 * Картинки на устройстве: IndexedDB (работает офлайн) + хаб (видно на других устройствах).
 * Файл хранится по SHA-256 содержимого: одна и та же картинка не дублируется.
 * Вставленные без связи картинки ждут в очереди и уезжают на хаб при подключении.
 */

import { hubHttpUrl } from '@kayospace/sync';

const DB_NAME = 'kayospace-assets';
const BLOBS = 'blobs';
const PENDING = 'pending';
/** Хаб примет не больше. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export interface Hub {
  url: string;
  token: string;
}

export interface StoredImage {
  assetId: string;
  width: number;
  height: number;
  blob: Blob;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(BLOBS);
      req.result.createObjectStore(PENDING);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class AssetStore {
  private db: Promise<IDBDatabase> | null = null;
  private hub: Hub | null = null;
  private uploading = false;

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  /** Куда загружать и откуда брать картинки, которых нет на устройстве. */
  setHub(hub: Hub | null): void {
    this.hub = hub && hubHttpUrl(hub.url) ? hub : null;
    if (this.hub) void this.uploadPending();
  }

  /** Сохранить картинку на устройстве и поставить в очередь на хаб. */
  async add(file: Blob): Promise<StoredImage> {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Картинка больше 30 МБ');
    const data = await file.arrayBuffer();
    const assetId = await sha256Hex(data);
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error('Этот формат картинки не поддерживается');
    const { width, height } = bitmap;
    bitmap.close();
    const blob = new Blob([data], { type: file.type || 'application/octet-stream' });
    const db = await this.open();
    await tx(db, BLOBS, 'readwrite', (s) => s.put(blob, assetId));
    await tx(db, PENDING, 'readwrite', (s) => s.put(Date.now(), assetId));
    void this.uploadPending();
    return { assetId, width, height, blob };
  }

  /** Картинка по id: с устройства, иначе — с хаба (и сохранить на устройстве). */
  async load(assetId: string): Promise<Blob | null> {
    const db = await this.open();
    const local = await tx<Blob | undefined>(db, BLOBS, 'readonly', (s) => s.get(assetId));
    if (local) return local;
    const hub = this.hub;
    const base = hub ? hubHttpUrl(hub.url) : null;
    if (!hub || !base) return null;
    const res = await fetch(`${base}/api/assets/${assetId}`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    await tx(db, BLOBS, 'readwrite', (s) => s.put(blob, assetId));
    return blob;
  }

  /** Отправить на хаб всё, что вставили без связи. */
  async uploadPending(): Promise<void> {
    const hub = this.hub;
    const base = hub ? hubHttpUrl(hub.url) : null;
    if (!hub || !base || this.uploading) return;
    this.uploading = true;
    try {
      const db = await this.open();
      const ids = (await tx<IDBValidKey[]>(db, PENDING, 'readonly', (s) =>
        s.getAllKeys(),
      )) as string[];
      for (const id of ids) {
        const blob = await tx<Blob | undefined>(db, BLOBS, 'readonly', (s) => s.get(id));
        if (!blob) {
          await tx(db, PENDING, 'readwrite', (s) => s.delete(id));
          continue;
        }
        const res = await fetch(`${base}/api/assets/${id}`, {
          method: 'PUT',
          body: blob,
          headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
        }).catch(() => null);
        if (!res) break; // связи нет — попробуем при следующем подключении
        if (res.ok || res.status === 400) {
          // 400 — содержимое не прошло проверку: повторять бессмысленно.
          await tx(db, PENDING, 'readwrite', (s) => s.delete(id));
        }
      }
    } finally {
      this.uploading = false;
    }
  }
}

/** Картинки из буфера обмена или перетаскивания. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && file.type.startsWith('image/') && file.type !== 'image/svg+xml') out.push(file);
  }
  return out;
}

/** Картинки — одно хранилище на всё приложение (общее для досок и таблиц). */
export const assets = new AssetStore();

/** Адреса картинок для <img>: один на файл, пока приложение открыто. */
const urls = new Map<string, Promise<string | null>>();

export function assetUrl(assetId: string): Promise<string | null> {
  let p = urls.get(assetId);
  if (!p) {
    p = assets
      .load(assetId)
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null);
    urls.set(assetId, p);
    // Не нашлось (нет связи) — в другой раз попробуем снова.
    void p.then((u) => {
      if (!u) urls.delete(assetId);
    });
  }
  return p;
}
