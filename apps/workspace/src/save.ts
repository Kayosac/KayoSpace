/**
 * Сохранить файл (экспорт доски): в приложении — системный диалог «Сохранить как»
 * (плагины dialog и fs), в браузере — обычная загрузка файла.
 */

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

/** Имя файла из названия доски: без символов, запрещённых в именах файлов. */
export function fileName(base: string, ext: string): string {
  const clean =
    base
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Kayospace';
  return `${clean}.${ext}`;
}

/** true — сохранено, false — человек отменил диалог. */
export async function saveFile(
  data: Blob | Uint8Array,
  name: string,
  mime: string,
): Promise<boolean> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const ext = name.split('.').pop() ?? '';
    const path = await save({
      defaultPath: name,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Ссылка нужна браузеру ещё мгновение после клика.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return true;
}
