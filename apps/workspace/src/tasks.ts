/** Задачи со всех досок (решение 0019): список с хаба и смена статуса без открытия доски. */

import type { TaskItem } from '@kayospace/board';
import type { TaskInfo } from '@kayospace/model';
import { hubCall, type Hub } from './devices';

export interface BoardTasks {
  board: string;
  name: string | null;
  tasks: TaskItem[];
}

export async function listAllTasks(hub: Hub): Promise<BoardTasks[]> {
  const r = await hubCall<{ boards: BoardTasks[] }>(fetch, hub.url, '/api/tasks', {
    token: hub.token,
  });
  return r.boards ?? [];
}

export async function updateTask(
  hub: Hub,
  board: string,
  id: string,
  patch: Partial<TaskInfo>,
): Promise<void> {
  await hubCall(
    fetch,
    hub.url,
    `/api/tasks/${encodeURIComponent(board)}/${encodeURIComponent(id)}`,
    { method: 'POST', token: hub.token, body: patch },
  );
}

export type TaskFilter = 'active' | 'overdue' | 'done' | 'all';

export const TASK_FILTERS: { value: TaskFilter; name: string }[] = [
  { value: 'active', name: 'Активные' },
  { value: 'overdue', name: 'Просрочено' },
  { value: 'done', name: 'Готово' },
  { value: 'all', name: 'Все' },
];

export function filterTasks(tasks: readonly TaskItem[], f: TaskFilter, day: string): TaskItem[] {
  return tasks.filter((t) => {
    const s = t.task.status;
    if (f === 'active') return s !== 'done';
    if (f === 'done') return s === 'done';
    if (f === 'overdue') return s !== 'done' && !!t.task.due && t.task.due < day;
    return true;
  });
}
