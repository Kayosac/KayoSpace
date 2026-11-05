/**
 * Проекты на устройстве: документ воркспейса (`_workspace`) открывается так же, как доска —
 * IndexedDB + синхронизация с хабом, — поэтому список проектов есть и без сети.
 */

import { useEffect, useState } from 'react';
import {
  WORKSPACE_ID,
  boardProjects,
  deletedBoards,
  listProjects,
  type DeletedBoard,
} from '@kayospace/board';
import type { Project } from '@kayospace/model';
import { BoardSession } from './session';
import type { BoardEntry } from './boards';

export interface WorkspaceView {
  session: BoardSession | null;
  projects: Project[];
  /** id доски → id проекта. */
  membership: Map<string, string>;
  /** Удалённые доски (решение 0016): id → когда удалена и стёрта ли насовсем. */
  deleted: Map<string, DeletedBoard>;
}

/** Открыть воркспейс для хаба (null — только на устройстве) и следить за проектами. */
export function useWorkspace(hub: { url: string; token: string } | null): WorkspaceView {
  const [view, setView] = useState<WorkspaceView>({
    session: null,
    projects: [],
    membership: new Map(),
    deleted: new Map(),
  });
  const url = hub?.url ?? '';
  const token = hub?.token ?? '';
  useEffect(() => {
    const session = new BoardSession(WORKSPACE_ID, url ? { url, token } : null);
    const read = (): void =>
      setView({
        session,
        projects: listProjects(session.doc),
        membership: boardProjects(session.doc),
        deleted: deletedBoards(session.doc),
      });
    read();
    session.doc.on('update', read);
    return () => {
      session.doc.off('update', read);
      session.destroy();
    };
  }, [url, token]);
  return view;
}

/** Доски выбранного проекта (null — все). */
export function inProject(
  boards: readonly BoardEntry[],
  membership: ReadonlyMap<string, string>,
  project: string | null,
): BoardEntry[] {
  return project === null ? [...boards] : boards.filter((b) => membership.get(b.id) === project);
}
