import { useCallback, useEffect, useState } from 'react';
import { dueText, isOverdue, listTasks, today, type TaskItem } from '@kayospace/board';
import type { CanvasEngine } from '@kayospace/canvas';
import type { TaskInfo } from '@kayospace/model';
import type * as Y from 'yjs';
import type { Hub } from './devices';
import { CloseIcon } from './icons';
import {
  TASK_FILTERS,
  filterTasks,
  listAllTasks,
  updateTask,
  type BoardTasks,
  type TaskFilter,
} from './tasks';

/**
 * Задачи (решение 0019): стикеры-задачи со всех досок. Отметить «Готово» — касанием кружка,
 * перейти к стикеру — касанием текста. Без хаба — задачи открытой доски.
 */
export function TasksPanel({
  hub,
  board,
  boardName,
  doc,
  engine,
  onFind,
  onClose,
}: {
  hub: Hub | null;
  board: string;
  boardName: string | null;
  doc: Y.Doc | null;
  engine: CanvasEngine | null;
  onFind: (board: string, id: string, name: string | null) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<TaskFilter>('active');
  const [boards, setBoards] = useState<BoardTasks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const day = today();

  const load = useCallback(async () => {
    if (!hub) {
      const tasks = doc ? listTasks(doc, day) : [];
      setBoards(tasks.length ? [{ board, name: boardName, tasks }] : []);
      return;
    }
    try {
      const all = await listAllTasks(hub);
      // Открытая доска — первой.
      setBoards(all.sort((a, b) => Number(b.board === board) - Number(a.board === board)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Хаб недоступен');
    }
  }, [hub, doc, board, boardName, day]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const change = async (b: string, item: TaskItem, patch: Partial<TaskInfo>): Promise<void> => {
    try {
      if (b === board && engine) engine.setTask(patch, [item.id]);
      else if (hub) await updateTask(hub, b, item.id, patch);
      setTimeout(() => void load(), b === board ? 50 : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не получилось');
    }
  };

  const shown = (boards ?? [])
    .map((b) => ({ ...b, tasks: filterTasks(b.tasks, filter, day) }))
    .filter((b) => b.tasks.length);
  const total = (boards ?? []).reduce((n, b) => n + b.tasks.length, 0);

  return (
    <aside className="panel tasks-panel" aria-label="Задачи" data-testid="tasks-panel">
      <div className="panel-head">
        <h2>Задачи</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="projects" role="tablist" aria-label="Какие задачи">
        {TASK_FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            className="project-chip"
            onClick={() => setFilter(f.value)}
          >
            {f.name}
          </button>
        ))}
      </div>
      {error && <p className="bad">{error}</p>}
      {boards && total === 0 && (
        <p className="muted">
          Задач пока нет. Выделите стикер и нажмите «Задача» — у него появятся статус и срок.
        </p>
      )}
      {boards && total > 0 && shown.length === 0 && <p className="muted">Здесь пусто.</p>}
      {shown.map((b) => (
        <section key={b.board} className="task-board">
          <h3 className="section-title">
            {b.name ?? b.board}
            {b.board === board && <span className="tag">открыта</span>}
          </h3>
          <ul className="task-list" data-testid="task-list">
            {b.tasks.map((item) => {
              const t = item.task;
              const late = isOverdue(t, day);
              return (
                <li key={item.id} data-status={t.status} data-testid="task-row">
                  <button
                    className={`task-check ${t.status}`}
                    role="checkbox"
                    aria-checked={t.status === 'done'}
                    aria-label={t.status === 'done' ? 'Вернуть в работу' : 'Отметить «Готово»'}
                    onClick={() =>
                      void change(b.board, item, { status: t.status === 'done' ? 'todo' : 'done' })
                    }
                  />
                  <button className="task-text" onClick={() => onFind(b.board, item.id, b.name)}>
                    <span>{item.text.trim() || 'Без текста'}</span>
                    <small>
                      {t.high && <b className="task-high-mark">! </b>}
                      {t.status === 'doing' && 'в работе'}
                      {t.status === 'doing' && t.due && ' · '}
                      {t.due && (
                        <span className={late ? 'bad' : undefined}>{dueText(t.due, day)}</span>
                      )}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
