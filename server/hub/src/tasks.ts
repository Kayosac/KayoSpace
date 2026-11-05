/**
 * Задачи со всех досок (решение 0019): список для панели «Задачи» в приложении и для агентов,
 * смена статуса без открытия доски. Задача — стикер с полем task, так что всё остальное
 * (синхронизация, корзина, история, отмена агентских правок) работает как со стикерами.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type * as Y from 'yjs';
import { listTasks, setTask, today, type TaskItem } from '@kayospace/board';
import type { Actor, TaskInfo } from '@kayospace/model';

export interface BoardTasks {
  board: string;
  name: string | null;
  tasks: TaskItem[];
}

export async function allTasks(
  store: {
    list(): Promise<{ id: string; name: string | null }[]>;
    get(id: string): Promise<Y.Doc>;
  },
  day: string = today(),
): Promise<BoardTasks[]> {
  const out: BoardTasks[] = [];
  for (const b of await store.list()) {
    const tasks = listTasks(await store.get(b.id), day);
    if (tasks.length) out.push({ board: b.id, name: b.name, tasks });
  }
  return out;
}

/** Что можно поменять у задачи снаружи (приложение, агент). */
export function taskPatch(body: Record<string, unknown>): Partial<TaskInfo> {
  const patch: Partial<TaskInfo> = {};
  if (body.status === 'todo' || body.status === 'doing' || body.status === 'done')
    patch.status = body.status;
  if ('due' in body) patch.due = typeof body.due === 'string' && body.due ? body.due : undefined;
  if ('high' in body) patch.high = body.high === true;
  return patch;
}

/**
 * REST задач:
 *   GET  /api/tasks                 — { boards: [{ board, name, tasks }] }
 *   POST /api/tasks/<доска>/<id>    — { status?, due?, high? } или { task: false } → { ok }
 */
export async function handleTasks(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: {
    list(): Promise<{ id: string; name: string | null }[]>;
    get(id: string): Promise<Y.Doc>;
    has(id: string): Promise<boolean>;
  },
  actor: Actor,
): Promise<boolean> {
  const { json, readJson } = await import('./devices-api');
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    json(res, 200, { boards: await allTasks(store) });
    return true;
  }
  const m = /^\/api\/tasks\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9_-]{1,64})$/.exec(
    url.pathname,
  );
  if (!m) return false;
  if (req.method !== 'POST') return (json(res, 405, { error: 'Только POST' }), true);
  const [, board, id] = m as unknown as [string, string, string];
  if (!(await store.has(board))) return (json(res, 404, { error: 'Такой доски нет' }), true);
  let body: Record<string, unknown>;
  try {
    body = await readJson(req, 4096);
  } catch {
    return (json(res, 400, { error: 'Нужен JSON' }), true);
  }
  const ok = setTask(
    await store.get(board),
    id,
    body.task === false ? null : taskPatch(body),
    actor,
    'tasks',
  );
  json(res, ok ? 200 : 404, ok ? { ok } : { error: 'Такого стикера нет' });
  return true;
}
