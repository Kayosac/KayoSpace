/**
 * MCP-сервер Kayospace: агенты (Claude Code, Claude, ChatGPT) читают и пишут доски.
 * Запись идёт прямо в Yjs-документ хаба — подключённые устройства видят её сразу.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Actor } from '@kayospace/model';
import {
  addElement,
  boardToJSON,
  boardToMarkdown,
  deleteElements,
  elementsMap,
  estimateNoteHeight,
  freeSpot,
  getBoardName,
  getElement,
  listElements,
  makeArrow,
  makeFrame,
  makeShape,
  makeSticky,
  makeText,
  setBoardName,
} from '@kayospace/board';
import type { ArrowEnd, CanvasElement } from '@kayospace/model';
import { searchBoards } from './search';
import { registerLayoutTools } from './mcp-layout';
import { registerExtraTools } from './mcp-extra';
import { registerImageTools } from './mcp-images';
import type { Trash } from './trash';
import { AGENT_GUIDE } from './agent-guide';
import { boardSvg, contentArea, loadImages, renderPng, type Area } from './render';
import type { BoardInfo } from './store';
import type * as Y from 'yjs';

/** Откуда инструменты берут доски: хранилище хаба или черновик задачи ИИ. */
export interface BoardSource {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
  list(): Promise<BoardInfo[]>;
}

export const MCP_ORIGIN = 'mcp';

/** Имя агента в текущем запросе MCP (задаёт хаб по токену или User-Agent). */
export const agentContext = new AsyncLocalStorage<string>();

/** Как назвать агента: приложение OAuth, Claude Code по User-Agent или просто «mcp». */
export function agentNameFor(
  req: { headers: Record<string, string | string[] | undefined> },
  oauthClient: string | null,
): string {
  const named = clientName(oauthClient ?? undefined);
  if (named) return named;
  const ua = String(req.headers['user-agent'] ?? '');
  if (/claude[- ]?code/i.test(ua)) return 'claude-code';
  if (/openai|chatgpt/i.test(ua)) return 'chatgpt';
  if (/claude/i.test(ua)) return 'claude';
  return 'mcp';
}

/** Имя клиента MCP для подписи правок: только безопасные символы, не длиннее 40. */
export function clientName(name: string | undefined): string | undefined {
  const clean = name
    ?.replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 40);
  return clean || undefined;
}

/** Ссылка, по которой приложение открывает доску (и показывает элемент). */
export function boardLink(board: string, element?: string): string {
  return `kayospace://board/${encodeURIComponent(board)}${element ? `?element=${encodeURIComponent(element)}` : ''}`;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

// Служебные документы (воркспейс с проектами) начинаются с «_» — агентам они не доски.
const boardId = z
  .string()
  .regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/)
  .describe('id доски: латиница, цифры, «-» и «_» (не в начале)');

/** Файлы картинок на хабе — чтобы показать их агенту на снимке доски. */
export interface AssetSource {
  get(id: string): Promise<Buffer | null>;
  head(id: string): Promise<{ type: string } | null>;
  /** Сохранить файл (картинки от агентов); у черновиков ИИ записи нет. */
  put?(id: string, data: Buffer): Promise<boolean>;
}

