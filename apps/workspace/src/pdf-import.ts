/**
 * Импорт PDF (решение 0017): каждая страница — картинка, на доске — во фрейме, поверх можно писать
 * пером. Страницы рисует pdf.js прямо на устройстве; библиотека грузится, только когда нужна.
 */

/** Больше страниц за раз не кладём: доска не читалка книг. */
export const MAX_PDF_PAGES = 60;
/** Ширина картинки страницы в пикселях: на доске страница 800 — вдвое чётче для пометок вблизи. */
const PAGE_PIXELS = 1600;
const MAX_SIDE = 4096;

export const isPdf = (f: File): boolean => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Файлы PDF из списка (выбор файла, перетаскивание, буфер). */
export function pdfFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && isPdf(file)) out.push(file);
  }
  return out;
}

/** Название для фреймов: имя файла без «.pdf». */
export function pdfTitle(name: string): string {
  return name.replace(/\.pdf$/i, '').trim() || 'PDF';
}

/** Масштаб страницы: ширина PAGE_PIXELS, но ни одна сторона не больше MAX_SIDE. */
export function pageScale(w: number, h: number): number {
  return Math.min(PAGE_PIXELS / w, MAX_SIDE / Math.max(w, h));
}

export interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
}

/** Нарисовать страницы PDF в JPEG. onPage — для «стр. 3 из 12». Ошибка — понятным текстом. */
export async function renderPdf(
  file: Blob,
  onPage?: (done: number, total: number) => void,
): Promise<{ pages: RenderedPage[]; total: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    void task.destroy();
    const name = (err as { name?: string }).name;
    throw new Error(
      name === 'PasswordException'
        ? 'PDF защищён паролем — откройте его и сохраните без пароля'
        : 'Не удалось открыть PDF',
    );
  }
  try {
    const total = doc.numPages;
    const count = Math.min(total, MAX_PDF_PAGES);
    const pages: RenderedPage[] = [];
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageScale(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      // У PDF прозрачный фон, а в JPEG прозрачное станет чёрным.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      page.cleanup();
      if (!blob) throw new Error('Не удалось нарисовать страницу PDF');
      pages.push({ blob, width: canvas.width, height: canvas.height });
      onPage?.(i, count);
    }
    return { pages, total };
  } finally {
    void task.destroy();
  }
}
