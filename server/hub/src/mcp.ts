/**
 * MCP-сервер Kayospace: агенты (Claude Code, Claude, ChatGPT) читают и пишут доски.
 * Запись идёт прямо в Yjs-документ хаба — подключённые устройства видят её сразу.
 */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Actor } from '@kayospace/model';
import {
  addElement,
  boardToJSON,
  boardToMarkdown,
  elementText,
  freeSpot,
  getBoardName,
  listElements,
  makeSticky,
  setBoardName,
} from '@kayospace/board';
import type { BoardStore } from './store';

export const MCP_ORIGIN = 'mcp';
const agent: Actor = { kind: 'agent', name: 'mcp' };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const boardId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('id доски: латиница, цифры, «-» и «_»');

export function createMcp(store: BoardStore) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'kayospace', version: '0.1.0' });

    server.registerTool(
      'list_boards',
      { description: 'Список досок Kayospace: id, название и число элементов на каждой.' },
      async () => text(JSON.stringify(await store.list(), null, 2)),
    );

    server.registerTool(
      'read_board',
      {
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
        const sticky = makeSticky(content, { ...spot, color, actor: agent });
        addElement(doc, sticky, MCP_ORIGIN);
        return text(`Стикер добавлен: ${sticky.id} в (${spot.x}, ${spot.y}).`);
      },
    );

    server.registerTool(
      'search',
      {
        description: 'Найти текст на всех досках (стикеры, тексты, подписи). Регистр не важен.',
        inputSchema: z.object({ query: z.string().min(1) }),
      },
      async ({ query }) => {
        const q = query.toLowerCase();
        const hits: { board: string; id: string; type: string; text: string }[] = [];
        for (const info of await store.list()) {
          const doc = await store.get(info.id);
          for (const el of listElements(doc)) {
            const t = elementText(el);
            if (t.toLowerCase().includes(q))
              hits.push({ board: info.id, id: el.id, type: el.type, text: t });
          }
        }
        return text(hits.length ? JSON.stringify(hits, null, 2) : 'Ничего не найдено.');
      },
    );

    return server;
  });
}
