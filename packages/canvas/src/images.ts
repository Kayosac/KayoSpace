/**
 * Картинки для отрисовки: грузятся по id содержимого, декодируются один раз
 * (большие — с уменьшением до 4096 по большей стороне) и держатся в памяти.
 */

import type { AssetLoader } from './engine';
import type { ImageSource } from './renderer';

/** Больше этого по большей стороне картинку не держим: экран всё равно меньше, а память — нет. */
const MAX_SIDE = 4096;
/** Нет картинки — пробуем ещё раз не раньше, чем через это время (могла приехать с хаба). */
const RETRY_MS = 3000;

type Entry =
  | { state: 'loading' }
  | { state: 'ready'; image: ImageBitmap }
  | { state: 'missing'; at: number; tries: number };

export class ImageCache implements ImageSource {
  private readonly entries = new Map<string, Entry>();
  private destroyed = false;

  constructor(
    private readonly loader: AssetLoader | null,
    private readonly onReady: (assetId: string) => void,
  ) {}

  get(assetId: string): CanvasImageSource | null {
    const e = this.entries.get(assetId);
    if (e?.state === 'ready') return e.image;
    if (!e || (e.state === 'missing' && performance.now() - e.at > RETRY_MS))
      void this.load(assetId);
    return null;
  }

  /** Положить уже декодированную картинку (только что вставленную) — без повторной загрузки. */
  async put(assetId: string, blob: Blob): Promise<void> {
    const image = await decode(blob);
    if (image && !this.destroyed) {
      this.entries.set(assetId, { state: 'ready', image });
      this.onReady(assetId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const e of this.entries.values()) if (e.state === 'ready') e.image.close();
    this.entries.clear();
  }

  /** Нет картинки — чуть позже перерисовать место (это запустит повторную попытку), не больше 6 раз. */
  private missing(assetId: string, tries: number): void {
    this.entries.set(assetId, { state: 'missing', at: performance.now(), tries: tries + 1 });
    if (tries < 5) setTimeout(() => !this.destroyed && this.onReady(assetId), RETRY_MS + 50);
  }

  private async load(assetId: string, tries = 0): Promise<void> {
    this.entries.set(assetId, { state: 'loading' });
    try {
      const blob = this.loader ? await this.loader.load(assetId) : null;
      const image = blob ? await decode(blob) : null;
      if (this.destroyed) {
        image?.close();
        return;
      }
      if (!image) {
        this.missing(assetId, tries);
        return;
      }
      this.entries.set(assetId, { state: 'ready', image });
      this.onReady(assetId);
    } catch (err) {
      console.warn('[kayospace] картинка не загрузилась', assetId, err);
      this.missing(assetId, tries);
    }
  }
}

async function decode(blob: Blob): Promise<ImageBitmap | null> {
  try {
    const full = await createImageBitmap(blob);
    const side = Math.max(full.width, full.height);
    if (side <= MAX_SIDE) return full;
    const k = MAX_SIDE / side;
    const small = await createImageBitmap(full, {
      resizeWidth: Math.round(full.width * k),
      resizeHeight: Math.round(full.height * k),
      resizeQuality: 'high',
    });
    full.close();
    return small;
  } catch {
    return null;
  }
}
