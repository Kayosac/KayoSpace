/**
 * «Поделиться» → Kayospace (Android, решение 0010): присланные текст, ссылки и картинки
 * ложатся на доску «Входящие» лентой — каждое новое ниже предыдущих.
 * Присланное забираем при запуске и каждый раз, когда приложение возвращается на экран.
 */

export const INBOX_BOARD = 'inbox';
export const INBOX_NAME = 'Входящие';

export interface SharedPayload {
  text?: string;
  subject?: string;
  /** data — содержимое в base64. */
  files: { name: string; mime: string; data: string }[];
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

/** Забрать присланное (null — ничего нет или это не приложение). */
export async function takeShared(): Promise<SharedPayload | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const p = await invoke<SharedPayload>('plugin:share-target|take');
    return hasContent(p) ? p : null;
  } catch (err) {
    console.warn('Не получилось забрать присланное', err);
    return null;
  }
}

export function hasContent(p: SharedPayload | null | undefined): p is SharedPayload {
  return !!p && (!!sharedText(p) || (p.files?.length ?? 0) > 0);
}

/** Текст заметки: тема (например, заголовок страницы) и сам текст, без повторов. */
export function sharedText(p: SharedPayload): string | null {
  const text = p.text?.trim() ?? '';
  const subject = p.subject?.trim() ?? '';
  if (subject && text && !text.includes(subject)) return `${subject}\n${text}`;
  return text || subject || null;
}

/** Присланные картинки и PDF — как файлы для вставки. */
export function sharedFiles(p: SharedPayload): File[] {
  return (p.files ?? [])
    .filter(
      (f) =>
        (f.mime.startsWith('image/') && f.mime !== 'image/svg+xml') || f.mime === 'application/pdf',
    )
    .map((f) => {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], f.name || 'Картинка', { type: f.mime });
    });
}
