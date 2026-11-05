/**
 * Инструменты MCP для картинок (решение 0016): агент кладёт картинки на доску — по ссылке или
 * присланным файлом (base64) — и смотрит картинку с доски целиком, в полном разрешении.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  elementsMap,
  freeSpot,
  getElement,
  layoutBoxes,
  listElements,
  makeImage,
  type Layout,
} from '@kayospace/board';
import type { Actor, FrameElement } from '@kayospace/model';
import { sha256 } from './assets';
import {
  IMAGE_TYPES,
  ImageFetchError,
  MAX_AGENT_IMAGE_BYTES,
  decodeImageData,
  fetchImage,
  imageInfo,
  type ImageInfo,
} from './images';
import { frameOrigin, grown } from './mcp-layout';
import { renderPng } from './render';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
}

export interface ImageAssets {
  get(id: string): Promise<Buffer | null>;
  put(id: string, data: Buffer): Promise<boolean>;
}

/** Ширина картинки на доске по умолчанию (большие фото — не во всю доску). */
const DEFAULT_WIDTH = 480;
/** Сколько байт отдаём агенту как есть; больше — уменьшаем. */
const MAX_SEND_BYTES = 3.5 * 1024 * 1024;

const boardId = z.string().regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/);

export function registerImageTools(
  server: McpServer,
  store: Source,
  assets: ImageAssets,
  agentOf: () => Actor,
  origin: unknown,
  opts: { allowPrivateUrls?: boolean } = {},
): void {
  server.registerTool(
    'add_images',
    {
      description:
        'Положить на доску картинки (PNG, JPEG, GIF, WebP, до 15 МБ каждая): по ссылке (url) или ' +
        'файлом (data — base64). Раскладываются, как в add_elements: сеткой, в ряд или столбцом; ' +
        'at — левый верхний угол, frame — внутрь фрейма, иначе — справа от занятого. Ширина по ' +
        'умолчанию 480 (пропорции сохраняются). alt — подпись: по ней картинку найдут поиском.',
      inputSchema: z.object({
        board: boardId,
        images: z
          .array(
            z.object({
              url: z.string().url().optional().describe('ссылка на картинку (http/https)'),
              data: z.string().optional().describe('картинка в base64 (или data:-ссылка)'),
              alt: z.string().max(500).optional().describe('что на картинке'),
              width: z.number().positive().max(4000).optional().describe('ширина на доске'),
            }),
          )
          .min(1)
          .max(10),
        layout: z.enum(['grid', 'row', 'column']).optional(),
        columns: z.number().int().positive().optional(),
        gap: z.number().nonnegative().optional(),
        at: z.object({ x: z.number(), y: z.number() }).optional(),
        frame: z.string().optional().describe('id фрейма, в который положить'),
      }),
    },
    async ({ board, images, layout, columns, gap, at, frame }) => {
      const agent = agentOf();
      // Сначала все файлы: если хоть один не получился, на доске ничего не меняется.
      const loaded: { id: string; info: ImageInfo; alt?: string; width?: number }[] = [];
      for (const [i, img] of images.entries()) {
        const n = images.length > 1 ? `Картинка ${i + 1}: ` : '';
        if (!img.url === !img.data) return fail(`${n}нужно что-то одно — url или data.`);
        let bytes: Buffer | null;
        try {
          bytes = img.url
            ? await fetchImage(img.url, { allowPrivate: opts.allowPrivateUrls })
            : decodeImageData(img.data!);
        } catch (err) {
          if (err instanceof ImageFetchError) return fail(n + err.message);
          throw err;
        }
        if (!bytes) return fail(`${n}data — не base64.`);
        if (bytes.length > MAX_AGENT_IMAGE_BYTES) return fail(`${n}больше 15 МБ.`);
        const info = imageInfo(bytes);
        if (!info || !(IMAGE_TYPES as readonly string[]).includes(info.mime))
          return fail(`${n}это не картинка PNG, JPEG, GIF или WebP.`);
        const id = sha256(bytes);
        await assets.put(id, bytes);
        loaded.push({ id, info, alt: img.alt, width: img.width });
      }

      const doc = await store.get(board);
      let target: FrameElement | null = null;
      if (frame) {
        const f = getElement(doc, frame);
        if (!f || f.type !== 'frame') return fail(`Фрейма ${frame} на доске нет.`);
        target = f;
      }
      const els = loaded.map((l) => {
        const w = l.width ?? Math.min(l.info.width, DEFAULT_WIDTH);
        const h = Math.round((w * l.info.height) / l.info.width);
        return makeImage(
          l.id,
          { x: 0, y: 0, w, h },
          { naturalW: l.info.width, naturalH: l.info.height, alt: l.alt, actor: agent },
        );
      });
      const start = at ?? (target ? frameOrigin(target, listElements(doc)) : freeSpot(doc, 40));
      const placed = layoutBoxes(els, {
        layout: (layout ?? 'grid') as Layout,
        columns,
        gap,
        origin: start,
      });
      const out = els.map((el, i) => ({ ...el, ...placed.positions[i]! }));
      doc.transact(() => {
        const map = elementsMap(doc);
        if (target)
          map.set(target.id, grown(target, start.x + placed.width, start.y + placed.height, agent));
        for (const el of out) map.set(el.id, el);
      }, origin);
      return text(
        JSON.stringify(
          {
            added: out.map((el) => ({
              id: el.id,
              x: Math.round(el.x),
              y: Math.round(el.y),
              w: Math.round(el.w),
              h: Math.round(el.h),
              natural: `${el.props.naturalW}×${el.props.naturalH}`,
            })),
            frame: target?.id ?? null,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    'get_image',
    {
      description:
        'Посмотреть картинку с доски в полном разрешении (view_board показывает её мелко, вместе ' +
        'со всем вокруг). Большие уменьшаются до maxSize по длинной стороне.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        board: boardId,
        id: z.string().describe('id элемента-картинки'),
        maxSize: z.number().int().min(256).max(2048).optional().describe('по умолчанию 1568'),
      }),
    },
    async ({ board, id, maxSize }) => {
      if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
      const el = getElement(await store.get(board), id);
      if (!el || el.type !== 'image') return fail(`Картинки ${id} на доске нет.`);
      const bytes = await assets.get(el.props.assetId);
      if (!bytes) return fail('Файл картинки на хабе не найден (ещё не загрузился с устройства?).');
      const info = imageInfo(bytes);
      if (!info) return fail('Файл картинки не читается.');
      const limit = maxSize ?? 1568;
      const caption = (w: number, h: number) => ({
        type: 'text' as const,
        text:
          `Картинка ${info.width}×${info.height}${w !== info.width ? `, показана ${w}×${h}` : ''}` +
          (el.props.alt ? `. Подпись: ${el.props.alt}` : '') +
          `. На доске: (${Math.round(el.x)}, ${Math.round(el.y)}) ${Math.round(el.w)}×${Math.round(el.h)}.`,
      });
      const big = Math.max(info.width, info.height) > limit || bytes.length > MAX_SEND_BYTES;
      // WebP resvg не рисует — его отдаём как есть, если не слишком тяжёлый.
      if (!big || (info.mime === 'image/webp' && bytes.length <= MAX_SEND_BYTES * 1.4)) {
        return {
          content: [
            { type: 'image' as const, data: bytes.toString('base64'), mimeType: info.mime },
            caption(info.width, info.height),
          ],
        };
      }
      if (info.mime === 'image/webp') return fail('Картинка WebP слишком большая, чтобы показать.');
      const s = Math.min(1, limit / Math.max(info.width, info.height));
      const w = Math.max(1, Math.round(info.width * s));
      const h = Math.max(1, Math.round(info.height * s));
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<image width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="data:${info.mime};base64,${bytes.toString('base64')}"/></svg>`;
      const png = renderPng(svg);
      return {
        content: [
          { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
          caption(w, h),
        ],
      };
    },
  );
}
