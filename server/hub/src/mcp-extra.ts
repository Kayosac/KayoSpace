/**
 * Инструменты MCP для контроля и структуры (решение 0016): корзина, «что поменялось», проекты,
 * удаление и возврат досок.
 * Регистрируются только для настоящих досок хаба (не для черновиков ИИ).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  WORKSPACE_ID,
  addProject,
  boardProjects,
  elementText,
  getBoardName,
  listElements,
  listProjects,
  markBoardDeleted,
  restorableBoards,
  restoreDeletedBoard,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import type { BoardInfo } from './store';
import type { Trash } from './trash';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
  list(): Promise<BoardInfo[]>;
}

const boardId = z.string().regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/);

/** «2026-11-05T09:00:00Z», «2026-11-05» или миллисекунды → время, мс. */
export function parseSince(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function registerExtraTools(
  server: McpServer,
  store: Source,
  trash: Trash,
  origin: unknown,
): void {
  server.registerTool(
    'list_trash',
    {
      description:
        'Корзина доски: что удалили за последние 7 дней (человек или агент), пачками по действию. ' +
        'Вернуть — restore_elements с id из пачки.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ board: boardId }),
    },
    async ({ board }) => json({ groups: await trash.groups(board) }),
  );

  server.registerTool(
    'restore_elements',
    {
      description: 'Вернуть элементы из корзины на доску (id из list_trash).',
      inputSchema: z.object({ board: boardId, ids: z.array(z.string()).min(1).max(1000) }),
    },
    async ({ board, ids }) => {
      if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
      const n = await trash.restore(board, await store.get(board), ids);
      return text(
        n ? `Возвращено: ${n}.` : 'В корзине этих элементов нет (или прошло больше 7 дней).',
      );
    },
  );

  server.registerTool(
    'get_changes',
    {
      description:
        'Что поменялось с указанного времени: новые и изменённые элементы (кто и когда) и удалённые. ' +
        'Без board — по всем доскам. Для дайджестов: «что я сделал за неделю», «что нового на доске».',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        since: z
          .union([z.string(), z.number()])
          .describe('ISO-время (2026-11-05T09:00:00Z) или мс'),
        board: boardId.optional(),
      }),
    },
    async ({ since, board }) => {
      const from = parseSince(since);
      if (from === null)
        return fail('Не понял время since — нужен ISO, например 2026-11-05T09:00:00Z.');
      const ids = board ? [board] : (await store.list()).map((b) => b.id);
      const out = [];
      for (const id of ids) {
        if (!(await store.has(id))) continue;
        const doc = await store.get(id);
        const changed = listElements(doc)
          .filter((el) => el.updatedAt > from)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        const deleted = (await trash.list(id)).filter((t) => t.deletedAt > from);
        if (changed.length === 0 && deleted.length === 0) continue;
        out.push({
          board: id,
          name: getBoardName(doc) ?? null,
          changed: changed.slice(0, 300).map((el) => ({
            id: el.id,
            type: el.type,
            text: elementText(el) || undefined,
            created: el.createdAt > from,
            by: `${el.updatedBy.kind === 'agent' ? 'агент' : 'человек'} ${el.updatedBy.name}`,
            at: new Date(el.updatedAt).toISOString(),
          })),
          changedTotal: changed.length,
          deleted: deleted.slice(0, 100).map((t) => ({
            id: t.element.id,
            type: t.element.type,
            text: elementText(t.element) || undefined,
            by: t.by === 'agent' ? 'агент' : 'человек',
            at: new Date(t.deletedAt).toISOString(),
          })),
        });
      }
      return out.length
        ? json({ since: new Date(from).toISOString(), boards: out })
        : text('Изменений нет.');
    },
  );

  server.registerTool(
    'list_projects',
    {
      description: 'Проекты владельца и доски в каждом (доски без проекта — отдельно).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ws = await store.get(WORKSPACE_ID);
      const membership = boardProjects(ws);
      const boards = await store.list();
      return json({
        projects: listProjects(ws).map((p) => ({
          id: p.id,
          name: p.name,
          boards: boards
            .filter((b) => membership.get(b.id) === p.id)
            .map((b) => ({ id: b.id, name: b.name })),
        })),
        withoutProject: boards
          .filter((b) => !membership.has(b.id))
          .map((b) => ({ id: b.id, name: b.name })),
      });
    },
  );

  server.registerTool(
    'create_project',
    {
      description: 'Создать проект. Возвращает его id (для create_board и move_board).',
      inputSchema: z.object({ name: z.string().min(1).max(80) }),
    },
    async ({ name }) => {
      const ws = await store.get(WORKSPACE_ID);
      const same = listProjects(ws).find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (same) return text(`Проект «${same.name}» уже есть: ${same.id}.`);
      return text(`Проект создан: ${addProject(ws, name, origin)}.`);
    },
  );

  const projectRef = z.string().nullable().describe('id или название проекта; null — без проекта');

  const resolveProject = async (ref: string | null): Promise<string | null | undefined> => {
    if (ref === null) return null;
    const ws = await store.get(WORKSPACE_ID);
    const p = listProjects(ws).find(
      (x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase(),
    );
    return p?.id;
  };

  server.registerTool(
    'create_board',
    {
      description:
        'Создать доску с названием, по желанию — в проекте. Уже есть — только название и проект.',
      inputSchema: z.object({
        board: boardId.describe('id новой доски: латиница, цифры, «-» и «_»'),
        name: z.string().min(1).max(120),
        project: projectRef.optional(),
      }),
    },
    async ({ board, name, project }) => {
      const pid = project === undefined ? undefined : await resolveProject(project);
      if (project && pid === undefined)
        return fail(`Проекта «${project}» нет. Список — list_projects.`);
      const existed = await store.has(board);
      const doc = await store.get(board);
      setBoardName(doc, name, origin);
      if (pid !== undefined) setBoardProject(await store.get(WORKSPACE_ID), board, pid, origin);
      return text(
        `${existed ? 'Доска уже была' : 'Доска создана'}: ${board}. Ссылка: kayospace://board/${board}`,
      );
    },
  );

  server.registerTool(
    'move_board',
    {
      description: 'Положить доску в проект (или убрать из проекта — project: null).',
      inputSchema: z.object({ board: boardId, project: projectRef }),
    },
    async ({ board, project }) => {
      if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
      const pid = await resolveProject(project);
      if (project !== null && pid === undefined)
        return fail(`Проекта «${project}» нет. Список — list_projects.`);
      setBoardProject(await store.get(WORKSPACE_ID), board, pid ?? null, origin);
      return text(pid ? `Доска ${board} — в проекте ${pid}.` : `Доска ${board} — без проекта.`);
    },
  );

  server.registerTool(
    'delete_board',
    {
      description:
        'Удалить доску — только по явной просьбе человека. Доска пропадёт из списков на всех ' +
        'устройствах; 7 дней её можно вернуть (restore_board), потом она стирается насовсем.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({ board: boardId }),
    },
    async ({ board }) => {
      if (!(await store.has(board))) return fail(`Доски «${board}» нет.`);
      const name = getBoardName(await store.get(board)) ?? null;
      markBoardDeleted(await store.get(WORKSPACE_ID), board, name, origin);
      return text(`Доска «${name ?? board}» удалена. Вернуть в течение 7 дней — restore_board.`);
    },
  );

  server.registerTool(
    'list_deleted_boards',
    {
      description: 'Удалённые доски, которые ещё можно вернуть (последние 7 дней).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list = restorableBoards(await store.get(WORKSPACE_ID));
      return list.length
        ? json(
            list.map((d) => ({ id: d.id, name: d.name, deletedAt: new Date(d.at).toISOString() })),
          )
        : text('Удалённых досок нет.');
    },
  );

  server.registerTool(
    'restore_board',
    {
      description: 'Вернуть удалённую доску (id из list_deleted_boards).',
      inputSchema: z.object({ board: boardId }),
    },
    async ({ board }) =>
      restoreDeletedBoard(await store.get(WORKSPACE_ID), board, origin)
        ? text(`Доска ${board} возвращена. Ссылка: kayospace://board/${board}`)
        : fail(`Доски «${board}» среди удалённых нет (или прошло больше 7 дней).`),
  );
}
