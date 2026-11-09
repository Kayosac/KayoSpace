/**
 * Медиафайлы — в системный буфер обмена самим файлом (Ctrl/⌘ C и кнопка «Копировать»):
 * выделенную картинку можно вставить в мессенджер, редактор, другую программу. Всё остальное
 * (стикеры, текст, несколько элементов) копируется как раньше — элементами Kayospace.
 *
 * Буфер браузера и WebView принимает картинку только как PNG: остальное перекодируем, обрезку
 * (crop) применяем — в буфер попадает то, что видно на доске.
 */

import type { ImageElement } from '@kayospace/model';

/** Что скопировали последним: по размеру вставленной картинки узнаём «свою» и вставляем элемент. */
let lastMedia: { w: number; h: number } | null = null;

const croppedSize = (el: ImageElement): { w: number; h: number } => {
  const c = el.props.crop;
  return c
    ? { w: Math.round(c.w), h: Math.round(c.h) }
    : { w: el.props.naturalW, h: el.props.naturalH };
};

async function decode(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVG и то, что createImageBitmap не берёт, — через <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Файл картинки → PNG (как есть, если это уже PNG без обрезки). */
export async function imagePng(el: ImageElement, blob: Blob): Promise<Blob> {
  const crop = el.props.crop;
  if (blob.type === 'image/png' && !crop) return blob;
  const src = await decode(blob);
  const { w, h } = croppedSize(el);
  const sx = crop?.x ?? 0;
  const sy = crop?.y ?? 0;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Нет холста');
  ctx.drawImage(src, sx, sy, w, h, 0, 0, w, h);
  if ('close' in src && typeof src.close === 'function') src.close();
  return await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Не получилось PNG'))), 'image/png'),
  );
}

export const canWriteImages = (): boolean =>
  typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

/**
 * Положить картинку в системный буфер. Вызывать сразу в обработчике нажатия или клавиш:
 * запись начинается синхронно (ClipboardItem с обещанием), иначе Safari и WebView откажут.
 */
export function writeImage(
  el: ImageElement,
  load: (assetId: string) => Promise<Blob | null>,
): Promise<void> {
  if (!canWriteImages()) return Promise.reject(new Error('Буфер обмена не принимает картинки'));
  const png = load(el.props.assetId).then((blob) => {
    if (!blob) throw new Error('Картинки нет на устройстве');
    return imagePng(el, blob);
  });
  const done = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  lastMedia = croppedSize(el);
  return done;
}

/** Скопировали не картинку — «своей» картинки в буфере больше нет. */
export function forgetMedia(): void {
  lastMedia = null;
}

/** Вставляемая картинка — та, что мы сами скопировали с доски (тогда вставляем элемент целиком). */
export async function isOwnMedia(file: File): Promise<boolean> {
  if (!lastMedia) return false;
  const want = lastMedia;
  try {
    const bmp = await createImageBitmap(file);
    const same = bmp.width === want.w && bmp.height === want.h;
    bmp.close();
    return same;
  } catch {
    return false;
  }
}
