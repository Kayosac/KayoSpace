/**
 * Документы (решение 0020, «слой Coda»): страницы рядом с досками. Агенты читают и пишут их
 * markdown'ом; фрагмент доски в странице — строка `[[board:<доска>#<фрейм>|Название]]`.
 * Картинка фрагмента для приложения — GET /api/render/<доска>.png?frame=<фрейм>, фреймы доски —
 * GET /api/frames/<доска>.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  WORKSPACE_ID,
  addElement,
  freeSpot,
  makeDocCard,
  getBoardName,
  getElement,
  listElements,
  listProjects,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { docExcerpt, docKind, isDocId, isPageId, pageMarkdown, writePage } from '@kayospace/page';
import { boardSvg, contentArea, loadImages, renderPng } from './render';
import type { BoardInfo } from './store';
import { json } from './devices-api';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
  list(): Promise<BoardInfo[]>;
}

const pageId = z
  .string()
  .regex(/^pg_[A-Za-z0-9_-]{1,61}$/)
  .describe('id документа: «pg_» и латиница, цифры, «-», «_»');

export const PAGE_SYNTAX =
  'Разметка: # / ## / ### заголовки, абзацы, «- » список, «1. » нумерованный, «- [ ] » / «- [x] » чек-лист, ' +
  '«> » цитата, ``` код, --- разделитель; в строке **жирный**, *курсив*, `код`, ~~зачёркнутый~~, [ссылка](https://…). ' +
  'Фрагмент доски — отдельной строкой [[board:<id доски>#<id фрейма>|Название]] (фрейм можно не указывать — тогда вся доска).';

export function registerPageTools(
  server: McpServer,
  store: Source,
  origin: unknown,
  agentOf: () => Actor = () => ({ kind: 'agent', name: 'mcp' }),
): void {
  server.registerTool(
    'place_doc',
    {
      description:
        'Положить на доску карточку документа или таблицы (решение 0021): название и начало текста; ' +
        'человек касается карточки — документ открывается поверх доски. Без x/y — справа от занятого.',
      inputSchema: z.object({
        board: z
          .string()
          .regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/)
          .refine((id) => !isDocId(id), 'Карточку кладут на доску, а не в документ'),
        doc: z
          .string()
          .regex(/^(pg|tb)_[A-Za-z0-9_-]{1,61}$/)
          .describe('id документа «pg_…» или таблицы «tb_…»'),
        x: z.number().optional(),
        y: z.number().optional(),
      }),
    },
    async ({ board, doc: docId, x, y }) => {
      if (!(await store.has(docId))) return fail(`Документа «${docId}» нет. Список — list_boards.`);
      const target = await store.get(board);
      const d = await store.get(docId);
      const spot = x !== undefined && y !== undefined ? { x, y } : freeSpot(target);
      const card = makeDocCard(docId, spot, {
        title: getBoardName(d) ?? undefined,
        excerpt: docExcerpt(docId, d) || undefined,
        actor: agentOf(),
      });
      addElement(target, card, origin);
      return text(
        `Карточка ${docKind(docId) === 'table' ? 'таблицы' : 'документа'} на доске ${board}: ${card.id}.`,
      );
    },
  );

  server.registerTool(
    'read_page',
    {
      annotations: { readOnlyHint: true },
      description:
        'Прочитать документ (страницу) Kayospace в markdown. Документы в list_boards — с kind: "page", id начинается с «pg_». ' +
        PAGE_SYNTAX,
      inputSchema: z.object({ page: pageId }),
    },
    async ({ page }) => {
      if (!(await store.has(page))) return fail(`Документа «${page}» нет. Список — list_boards.`);
      const doc = await store.get(page);
      const name = getBoardName(doc) ?? page;
      const body = pageMarkdown(doc);
      return text(
        `# ${name}\n\n(документ ${page}, ссылка kayospace://board/${page})\n\n${body || '(пусто)'}`,
      );
    },
  );

  server.registerTool(
    'write_page',
    {
      description:
        'Создать или изменить документ. mode "append" (по умолчанию) — дописать в конец, ' +
        '"replace" — заменить содержимое целиком (меняется только отличающееся; используй, только когда правишь сам текст — сначала read_page). ' +
        'Новый документ: дай id «pg_…» и name. ' +
        PAGE_SYNTAX,
      inputSchema: z.object({
        page: pageId,
        markdown: z.string().max(200_000),
        mode: z.enum(['append', 'replace']).optional(),
        name: z.string().min(1).max(120).optional().describe('название (для нового — обязательно)'),
        project: z.string().optional().describe('id или название проекта для нового документа'),
      }),
    },
    async ({ page, markdown, mode, name, project }) => {
      const existed = await store.has(page);
      if (!existed && !name) return fail('Новому документу нужно название (name).');
      let pid: string | undefined;
      if (project && !existed) {
        const ws = await store.get(WORKSPACE_ID);
        pid = listProjects(ws).find(
          (p) => p.id === project || p.name.toLowerCase() === project.toLowerCase(),
        )?.id;
        if (!pid) return fail(`Проекта «${project}» нет. Список — list_projects.`);
      }
      const doc = await store.get(page);
      if (name) setBoardName(doc, name, origin);
      writePage(doc, markdown, mode ?? 'append', origin);
      if (pid) setBoardProject(await store.get(WORKSPACE_ID), page, pid, origin);
      return text(
        `${existed ? 'Документ изменён' : 'Документ создан'}: ${page}. Ссылка: kayospace://board/${page}`,
      );
    },
  );
}

/** Подсказка агенту, который открыл документ как доску. */
export function pageHint(id: string): string | null {
  return isPageId(id) ? `«${id}» — документ, а не доска: читай read_page, пиши write_page.` : null;
}

