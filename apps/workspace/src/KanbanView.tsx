import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TASK_STATUSES,
  TASK_STATUS_NAMES,
  dueText,
  isOverdue,
  listTasks,
  today,
  type TaskItem,
} from '@kayospace/board';
import type { CanvasEngine } from '@kayospace/canvas';
import type { TaskInfo, TaskStatus } from '@kayospace/model';
import type * as Y from 'yjs';
import type { Hub } from './devices';
import { CloseIcon } from './icons';
import { listAllTasks, updateTask } from './tasks';

interface Card extends TaskItem {
  board: string;
  boardName: string | null;
}

/** Карточка в полёте: где палец, где его взяли на карточке, её ширина и колонка под пальцем. */
interface Drag {
  key: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  w: number;
  over: TaskStatus | null;
}

/** Готовые старше двух недель в канбан не попадают — колонка «Готово» не разрастается. */
const DONE_KEEP_MS = 14 * 24 * 3_600_000;

/**
 * Канбан задач (решение 0020): колонки «Сделать / В работе / Готово» по задачам со всех досок
 * (или открытой). Карточку перетаскивают в другую колонку — пером, мышью или пальцем; касание
 * открывает действия: перенести в соседнюю колонку или открыть стикер на доске.
 */
export function KanbanView({
  hub,
  board,
  boardName,
  doc,
  engine,
  onOpen,
  onClose,
}: {
  hub: Hub | null;
  board: string;
  boardName: string | null;
  doc: Y.Doc | null;
  engine: CanvasEngine | null;
  onOpen: (board: string, id: string, name: string | null) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<'all' | 'board'>(hub ? 'all' : 'board');
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  /** Перетаскивание: карточка-призрак летит за пальцем поверх всех колонок. */
  const [drag, setDrag] = useState<Drag | null>(null);
  const start = useRef<(Drag & { sx: number; sy: number; moved: boolean }) | null>(null);
  const day = today();

  const load = useCallback(async () => {
    try {
      let list: Card[];
      if (scope === 'all' && hub) {
        list = (await listAllTasks(hub)).flatMap((b) =>
          b.tasks.map((t) => ({ ...t, board: b.board, boardName: b.name })),
        );
      } else {
        list = (doc ? listTasks(doc, day) : []).map((t) => ({ ...t, board, boardName }));
      }
      const now = Date.now();
      setCards(
        list.filter(
          (c) => c.task.status !== 'done' || !c.task.doneAt || now - c.task.doneAt < DONE_KEEP_MS,
        ),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Хаб недоступен');
    }
  }, [scope, hub, doc, board, boardName, day]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const keyOf = (c: Card) => `${c.board}:${c.id}`;

  const move = async (c: Card, patch: Partial<TaskInfo>): Promise<void> => {
    setPicked(null);
    // Сразу на экране, потом — на доске или хабе.
    setCards(
      (list) =>
        list?.map((x) => (keyOf(x) === keyOf(c) ? { ...x, task: { ...x.task, ...patch } } : x)) ??
        null,
    );
    try {
      if (c.board === board && engine) engine.setTask(patch, [c.id]);
      else if (hub) await updateTask(hub, c.board, c.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не получилось');
    }
    setTimeout(() => void load(), 300);
  };

  const columnAt = (x: number, y: number): TaskStatus | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-column]');
    return (el?.dataset.column as TaskStatus | undefined) ?? null;
  };

  const dragged = drag ? (cards ?? []).find((c) => keyOf(c) === drag.key) : undefined;
  const cardBody = (c: Card) => (
    <>
      <span className="kanban-text">{c.text.trim() || 'Без текста'}</span>
      <small>
        {c.task.high && <b className="task-high-mark">! важная</b>}
        {scope === 'all' && <span>{c.boardName ?? c.board}</span>}
        {c.task.due && (
          <span className={isOverdue(c.task, day) ? 'bad' : undefined}>
            {dueText(c.task.due, day)}
          </span>
        )}
      </small>
    </>
  );

  return (
    <div className={drag ? 'kanban dragging' : 'kanban'} data-testid="kanban">
      <div className="kanban-head">
        <h2>Канбан</h2>
        <div className="projects" role="tablist" aria-label="Какие задачи">
          {hub && (
            <button
              role="tab"
              aria-selected={scope === 'all'}
              className="project-chip"
              onClick={() => setScope('all')}
            >
              Все доски
            </button>
          )}
          <button
            role="tab"
            aria-selected={scope === 'board'}
            className="project-chip"
            onClick={() => setScope('board')}
          >
            {boardName ?? board}
          </button>
        </div>
        <button className="icon-btn" aria-label="Закрыть канбан" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="bad">{error}</p>}
      <div className="kanban-columns">
        {TASK_STATUSES.map((status) => {
          const col = (cards ?? []).filter((c) => c.task.status === status);
          const target = !!dragged && drag?.over === status && dragged.task.status !== status;
          return (
            <section
              key={status}
              className={target ? 'kanban-col over' : 'kanban-col'}
              data-column={status}
              data-testid={`kanban-${status}`}
            >
              <h3>
                {TASK_STATUS_NAMES[status]} <span>{col.length}</span>
              </h3>
              <ul>
                {target && (
                  <li className="kanban-slot" aria-hidden="true">
                    Отпустите — сюда
                  </li>
                )}
                {col.map((c) => {
                  const k = keyOf(c);
                  return (
                    <li
                      key={k}
                      className={`kanban-card${drag?.key === k ? ' placeholder' : ''}${c.task.high ? ' high' : ''}`}
                      data-testid="kanban-card"
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest('button')) return;
                        // Иначе мышь начинает выделять текст карточек и колонок.
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        start.current = {
                          key: k,
                          x: e.clientX,
                          y: e.clientY,
                          sx: e.clientX,
                          sy: e.clientY,
                          dx: e.clientX - r.left,
                          dy: e.clientY - r.top,
                          w: r.width,
                          over: null,
                          moved: false,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const s = start.current;
                        if (!s || s.key !== k) return;
                        if (!s.moved && Math.hypot(e.clientX - s.sx, e.clientY - s.sy) < 8) return;
                        if (!s.moved) setPicked(null);
                        s.moved = true;
                        setDrag({
                          key: k,
                          x: e.clientX,
                          y: e.clientY,
                          dx: s.dx,
                          dy: s.dy,
                          w: s.w,
                          over: columnAt(e.clientX, e.clientY),
                        });
                      }}
                      onPointerUp={(e) => {
                        const s = start.current;
                        start.current = null;
                        if (!s || s.key !== k) return;
                        if (!s.moved) {
                          setPicked((p) => (p === k ? null : k));
                          return;
                        }
                        const to = columnAt(e.clientX, e.clientY);
                        setDrag(null);
                        if (to && to !== c.task.status) void move(c, { status: to });
                      }}
                      onPointerCancel={() => {
                        start.current = null;
                        setDrag(null);
                      }}
                    >
                      {cardBody(c)}
                      {picked === k && (
                        <div className="kanban-actions" data-testid="kanban-actions">
                          {TASK_STATUSES.filter((s) => s !== status).map((s) => (
                            <button key={s} onClick={() => void move(c, { status: s })}>
                              → {TASK_STATUS_NAMES[s]}
                            </button>
                          ))}
                          <button onClick={() => onOpen(c.board, c.id, c.boardName)}>
                            Открыть на доске
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
                {col.length === 0 && !target && <li className="kanban-empty">Пусто</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {drag && dragged && (
        <div
          className={`kanban-card kanban-ghost${dragged.task.high ? ' high' : ''}`}
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w }}
          aria-hidden="true"
        >
          {cardBody(dragged)}
        </div>
      )}
    </div>
  );
}
