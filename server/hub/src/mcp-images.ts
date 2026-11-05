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
  renderSvgImage,
  type ImageInfo,
} from './images';
import { frameOrigin, grown } from './mcp-layout';
import { renderPng } from './render';
import { OpenAiError, type OpenAi } from './openai';

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

const boardId = z
  .string()
  .regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/)
  .refine((id) => !id.startsWith('pg_'), 'Это документ, а не доска: read_page / write_page');

interface Loaded {
  id: string;
  info: ImageInfo;
  alt?: string;
  width?: number;
}

export function registerImageTools(
  server: McpServer,
  store: Source,
  assets: ImageAssets,
  agentOf: () => Actor,
  origin: unknown,
  opts: { allowPrivateUrls?: boolean; openai?: OpenAi | null } = {},
): void {
  /** Скачать или раскодировать картинку и положить файл в хранилище; строка — понятная ошибка. */
  const load = async (
    src: { url: string } | { data: string } | { svg: string },
  ): Promise<{ id: string; info: ImageInfo } | string> => {
    let bytes: Buffer | null;
    try {
      if ('svg' in src) {
        const png = renderSvgImage(src.svg);
        if (typeof png === 'string') return png;
        bytes = png;
      } else {
        bytes =
          'url' in src
            ? await fetchImage(src.url, { allowPrivate: opts.allowPrivateUrls })
            : decodeImageData(src.data);
      }
    } catch (err) {
      if (err instanceof ImageFetchError) return err.message;
      throw err;
    }
    if (!bytes) return 'data — не base64.';
    if (bytes.length > MAX_AGENT_IMAGE_BYTES) return 'больше 15 МБ.';
    const info = imageInfo(bytes);
    if (!info || !(IMAGE_TYPES as readonly string[]).includes(info.mime))
      return 'это не картинка PNG, JPEG, GIF или WebP.';
    const id = sha256(bytes);
    await assets.put(id, bytes);
    return { id, info };
  };

  /** Разложить картинки на доске одной транзакцией. */
  const place = async (
    board: string,
    loaded: readonly Loaded[],
    o: {
      layout?: Layout;
      columns?: number;
      gap?: number;
      at?: { x: number; y: number };
      frame?: string;
    },
  ) => {
    const agent = agentOf();
    const doc = await store.get(board);
    let target: FrameElement | null = null;
    if (o.frame) {
      const f = getElement(doc, o.frame);
      if (!f || f.type !== 'frame') return fail(`Фрейма ${o.frame} на доске нет.`);
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
    const start = o.at ?? (target ? frameOrigin(target, listElements(doc)) : freeSpot(doc, 40));
    const placed = layoutBoxes(els, {
      layout: o.layout ?? 'grid',
      columns: o.columns,
      gap: o.gap,
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
  };

  server.registerTool(
    'add_images',
    {
      description:
        'Положить на доску картинки (PNG, JPEG, GIF, WebP, до 15 МБ каждая): по ссылке (url), ' +
        'файлом (data — base64) или нарисовать самому (svg — разметка SVG, станет картинкой PNG). ' +
        'Раскладываются, как в add_elements: сеткой, в ряд или столбцом; ' +
        'at — левый верхний угол, frame — внутрь фрейма, иначе — справа от занятого. Ширина по ' +
        'умолчанию 480 (пропорции сохраняются). alt — подпись: по ней картинку найдут поиском.',
      inputSchema: z.object({
        board: boardId,
        images: z
          .array(
            z.object({
              url: z.string().url().optional().describe('ссылка на картинку (http/https)'),
              data: z.string().optional().describe('картинка в base64 (или data:-ссылка)'),
              svg: z
                .string()
                .optional()
                .describe('нарисовать самому: SVG с width/height или viewBox, без внешних ссылок'),
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
      // Сначала все файлы: если хоть один не получился, на доске ничего не меняется.
      const loaded: Loaded[] = [];
      for (const [i, img] of images.entries()) {
        const n = images.length > 1 ? `Картинка ${i + 1}: ` : '';
        const given = [img.url, img.data, img.svg].filter((v) => v !== undefined).length;
        if (given !== 1) return fail(`${n}нужно что-то одно — url, data или svg.`);
        const r = await load(
          img.url ? { url: img.url } : img.data ? { data: img.data } : { svg: img.svg! },
        );
        if (typeof r === 'string') return fail(n + r);
        loaded.push({ ...r, alt: img.alt, width: img.width });
      }
      return place(board, loaded, { layout, columns, gap, at, frame });
    },
  );

  server.registerTool(
    'add_image_file',
    {
      description:
        'Положить на доску картинку-файл из чата: ту, что человек прислал, или ту, что ты ' +
        'нарисовал (сгенерировал). Файл передаётся в поле file — ChatGPT подставляет его сам. ' +
        'Картинка по ссылке из интернета — add_images с url.',
      inputSchema: z.object({
        board: boardId,
        file: z
          .object({
            download_url: z.string(),
            file_id: z.string(),
            mime_type: z.string().optional(),
            file_name: z.string().optional(),
          })
          .strict()
          .describe('файл из чата'),
        alt: z.string().max(500).optional().describe('что на картинке'),
        width: z
          .number()
          .positive()
          .max(4000)
          .optional()
          .describe('ширина на доске, по умолчанию 480'),
        at: z.object({ x: z.number(), y: z.number() }).optional(),
        frame: z.string().optional().describe('id фрейма, в который положить'),
      }),
      // ChatGPT (Apps SDK): это поле принимает файл из чата — загруженный или сгенерированный.
      _meta: { 'openai/fileParams': ['file'] },
    },
    async ({ board, file, alt, width, at, frame }) => {
      // download_url — временная ссылка-ключ: не пишем её ни в ответ, ни в журнал.
      const r = await load({ url: file.download_url });
      if (typeof r === 'string') return fail(r);
      return place(board, [{ ...r, alt: alt ?? file.file_name, width }], { at, frame });
    },
  );

  const openai = opts.openai;
  if (openai) {
    server.registerTool(
      'generate_image',
      {
        description:
          'Нарисовать картинку генератором изображений (OpenAI) и положить на доску — для «нарисуй …», ' +
          '«сгенерируй …». prompt — подробное описание по-английски: что изображено, стиль, цвета, ' +
          'надписи (в кавычках, на нужном языке). Не для фото из интернета — их ищи и клади по url.',
        inputSchema: z.object({
          board: boardId,
          prompt: z.string().min(3).max(4000),
          alt: z.string().max(500).optional().describe('подпись по-русски: что на картинке'),
          shape: z
            .enum(['square', 'landscape', 'portrait'])
            .optional()
            .describe('квадрат (по умолчанию), горизонтальная или вертикальная'),
          width: z
            .number()
            .positive()
            .max(4000)
            .optional()
            .describe('ширина на доске, по умолчанию 480'),
          at: z.object({ x: z.number(), y: z.number() }).optional(),
          frame: z.string().optional().describe('id фрейма, в который положить'),
        }),
      },
      async ({ board, prompt, alt, shape, width, at, frame }) => {
        let bytes: Buffer;
        try {
          bytes = await openai.generateImage(prompt, shape ?? 'square');
        } catch (err) {
          if (err instanceof OpenAiError) return fail(err.message);
          throw err;
        }
        const r = await load({ data: bytes.toString('base64') });
        if (typeof r === 'string') return fail(`OpenAI вернул не то: ${r}`);
        return place(board, [{ ...r, alt: alt ?? prompt.slice(0, 200), width }], { at, frame });
      },
    );
  }

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
