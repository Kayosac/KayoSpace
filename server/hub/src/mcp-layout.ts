/**
 * Инструменты MCP для раскладки (решение 0015): агент добавляет пачку стикеров и надписей одним
 * вызовом и раскладывает элементы сеткой, рядом или столбцом — без ручного счёта координат.
 * Всё, что делает один вызов, записывается одной транзакцией: устройства видят это одним изменением
 * и могут одним нажатием его отменить.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  FRAME_TITLE_SIZE,
  elementBounds,
  elementsMap,
  estimateNoteHeight,
  freeSpot,
  getBoardName,
  getElement,
  layoutBoxes,
  listElements,
  makeFrame,
  makeSticky,
  makeText,
  setBoardName,
  transformElement,
  type Layout,
} from '@kayospace/board';
import type { Actor, CanvasElement, FrameElement } from '@kayospace/model';

/** Отступ содержимого от края фрейма. */
const FRAME_PAD = 32;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
}

const layoutSchema = z
  .enum(['grid', 'row', 'column'])
  .optional()
  .describe('grid — сетка (по умолчанию), row — в ряд, column — столбцом');

/** Элементы, лежащие во фрейме: центр внутри; вложенный фрейм — целиком внутри. */
export function frameContents(frame: FrameElement, all: readonly CanvasElement[]): CanvasElement[] {
  const inside = (x: number, y: number) =>
    x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;
  return all.filter((el) => {
    if (el.id === frame.id) return false;
    if (el.type === 'frame') return inside(el.x, el.y) && inside(el.x + el.w, el.y + el.h);
    return inside(el.x + el.w / 2, el.y + el.h / 2);
  });
}

/** Куда класть содержимое во фрейме: под тем, что в нём уже лежит. */
function frameOrigin(frame: FrameElement, all: readonly CanvasElement[]): { x: number; y: number } {
  const b = elementBounds(frameContents(frame, all));
  return {
    x: frame.x + FRAME_PAD,
    y: b ? Math.max(frame.y + FRAME_PAD, b.maxY + 24) : frame.y + FRAME_PAD,
  };
}

/** Растянуть фрейм так, чтобы раскладка поместилась с отступом. */
function grown(frame: FrameElement, right: number, bottom: number, actor: Actor): FrameElement {
  const w = Math.max(frame.w, right + FRAME_PAD - frame.x);
  const h = Math.max(frame.h, bottom + FRAME_PAD - frame.y);
  if (w === frame.w && h === frame.h) return frame;
  return { ...frame, w, h, updatedBy: actor, updatedAt: Date.now() };
}