export function createMcp(
  store: BoardSource,
  opts: {
    actorName?: string;
    assets?: AssetSource | null;
    trash?: Trash | null;
    /** Только для тестов: картинки по ссылкам с этого компьютера. */
    allowPrivateImageUrls?: boolean;
  } = {},
) {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: 'kayospace', version: '0.3.0' },
      { instructions: AGENT_GUIDE },
    );
    // Кто пишет: имя клиента MCP (claude-ai, claude-code, openai-mcp…) — устройство покажет,
    // какой агент что изменил.
    const who = (): Actor => ({
      kind: 'agent',
      name:
        opts.actorName ??
        agentContext.getStore() ??
        clientName(server.server.getClientVersion()?.name) ??
        'mcp',
    });

    server.registerTool(
      'list_boards',
      {
        annotations: { readOnlyHint: true },
        description:
          'Список досок Kayospace: id, название, число элементов и проект, в котором доска лежит.',
      },
      async () => text(JSON.stringify(await store.list(), null, 2)),
    );

    server.registerTool(
      'read_board',
      {
        annotations: { readOnlyHint: true },
        description:
          'Прочитать доску. markdown — для чтения (элементы в порядке чтения, сводка рукописного), ' +
          'json — все поля элементов для точных правок (точки штрихов опущены).',
        inputSchema: z.object({
          board: boardId,
          format: z.enum(['markdown', 'json']).optional(),
        }),
      },
      async ({ board, format }) => {
        if (!(await store.has(board))) return fail(`Доски «${board}» нет. Список — list_boards.`);
        const doc = await store.get(board);
        return text(
          format === 'json'
            ? JSON.stringify(boardToJSON(doc, board), null, 2)
            : boardToMarkdown(doc, board),
        );
      },
    );

    server.registerTool(
      'add_sticky',
      {
        description:
          'Добавить стикер на доску. Без координат стикер встаёт справа от занятой области. ' +
          'Если доски нет, она создаётся.',
        inputSchema: z.object({
          board: boardId,
          text: z.string().min(1).max(2000),
          x: z.number().optional(),
          y: z.number().optional(),
          color: z.string().optional().describe('цвет фона, например #ffe58a'),
          boardName: z.string().optional().describe('название для новой доски'),
        }),
      },
      async ({ board, text: content, x, y, color, boardName }) => {
        const doc = await store.get(board);
        if (boardName && !getBoardName(doc)) setBoardName(doc, boardName, MCP_ORIGIN);
        const spot = x !== undefined && y !== undefined ? { x, y } : freeSpot(doc);
        // Шрифт стикера подбирается под его размер сам — стикер остаётся квадратным.
        const sticky = makeSticky(content, { ...spot, color, actor: who() });
        addElement(doc, sticky, MCP_ORIGIN);
        return text(`Стикер добавлен: ${sticky.id} в (${spot.x}, ${spot.y}).`);
      },
    );

    server.registerTool(
      'add_text',
      {
        description:
          'Добавить надпись (заголовок, абзац) на доску. Без координат — справа от занятой области.',
        inputSchema: z.object({
          board: boardId,
          text: z.string().min(1).max(5000),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().positive().optional().describe('ширина блока, по умолчанию 320'),
          color: z.string().optional().describe('цвет текста; без него — цвет темы'),
        }),
      },
      async ({ board, text: content, x, y, width, color }) => {
        const doc = await store.get(board);
        const spot = x !== undefined && y !== undefined ? { x, y } : freeSpot(doc);
        const base = makeText(content, { ...spot, w: width, color, actor: who() });
        const el = { ...base, h: estimateNoteHeight(content, base.w, { sticky: false }) };
        addElement(doc, el, MCP_ORIGIN);
        return text(`Текст добавлен: ${el.id} в (${spot.x}, ${spot.y}).`);
      },
    );

    server.registerTool(
      'add_shape',
      {
        description:
          'Добавить прямоугольник или эллипс (рамку без заливки) по координатам и размеру.',
        inputSchema: z.object({
          board: boardId,
          shape: z.enum(['rect', 'ellipse']),
          x: z.number(),
          y: z.number(),
          w: z.number().positive(),
          h: z.number().positive(),
          color: z.string().optional(),
          lineWidth: z.number().positive().optional().describe('толщина линии, по умолчанию 2'),
        }),
      },
      async ({ board, shape, x, y, w, h, color, lineWidth }) => {
        const doc = await store.get(board);
        const el = makeShape(shape, { x, y, w, h }, { size: lineWidth ?? 2, color, actor: who() });
        addElement(doc, el, MCP_ORIGIN);
        return text(`Фигура добавлена: ${el.id}.`);
      },
    );

    server.registerTool(
      'add_frame',
      {
        description:
          'Добавить фрейм — именованную область (например, «Неделя 1», «Идеи»). Фрейм лежит под ' +
          'элементами; всё, что внутри него, человек переносит и экспортирует вместе с фреймом. ' +
          'Удобно раскладывать схемы и группы стикеров по фреймам.',
        inputSchema: z.object({
          board: boardId,
          name: z.string().min(1).max(100),
          x: z.number(),
          y: z.number(),
          w: z.number().positive(),
          h: z.number().positive(),
        }),
      },
      async ({ board, name, x, y, w, h }) => {
        const doc = await store.get(board);
        const el = makeFrame(name, { x, y, w, h }, { actor: who() });
        addElement(doc, el, MCP_ORIGIN);
        return text(`Фрейм добавлен: ${el.id}.`);
      },
    );

    const endSchema = z
      .union([z.string().describe('id элемента'), z.object({ x: z.number(), y: z.number() })])
      .describe('id элемента (стрелка будет тянуться за ним) или точка {x, y}');

    server.registerTool(
      'add_arrow',
      {
        description:
          'Соединить стрелкой два элемента или точки. Привязанная к элементу стрелка ' +
          'тянется за ним, когда его двигают. heads: none — линия, end — стрелка, both — в обе стороны.',
        inputSchema: z.object({
          board: boardId,
          from: endSchema,
          to: endSchema,
          heads: z.enum(['none', 'end', 'both']).optional(),
          color: z.string().optional(),
        }),
      },
      async ({ board, from, to, heads, color }) => {
        if (!(await store.has(board))) return fail(`Доски «${board}» нет. Список — list_boards.`);
        const doc = await store.get(board);
        const resolve = (
          e: string | { x: number; y: number },
        ): { end: ArrowEnd; at: { x: number; y: number } } | string => {
          if (typeof e !== 'string') return { end: { kind: 'point', ...e }, at: e };
          const el = getElement(doc, e);
          if (!el) return `Элемента ${e} нет на доске.`;
          return {
            end: { kind: 'element', id: e },
            at: { x: el.x + el.w / 2, y: el.y + el.h / 2 },
          };
        };
        const a = resolve(from);
        const b = resolve(to);
        if (typeof a === 'string') return fail(a);
        if (typeof b === 'string') return fail(b);
        const base = makeArrow(a.at, b.at, { heads, size: 2, color, actor: who() });
        const el = { ...base, props: { ...base.props, start: a.end, end: b.end } };
        addElement(doc, el, MCP_ORIGIN);
        return text(`Стрелка добавлена: ${el.id}.`);
      },
    );

    server.registerTool(
      'update_element',
      {
        description:
          'Изменить элемент: текст стикера или надписи (у фрейма — его название), положение (x, y), цвет. ' +
          'id — из read_board в формате json.',
        inputSchema: z.object({
          board: boardId,
          id: z.string(),
          text: z.string().max(5000).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          color: z.string().optional(),
        }),
      },
      async ({ board, id, text: content, x, y, color }) => {
        if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
        const doc = await store.get(board);
        const el = getElement(doc, id);
        if (!el) return fail(`Элемента ${id} нет на доске.`);
        let next: CanvasElement = { ...el, updatedBy: who(), updatedAt: Date.now() };
        if (x !== undefined || y !== undefined) {
          const dx = (x ?? el.x) - el.x;
          const dy = (y ?? el.y) - el.y;
          next = { ...next, x: el.x + dx, y: el.y + dy };
          if (next.type === 'arrow') {
            const move = (e: ArrowEnd): ArrowEnd =>
              e.kind === 'point' ? { kind: 'point', x: e.x + dx, y: e.y + dy } : e;
            next = {
              ...next,
              props: { ...next.props, start: move(next.props.start), end: move(next.props.end) },
            };
          }
        }
        if (color !== undefined) next = { ...next, style: { ...next.style, color } };
        if (content !== undefined && next.type === 'frame') {
          next = { ...next, props: { ...next.props, name: content.slice(0, 100) } };
        } else if (content !== undefined) {
          if (next.type !== 'sticky' && next.type !== 'text') {
            return fail('Текст есть только у стикеров, надписей и фреймов (название).');
          }
          // Стикер не растёт (шрифт подбирается сам), надпись — по объёму текста.
          const h =
            next.type === 'sticky'
              ? next.h
              : estimateNoteHeight(content, next.w, {
                  sticky: false,
                  ...(next.style.size ? { fontSize: next.style.size } : {}),
                });
          next =
            next.type === 'sticky'
              ? { ...next, h, props: { ...next.props, content } }
              : { ...next, h, props: { ...next.props, content } };
        }
        doc.transact(() => elementsMap(doc).set(id, next), MCP_ORIGIN);
        return text(`Элемент ${id} изменён.`);
      },
    );

    server.registerTool(
      'delete_elements',
      {
        annotations: { destructiveHint: true },
        description:
          'Удалить элементы с доски по id. Удалённое 7 дней лежит в корзине (list_trash, restore_elements), ' +
          'а человек может отменить удаление на устройстве одним нажатием. Удаляйте только то, о чём просили.',
        inputSchema: z.object({ board: boardId, ids: z.array(z.string()).min(1).max(500) }),
      },
      async ({ board, ids }) => {
        if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
        const doc = await store.get(board);
        const present = ids.filter((id) => getElement(doc, id));
        deleteElements(doc, present, MCP_ORIGIN);
        return text(`Удалено: ${present.length} из ${ids.length}.`);
      },
    );

    registerLayoutTools(server, store, who, MCP_ORIGIN);
    // Корзина, изменения и проекты — только у настоящих досок хаба (у черновиков ИИ их нет).
    if (opts.trash) registerExtraTools(server, store, opts.trash, MCP_ORIGIN);
    const assets = opts.assets;
    if (opts.trash && assets?.put)
      registerImageTools(
        server,
        store,
        { get: (id) => assets.get(id), put: (id, d) => assets.put!(id, d) },
        who,
        MCP_ORIGIN,
        { allowPrivateUrls: opts.allowPrivateImageUrls },
      );

    server.registerTool(
      'view_board',
      {
        annotations: { readOnlyHint: true },
        description:
          'Посмотреть на доску картинкой (PNG): рукописные заметки, рисунки, схемы, картинки — то, ' +
          'чего нет в тексте read_board. Можно всю доску, один фрейм (frame) или область (region). ' +
          'Вместе с картинкой приходит соответствие: координаты на доске = область.x + пиксель / масштаб.',
        inputSchema: z.object({
          board: boardId,
          frame: z.string().optional().describe('id фрейма'),
          region: z
            .object({
              x: z.number(),
              y: z.number(),
              w: z.number().positive(),
              h: z.number().positive(),
            })
            .optional()
            .describe('область доски в её координатах'),
          maxSize: z
            .number()
            .int()
            .min(256)
            .max(2048)
            .optional()
            .describe('длинная сторона картинки в пикселях, по умолчанию 1600'),
        }),
      },
      async ({ board, frame, region, maxSize }) => {
        if (!(await store.has(board))) return fail(`Доски «${board}» нет. Список — list_boards.`);
        const doc = await store.get(board);
        const all = listElements(doc);
        let area: Area | null;
        if (frame) {
          const f = getElement(doc, frame);
          if (!f || f.type !== 'frame') return fail(`Фрейма ${frame} на доске нет.`);
          area = contentArea([f]);
        } else if (region) {
          area = region;
        } else {
          area = contentArea(all);
        }
        if (!area) return text('Доска пустая — смотреть нечего.');
        const pad = region ? 0 : 40;
        const padded = {
          x: area.x - pad,
          y: area.y - pad,
          w: area.w + pad * 2,
          h: area.h + pad * 2,
        };
        const images = await loadImages(all, opts.assets ?? null);
        const { svg, width, height, scale } = boardSvg(all, padded, { maxSize, images });
        const png = renderPng(svg);
        return {
          content: [
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
            {
              type: 'text' as const,
              text:
                `Картинка ${width}×${height} px, область доски (${Math.round(padded.x)}, ${Math.round(padded.y)}) ` +
                `${Math.round(padded.w)}×${Math.round(padded.h)}, масштаб ${Math.round(scale * 1000) / 1000} px на единицу.`,
            },
          ],
        };
      },
    );

    server.registerTool(
      'search',
      {
        annotations: { readOnlyHint: true },
        description:
          'Найти текст на всех досках: стикеры, надписи, подписи фигур и стрелок, названия фреймов. ' +
          'Регистр не важен. Результат — { results: [{ id, title, url, text, board, type }] }; ' +
          'id подходит для fetch, url открывает доску в приложении.',
        inputSchema: z.object({ query: z.string().min(1) }),
      },
      async ({ query }) => {
        const hits = await searchBoards(store, query, 200);
        const results = hits.map((h) => ({
          id: `${h.board}#${h.id}`,
          title: `${h.boardName ?? h.board}: ${h.text.replace(/\s+/g, ' ').slice(0, 80)}`,
          url: boardLink(h.board, h.id),
          text: h.text,
          board: h.board,
          boardName: h.boardName,
          element: h.id,
          type: h.type,
        }));
        return text(JSON.stringify({ results }, null, 2));
      },
    );

    server.registerTool(
      'fetch',
      {
        annotations: { readOnlyHint: true },
        description:
          'Получить доску целиком по id из search (вида «доска#элемент») или по id доски: ' +
          'текст доски в markdown и ссылка на неё. Для рукописного и рисунков — view_board.',
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      async ({ id }) => {
        const [board, element] = id.split('#');
        const parsed = boardId.safeParse(board);
        if (!parsed.success || !(await store.has(parsed.data)))
          return fail(`Доски «${board}» нет.`);
        const doc = await store.get(parsed.data);
        const name = getBoardName(doc) ?? parsed.data;
        return text(
          JSON.stringify(
            {
              id,
              title: name,
              text: boardToMarkdown(doc, parsed.data),
              url: boardLink(parsed.data, element),
              metadata: { board: parsed.data, ...(element ? { element } : {}) },
            },
            null,
            2,
          ),
        );
      },
    );

    return server;
  });
}
