/**
 * Задачи (решение 0019): стикер становится задачей — статус, срок, важность хранятся в самом стикере
 * (`props.task`). Так задача живёт на доске, двигается и копируется как стикер, а списки задач
 * собираются из всех досок.
 */

import type * as Y from 'yjs';
import type { Actor, StickyElement, TaskInfo, TaskStatus } from '@kayospace/model';
import { elementsMap, listElements, type Origin } from './board';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done'];
export const TASK_STATUS_NAMES: Record<TaskStatus, string> = {
  todo: 'Сделать',
  doing: 'В работе',
  done: 'Готово',
};

export interface TaskItem {
  id: string;
  text: string;
  task: TaskInfo;
}

/** Срок — YYYY-MM-DD; всё остальное отбрасываем. */
export function validDue(due: unknown): string | undefined {
  return typeof due === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(due) &&
    !Number.isNaN(Date.parse(due))
    ? due
    : undefined;
}

/** Сегодня — YYYY-MM-DD по местному времени. */
export function today(now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Просрочена: срок прошёл, а задача не готова. */
export function isOverdue(t: TaskInfo, day: string = today()): boolean {
  return t.status !== 'done' && !!t.due && t.due < day;
}

/** Следующий статус по кругу: Сделать → В работе → Готово → Сделать. */
export function nextStatus(s: TaskStatus): TaskStatus {
  return TASK_STATUSES[(TASK_STATUSES.indexOf(s) + 1) % TASK_STATUSES.length]!;
}

/** Поменять задачу стикера (null — снова обычный стикер). false — это не стикер. */
export function setTask(
  doc: Y.Doc,
  id: string,
  patch: Partial<TaskInfo> | null,
  actor: Actor,
  origin?: Origin,
  now: number = Date.now(),
): boolean {
  const map = elementsMap(doc);
  const el = map.get(id);
  if (!el || el.type !== 'sticky') return false;
  let task: TaskInfo | undefined;
  if (patch) {
    const prev = el.props.task ?? { status: 'todo' as TaskStatus };
    const status =
      patch.status && TASK_STATUSES.includes(patch.status) ? patch.status : prev.status;
    task = { status };
    const due = 'due' in patch ? validDue(patch.due) : prev.due;
    if (due) task.due = due;
    const high = 'high' in patch ? patch.high === true : prev.high;
    if (high) task.high = true;
    if (status === 'done') task.doneAt = prev.status === 'done' && prev.doneAt ? prev.doneAt : now;
  }
  const rest = { ...el.props };
  delete rest.task;
  const next: StickyElement = {
    ...el,
    props: task ? { ...rest, task } : rest,
    updatedBy: actor,
    updatedAt: now,
  };
  doc.transact(() => map.set(id, next), origin);
  return true;
}

/** Задачи доски: важные и просроченные — выше, потом по сроку, без срока — в конце. */
export function listTasks(doc: Y.Doc, day: string = today()): TaskItem[] {
  return listElements(doc)
    .filter((e): e is StickyElement => e.type === 'sticky' && !!e.props.task)
    .map((e) => ({ id: e.id, text: e.props.content, task: e.props.task! }))
    .sort(
      (a, b) =>
        taskRank(a.task, day) - taskRank(b.task, day) ||
        (a.task.due ?? '9').localeCompare(b.task.due ?? '9'),
    );
}

function taskRank(t: TaskInfo, day: string): number {
  if (t.status === 'done') return 3;
  if (isOverdue(t, day)) return 0;
  return t.high ? 1 : 2;
}

/** «до 12 ноября» — для стикера и списка. */
export function dueText(due: string, day: string = today()): string {
  if (due === day) return 'сегодня';
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const tomorrow = new Date(Date.parse(day) + 86_400_000);
  if (today(tomorrow.getTime()) === due) return 'завтра';
  const sameYear = Number(day.slice(0, 4)) === y;
  return `до ${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

/** Задача строкой для markdown: «[ ] Позвонить (до 12 нояб., важно)». */
export function taskLine(t: TaskInfo): string {
  const box = t.status === 'done' ? '[x]' : t.status === 'doing' ? '[~]' : '[ ]';
  const extra = [t.due ? `срок ${t.due}` : '', t.high ? 'важно' : ''].filter(Boolean).join(', ');
  return `${box} ${TASK_STATUS_NAMES[t.status]}${extra ? ` (${extra})` : ''}`;
}
