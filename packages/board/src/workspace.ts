/**
 * Воркспейс: проекты и то, в каком проекте какая доска (шаг 1.6).
 *
 * Отдельный Yjs-документ с id `_workspace` синхронизируется так же, как доски, и хранится локально —
 * список проектов есть и без сети. Раскладка:
 *   projects: Y.Map<id, Project>  — название, цвет, порядок, архив
 *   boards:   Y.Map<boardId, projectId> — доска без записи — «без проекта»
 * Служебные документы начинаются с «_» и не показываются в списке досок.
 */

import * as Y from 'yjs';
import type { Project } from '@kayospace/model';
import { newId } from './ids';
import { keyBetween } from './order';
import type { Origin } from './board';

export const WORKSPACE_ID = '_workspace';
const PROJECTS = 'projects';
const BOARDS = 'boards';

/** Служебный документ (не доска): воркспейс и всё, что начинается с «_». */
export const isServiceDoc = (id: string): boolean => id.startsWith('_');

/** Цвета проектов — по кругу. */
export const PROJECT_COLORS = ['#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#e5484d', '#0d9488'];

const projectsMap = (doc: Y.Doc) => doc.getMap<Project>(PROJECTS);
const boardsMap = (doc: Y.Doc) => doc.getMap<string>(BOARDS);

/** Проекты по порядку (архивные — в конце). */
export function listProjects(doc: Y.Doc): Project[] {
  // Одинаковый порядок бывает, когда проекты создали на двух устройствах одновременно, — тогда по id.
  return [...projectsMap(doc).values()].sort((a, b) =>
    a.archived !== b.archived
      ? a.archived
        ? 1
        : -1
      : a.order !== b.order
        ? a.order < b.order
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : 1,
  );
}

export function getProject(doc: Y.Doc, id: string): Project | undefined {
  return projectsMap(doc).get(id);
}

/** Новый проект — в конец списка. Возвращает его id. */
export function addProject(doc: Y.Doc, name: string, origin?: Origin): string {
  const list = listProjects(doc);
  const last = list.filter((p) => !p.archived).at(-1)?.order ?? '';
  const project: Project = {
    id: newId(),
    name: name.trim().slice(0, 80) || 'Проект',
    color: PROJECT_COLORS[list.length % PROJECT_COLORS.length],
    order: keyBetween(last, null),
    archived: false,
  };
  doc.transact(() => projectsMap(doc).set(project.id, project), origin);
  return project.id;
}

export function renameProject(doc: Y.Doc, id: string, name: string, origin?: Origin): void {
  const p = projectsMap(doc).get(id);
  const n = name.trim().slice(0, 80);
  if (!p || !n || n === p.name) return;
  doc.transact(() => projectsMap(doc).set(id, { ...p, name: n }), origin);
}

/** Удалить проект. Доски остаются — становятся «без проекта». */
export function removeProject(doc: Y.Doc, id: string, origin?: Origin): void {
  doc.transact(() => {
    projectsMap(doc).delete(id);
    const boards = boardsMap(doc);
    for (const [board, project] of [...boards.entries()]) if (project === id) boards.delete(board);
  }, origin);
}

/** В каком проекте доска (null — без проекта или проект удалён). */
export function boardProject(doc: Y.Doc, boardId: string): string | null {
  const p = boardsMap(doc).get(boardId);
  return p && projectsMap(doc).has(p) ? p : null;
}

/** Все привязки досок к проектам. */
export function boardProjects(doc: Y.Doc): Map<string, string> {
  const projects = projectsMap(doc);
  const out = new Map<string, string>();
  for (const [board, project] of boardsMap(doc)) if (projects.has(project)) out.set(board, project);
  return out;
}

/** Переложить доску в проект (null — убрать из проекта). */
export function setBoardProject(
  doc: Y.Doc,
  boardId: string,
  projectId: string | null,
  origin?: Origin,
): void {
  doc.transact(() => {
    if (projectId) boardsMap(doc).set(boardId, projectId);
    else boardsMap(doc).delete(boardId);
  }, origin);
}