/**
 * GET /api/render/<доска>.png?frame=<id>&max=<px> — картинка доски или фрейма для фрагмента в документе.
 * false — адрес не наш.
 */
export async function handleRender(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: {
    has(id: string): Promise<boolean>;
    get(id: string): Promise<Y.Doc>;
    isDeleted(id: string): Promise<boolean>;
  },
  assets: Parameters<typeof loadImages>[1],
): Promise<boolean> {
  // Фреймы доски — чтобы выбрать фрагмент для документа.
  const fr = /^\/api\/frames\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})$/.exec(url.pathname);
  if (fr && req.method === 'GET') {
    const id = fr[1]!;
    if (isDocId(id) || (await store.isDeleted(id)) || !(await store.has(id))) {
      json(res, 404, { error: 'Доски нет' });
      return true;
    }
    const frames = listElements(await store.get(id))
      .filter((e) => e.type === 'frame')
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((e) => ({ id: e.id, name: e.type === 'frame' ? e.props.name : '' }));
    json(res, 200, { frames });
    return true;
  }
  // Карточки на досках (решение 0021): название и начало текста документов и таблиц.
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .filter((id) => /^(pg|tb)_[A-Za-z0-9_-]{1,61}$/.test(id))
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
      });
    }
    json(res, 200, { docs });
    return true;
  }
  const m = /^\/api\/render\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})\.png$/.exec(url.pathname);
  if (!m || req.method !== 'GET') return false;
  const board = m[1]!;
  if (isDocId(board) || (await store.isDeleted(board)) || !(await store.has(board))) {
    json(res, 404, { error: 'Доски нет' });
    return true;
  }
  const doc = await store.get(board);
  const all = listElements(doc);
  const frame = url.searchParams.get('frame');
  let area;
  if (frame) {
    const f = getElement(doc, frame);
    if (!f || f.type !== 'frame') {
      json(res, 404, { error: 'Фрейма нет' });
      return true;
    }
    area = contentArea([f]);
  } else area = contentArea(all);
  if (!area) {
    json(res, 404, { error: 'Доска пустая' });
    return true;
  }
  const pad = 24;
  const padded = { x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 };
  const max = Math.min(2048, Math.max(256, Number(url.searchParams.get('max')) || 1200));
  const { svg } = boardSvg(all, padded, { maxSize: max, images: await loadImages(all, assets) });
  const png = renderPng(svg);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'private, max-age=20',
  });
  res.end(png);
  return true;
}