export function registerLayoutTools(
  server: McpServer,
  store: Source,
  agentOf: () => Actor,
  origin: unknown,
): void {
  const boardId = z.string().regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/);

  server.registerTool(
    'add_elements',
    {
      description:
        'Добавить сразу много стикеров и надписей и разложить их: сеткой, в ряд или столбцом. ' +
        'Куда: at — левый верхний угол; frame — внутрь существующего фрейма (под его содержимым, ' +
        'фрейм растянется); newFrame — в новый фрейм с этим названием; ничего — справа от занятой ' +
        'области. Лучше этого инструмента, чем add_sticky по одному: координаты считаются сами, ' +
        'а человек видит и может отменить всё одним действием. Доски нет — создаётся.',
      inputSchema: z.object({
        board: boardId,
        items: z
          .array(
            z.object({
              type: z.enum(['sticky', 'text']).optional().describe('по умолчанию sticky'),
              text: z.string().min(1).max(5000),
              color: z
                .string()
                .optional()
                .describe('стикер — фон (#ffe58a), надпись — цвет текста'),
              width: z.number().positive().optional().describe('ширина надписи, по умолчанию 320'),
            }),
          )
          .min(1)
          .max(100),
        layout: layoutSchema,
        columns: z.number().int().positive().optional(),
        gap: z.number().nonnegative().optional().describe('промежуток, по умолчанию 24'),
        at: z.object({ x: z.number(), y: z.number() }).optional(),
        frame: z.string().optional().describe('id фрейма, в который положить'),
        newFrame: z.string().min(1).max(100).optional().describe('название нового фрейма'),
        boardName: z.string().optional().describe('название для новой доски'),
      }),
    },
    async ({ board, items, layout, columns, gap, at, frame, newFrame, boardName }) => {
      const agent = agentOf();
      const doc = await store.get(board);
      const all = listElements(doc);
      let target: FrameElement | null = null;
      if (frame) {
        const f = getElement(doc, frame);
        if (!f || f.type !== 'frame') return fail(`Фрейма ${frame} на доске нет.`);
        target = f;
      }
      const els: CanvasElement[] = items.map((it) => {
        if (it.type === 'text') {
          const base = makeText(it.text, {
            x: 0,
            y: 0,
            w: it.width,
            color: it.color,
            actor: agent,
          });
          return { ...base, h: estimateNoteHeight(it.text, base.w, { sticky: false }) };
        }
        return makeSticky(it.text, { x: 0, y: 0, color: it.color, actor: agent });
      });
      const start = at
        ? at
        : target
          ? frameOrigin(target, all)
          : (() => {
              const s = freeSpot(doc, newFrame ? 80 : 40);
              // В новом фрейме место под заголовок и отступ.
              return newFrame
                ? { x: s.x + FRAME_PAD, y: s.y + FRAME_PAD + FRAME_TITLE_SIZE * 1.8 }
                : s;
            })();
      const placed = layoutBoxes(els, {
        layout: (layout ?? 'grid') as Layout,
        columns,
        gap,
        origin: start,
      });
      const out = els.map((el, i) => ({ ...el, ...placed.positions[i]! }));
      const right = start.x + placed.width;
      const bottom = start.y + placed.height;
      let frameId: string | null = target?.id ?? null;
      doc.transact(() => {
        if (boardName && !getBoardName(doc)) setBoardName(doc, boardName);
        const map = elementsMap(doc);
        if (newFrame) {
          const f = makeFrame(
            newFrame,
            {
              x: start.x - FRAME_PAD,
              y: start.y - FRAME_PAD,
              w: placed.width + FRAME_PAD * 2,
              h: placed.height + FRAME_PAD * 2,
            },
            { actor: agent },
          );
          map.set(f.id, f);
          frameId = f.id;
        } else if (target) {
          map.set(target.id, grown(target, right, bottom, agent));
        }
        for (const el of out) map.set(el.id, el);
      }, origin);
      return text(
        JSON.stringify(
          {
            added: out.map((el) => ({
              id: el.id,
              type: el.type,
              x: Math.round(el.x),
              y: Math.round(el.y),
            })),
            frame: frameId,
            bounds: { x: start.x, y: start.y, w: placed.width, h: placed.height },
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    'arrange_elements',
    {
      description:
        'Разложить уже существующие элементы (по id, в указанном порядке) сеткой, в ряд или столбцом. ' +
        'Куда: at — левый верхний угол; frame — внутрь фрейма (фрейм растянется); ничего — от ' +
        'левого верхнего угла этих элементов. Подходит, чтобы навести порядок или сгруппировать ' +
        'стикеры по темам (по фрейму на тему).',
      inputSchema: z.object({
        board: boardId,
        ids: z.array(z.string()).min(1).max(300),
        layout: layoutSchema,
        columns: z.number().int().positive().optional(),
        gap: z.number().nonnegative().optional(),
        at: z.object({ x: z.number(), y: z.number() }).optional(),
        frame: z.string().optional(),
      }),
    },
    async ({ board, ids, layout, columns, gap, at, frame }) => {
      const agent = agentOf();
      if (!(await store.has(board))) return fail(`Доски «${board}» нет. Список — list_boards.`);
      const doc = await store.get(board);
      const els = ids.map((id) => getElement(doc, id)).filter((e): e is CanvasElement => !!e);
      if (els.length === 0) return fail('Ни одного из этих элементов на доске нет.');
      let target: FrameElement | null = null;
      if (frame) {
        const f = getElement(doc, frame);
        if (!f || f.type !== 'frame') return fail(`Фрейма ${frame} на доске нет.`);
        target = f;
      }
      const others = listElements(doc).filter((e) => !ids.includes(e.id));
      const b = elementBounds(els)!;
      const start = at ?? (target ? frameOrigin(target, others) : { x: b.minX, y: b.minY });
      const placed = layoutBoxes(els, {
        layout: (layout ?? 'grid') as Layout,
        columns,
        gap,
        origin: start,
      });
      doc.transact(() => {
        const map = elementsMap(doc);
        els.forEach((el, i) => {
          const p = placed.positions[i]!;
          map.set(el.id, transformElement(el, { s: 1, tx: p.x - el.x, ty: p.y - el.y }, agent));
        });
        if (target)
          map.set(target.id, grown(target, start.x + placed.width, start.y + placed.height, agent));
      }, origin);
      const missing = ids.length - els.length;
      return text(
        `Разложено: ${els.length}${missing ? `, не найдено: ${missing}` : ''}. ` +
          `Область: (${Math.round(start.x)}, ${Math.round(start.y)}), ${Math.round(placed.width)}×${Math.round(placed.height)}.`,
      );
    },
  );

  server.registerTool(
    'move_elements',
    {
      description:
        'Сдвинуть элементы на (dx, dy). Фрейм едет вместе с содержимым, как у человека. ' +
        'Привязанные стрелки тянутся следом.',
      inputSchema: z.object({
        board: boardId,
        ids: z.array(z.string()).min(1).max(500),
        dx: z.number(),
        dy: z.number(),
      }),
    },
    async ({ board, ids, dx, dy }) => {
      const agent = agentOf();
      if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
      const doc = await store.get(board);
      const all = listElements(doc);
      const moving = new Map<string, CanvasElement>();
      for (const id of ids) {
        const el = getElement(doc, id);
        if (!el) continue;
        moving.set(el.id, el);
        if (el.type === 'frame') for (const c of frameContents(el, all)) moving.set(c.id, c);
      }
      if (moving.size === 0) return fail('Ни одного из этих элементов на доске нет.');
      doc.transact(() => {
        const map = elementsMap(doc);
        for (const el of moving.values())
          map.set(el.id, transformElement(el, { s: 1, tx: dx, ty: dy }, agent));
      }, origin);
      return text(`Сдвинуто: ${moving.size} (с содержимым фреймов).`);
    },
  );
}
