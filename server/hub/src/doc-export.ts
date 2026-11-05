/**
 * Миниатюры карточек и экспорт в PDF (решение 0022).
 *
 *   GET /api/docs?ids=pg_a,tb_b   — название, начало текста и миниатюра (id картинки) документов для карточек
 *   GET /api/export/<id>.pdf       — документ, таблица или доска (по странице на фрейм) в PDF
 *
 * Миниатюра — верх первой страницы, картинкой в хранилище (как картинки досок): её рисуют холст,
 * PDF и картинка доски для агентов, на устройстве она сохраняется и без связи. Пересчитывается,
 * только когда документ изменился.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Y from 'yjs';
import { getBoardName, getElement, listElements } from '@kayospace/board';
import { docExcerpt, docKind, isDocId } from '@kayospace/page';
import { sha256 } from './assets';
import { json } from './devices-api';
import { embedLoader, pagePages, tablePages, thumbnailPng } from './doc-render';
import { buildRasterPdf, rasterize } from './pdf';
import { boardSvg, contentArea, loadImages } from './render';

interface Store {
  has(id: string): Promise<boolean>;
  get(id: string): Promise<Y.Doc>;
  isDeleted(id: string): Promise<boolean>;
}

interface Assets {
  get(id: string): Promise<Buffer | null>;
  head(id: string): Promise<{ type: string } | null>;
  put(id: string, data: Buffer): Promise<boolean>;
}

export class DocThumbs {
  /** id документа → вектор состояния, при котором сделана миниатюра, и её id. */
  private readonly cache = new Map<string, { sv: string; thumb: string | null }>();

  constructor(
    private readonly store: Store,
    private readonly assets: Assets,
  ) {}

  async thumb(id: string, doc: Y.Doc): Promise<string | null> {
    const sv = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
    const hit = this.cache.get(id);
    if (hit?.sv === sv) return hit.thumb;
    let thumb: string | null = null;
    try {
      const first =
        docKind(id) === 'table'
          ? tablePages(doc, 1, true)[0]
          : (await pagePages(doc, embedLoader(this.store, this.assets), 1, true))[0];
      if (first) {
        const png = thumbnailPng(first);
        thumb = sha256(png);
        if (!(await this.assets.put(thumb, png))) thumb = null;
      }
    } catch (err) {
      console.error('[hub] не получилась миниатюра', id, err);
    }
    this.cache.set(id, { sv, thumb });
    return thumb;
  }

  forget(id: string): void {
    this.cache.delete(id);
  }
}

/** Документ, таблица или доска → PDF. null — нечего печатать. */
export async function exportPdf(
  id: string,
  store: Store,
  assets: Assets,
): Promise<{ pdf: Buffer; title: string } | null> {
  if ((await store.isDeleted(id)) || !(await store.has(id))) return null;
  const doc = await store.get(id);
  const title = getBoardName(doc) ?? id;
  const kind = docKind(id);
  let svgs: string[];
  if (kind === 'table') svgs = tablePages(doc);
  else if (kind === 'page') svgs = await pagePages(doc, embedLoader(store, assets));
  else {
    // Доска: по странице на фрейм (сверху вниз, слева направо), без фреймов — вся доска.
    const all = listElements(doc);
    const frames = all.filter((e) => e.type === 'frame').sort((a, b) => a.y - b.y || a.x - b.x);
    const areas = frames.length
      ? frames.map((f) => contentArea([getElement(doc, f.id)!]))
      : [contentArea(all)];
    const images = await loadImages(all, assets);
    svgs = areas
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => {
        const pad = 24;
        return boardSvg(
          all,
          { x: a.x - pad, y: a.y - pad, w: a.w + pad * 2, h: a.h + pad * 2 },
          { maxSize: 2400, images },
        ).svg;
      });
    if (!svgs.length) return null;
    return {
      pdf: buildRasterPdf(
        svgs.map((s) => rasterize(s, 1)),
        title,
      ),
      title,
    };
  }
  return {
    pdf: buildRasterPdf(
      svgs.map((s) => rasterize(s, 2)),
      title,
    ),
    title,
  };
}

/** GET /api/docs и /api/export/<id>.pdf — false, если адрес не наш. */
export async function handleDocExport(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Store,
  assets: Assets,
  thumbs: DocThumbs,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/docs') {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .filter((id) => isDocId(id) && /^(pg|tb)_[A-Za-z0-9_-]{1,61}$/.test(id))
      .slice(0, 100);
    const docs = [];
    for (const id of ids) {
      if ((await store.isDeleted(id)) || !(await store.has(id))) continue;
      const d = await store.get(id);
      docs.push({
        id,
        kind: docKind(id),
        title: getBoardName(d) ?? null,
        excerpt: docExcerpt(id, d),
        thumb: await thumbs.thumb(id, d),
      });
    }
    json(res, 200, { docs });
    return true;
  }
  const m = /^\/api\/export\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})\.pdf$/.exec(url.pathname);
  if (!m) return false;
  const out = await exportPdf(m[1]!, store, assets);
  if (!out) {
    json(res, 404, { error: 'Нечего экспортировать' });
    return true;
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': out.pdf.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.title)}.pdf`,
  });
  res.end(out.pdf);
  return true;
}
