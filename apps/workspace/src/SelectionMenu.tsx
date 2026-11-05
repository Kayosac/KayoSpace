import { useEffect, useReducer, useState } from 'react';
import {
  worldToScreen,
  type CanvasEngine,
  type EngineState,
  type ExportTarget,
} from '@kayospace/canvas';
import { TASK_STATUSES, TASK_STATUS_NAMES, type AlignMode } from '@kayospace/board';
import { AI_MENU, type AiAction } from './ai';
import { CommitInput } from './CommitInput';
import { openInClaude } from './claude';
import { CopyIcon, DuplicateIcon, MoreIcon, SparkleIcon, TaskIcon, TrashIcon } from './icons';

const ALIGN: { mode: AlignMode; name: string; min: number }[] = [
  { mode: 'left', name: 'По левому краю', min: 2 },
  { mode: 'center', name: 'По центру', min: 2 },
  { mode: 'right', name: 'По правому краю', min: 2 },
  { mode: 'top', name: 'По верху', min: 2 },
  { mode: 'middle', name: 'По середине', min: 2 },
  { mode: 'bottom', name: 'По низу', min: 2 },
  { mode: 'distribute-x', name: 'Равные промежутки по горизонтали', min: 3 },
  { mode: 'distribute-y', name: 'Равные промежутки по вертикали', min: 3 },
];

const MENU_GAP = 14;

const mod =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** Действия ИИ, которые подходят к выделенному: тексты — для стикеров и надписей, распознавание — для рисунков. */
function aiActionsFor(engine: CanvasEngine) {
  let text = false;
  let ink = false;
  for (const id of engine.getSelection()) {
    const type = engine.scene.items.get(id)?.element.type;
    if (type === 'sticky' || type === 'text') text = true;
    else if (type === 'stroke' || type === 'image') ink = true;
    for (const child of engine.scene.childrenOf(id)) {
      if (engine.scene.items.get(child)?.element.type === 'stroke') ink = true;
    }
  }
  return AI_MENU.filter((a) => a.needs === 'any' || (a.needs === 'text' ? text : ink));
}
const MENU_HEIGHT = 44;

/** Меню над выделением: на планшете без клавиатуры это единственный способ копировать и удалять. */
export function SelectionMenu({
  engine,
  state,
  ai,
  onAi,
  onAiPrompt,
  onExport,
}: {
  engine: CanvasEngine;
  state: EngineState;
  /** null — ИИ доступен; строка — почему нет. */
  ai: string | null;
  onAi: (action: AiAction) => void;
  onAiPrompt: () => void;
  onExport: (target: ExportTarget) => void;
}) {
  // Меню привязано к холсту: перерисовываем при движении камеры.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onCamera(bump), [engine]);
  const [aiOpen, setAiOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  // Выделение сняли — списки действий закрываются.
  const none = state.selected === 0;
  useEffect(() => {
    if (none) {
      setAiOpen(false);
      setMoreOpen(false);
      setTaskOpen(false);
    }
  }, [none]);
  const frame = state.selectedFrame;
  const frameName = frame ? frameNameOf(engine, frame) : '';
  // Задачи (решение 0019): только для стикеров.
  const stickies = !none && engine.selectionIsStickies();
  const task = stickies ? engine.getSelectedTask() : null;
  // Одна карточка документа (решение 0021) — «Открыть» поверх доски.
  const sel = state.selected === 1 ? [...engine.getSelection()][0] : undefined;
  const docCard = sel && engine.scene.items.get(sel)?.element.type === 'doc' ? sel : null;
  const docEl = docCard ? engine.scene.items.get(docCard)?.element : undefined;
  const docCardEl = docEl?.type === 'doc' ? docEl : null;

  if (
    state.selected === 0 ||
    state.transforming ||
    state.editing ||
    state.tool !== 'select' ||
    state.aiPreview
  ) {
    return null;
  }
  const b = engine.getSelectionBounds();
  if (!b) return null;
  const cam = engine.getCamera();
  // Повёрнутый вид: берём экранную рамку вокруг всех четырёх углов.
  const pts = [
    worldToScreen(cam, b.minX, b.minY),
    worldToScreen(cam, b.maxX, b.minY),
    worldToScreen(cam, b.maxX, b.maxY),
    worldToScreen(cam, b.minX, b.maxY),
  ];
  const tl = { x: Math.min(...pts.map((q) => q.x)), y: Math.min(...pts.map((q) => q.y)) };
  const br = { x: Math.max(...pts.map((q) => q.x)), y: Math.max(...pts.map((q) => q.y)) };
  // Над рамкой ещё ручка поворота — меню выше неё.
  const gapAbove = MENU_GAP + 32;
  const above = tl.y - gapAbove - MENU_HEIGHT > 64;
  const top = above ? tl.y - gapAbove - MENU_HEIGHT : br.y + MENU_GAP;
  const left = (tl.x + br.x) / 2;

  return (
    <div
      className="selection-menu"
      style={{ top, left }}
      role="toolbar"
      aria-label="Выделение"
      data-testid="selection-menu"
      data-rev={state.selectionRev}
    >
      {frame ? (
        <CommitInput
          key={frame}
          className="frame-name"
          value={frameName}
          aria-label="Название фрейма"
          data-testid="frame-name"
          onCommit={(v) => engine.renameFrame(frame, v)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="count">{state.selected}</span>
      )}
      <button
        className="ai"
        title={ai ?? 'ИИ: распознать, сгруппировать, резюме, схема…'}
        disabled={ai !== null}
        aria-expanded={aiOpen}
        onClick={() => {
          setMoreOpen(false);
          setTaskOpen(false);
          setAiOpen((o) => !o);
        }}
      >
        <SparkleIcon />
        <span>ИИ</span>
      </button>
      {stickies && (
        <button
          className={task ? 'task on' : 'task'}
          title="Задача: статус, срок, важность"
          aria-expanded={taskOpen}
          data-testid="task-button"
          onClick={() => {
            setAiOpen(false);
            setMoreOpen(false);
            // Стикер ещё не задача — сразу делаем задачей и показываем её поля.
            if (!task) engine.setTask({ status: 'todo' });
            setTaskOpen((o) => !o || !task);
          }}
        >
          <TaskIcon />
          <span>Задача</span>
        </button>
      )}
      {docCard && (
        <button onClick={() => engine.openDoc(docCard)} data-testid="open-doc">
          <span>Открыть</span>
        </button>
      )}
      {docCardEl && (
        <button
          onClick={() => void openInClaude(docCardEl.props.doc, docCardEl.props.title ?? null)}
          data-testid="card-to-claude"
        >
          <span>В Claude</span>
        </button>
      )}
      <button title="Дублировать (Ctrl/⌘ D)" onClick={() => engine.duplicateSelection()}>
        <DuplicateIcon />
        <span>Дублировать</span>
      </button>
      <button title="Копировать (Ctrl/⌘ C)" onClick={() => engine.copySelection()}>
        <CopyIcon />
        <span>Копировать</span>
      </button>
      <button className="danger" title="Удалить (Delete)" onClick={() => engine.deleteSelection()}>
        <TrashIcon />
        <span>Удалить</span>
      </button>
      <button
        title="Порядок, выравнивание, экспорт"
        aria-label="Ещё"
        aria-expanded={moreOpen}
        data-testid="selection-more"
        onClick={() => {
          setAiOpen(false);
          setTaskOpen(false);
          setMoreOpen((o) => !o);
        }}
      >
        <MoreIcon />
      </button>
      {moreOpen && (
        <div className="ai-actions more-actions" role="menu" aria-label="Ещё">
          <button
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              engine.arrange('front');
            }}
            disabled={!!frame}
          >
            На передний план <kbd>{mod}]</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              engine.arrange('back');
            }}
            disabled={!!frame}
          >
            На задний план <kbd>{mod}[</kbd>
          </button>
          {state.selected >= 2 && <hr />}
          {ALIGN.filter((a) => state.selected >= a.min).map(({ mode, name: label }) => (
            <button
              key={mode}
              role="menuitem"
              onClick={() => {
                setMoreOpen(false);
                engine.align(mode);
              }}
            >
              {label}
            </button>
          ))}
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              onExport(frame ? { frame } : 'selection');
            }}
          >
            {frame ? 'Сохранить фрейм как PNG' : 'Сохранить выделенное как PNG'}
          </button>
        </div>
      )}
      {taskOpen && task && (
        <div className="ai-actions task-actions" aria-label="Задача" data-testid="task-panel">
          <div className="task-statuses" role="radiogroup" aria-label="Статус">
            {TASK_STATUSES.map((st) => (
              <button
                key={st}
                role="radio"
                aria-checked={task.status === st}
                onClick={() => engine.setTask({ status: st })}
              >
                {TASK_STATUS_NAMES[st]}
              </button>
            ))}
          </div>
          <label className="task-due">
            <span>Срок</span>
            <input
              type="date"
              value={task.due ?? ''}
              onChange={(e) => engine.setTask({ due: e.currentTarget.value || undefined })}
              data-testid="task-due"
            />
            {task.due && (
              <button onClick={() => engine.setTask({ due: undefined })} aria-label="Убрать срок">
                Без срока
              </button>
            )}
          </label>
          <button
            role="checkbox"
            aria-checked={!!task.high}
            className="task-high"
            onClick={() => engine.setTask({ high: !task.high })}
          >
            {task.high ? '! Важная' : 'Отметить важной'}
          </button>
          <hr />
          <button
            onClick={() => {
              setTaskOpen(false);
              engine.setTask(null);
            }}
          >
            Не задача — обычный стикер
          </button>
        </div>
      )}
      {aiOpen && (
        <div className="ai-actions" role="menu" aria-label="Действия ИИ">
          {aiActionsFor(engine).map(({ action, name }) => (
            <button
              key={action}
              role="menuitem"
              onClick={() => {
                setAiOpen(false);
                onAi(action);
              }}
            >
              {name}
            </button>
          ))}
          <button
            role="menuitem"
            onClick={() => {
              setAiOpen(false);
              onAiPrompt();
            }}
          >
            Свой запрос… <kbd>{mod}J</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

function frameNameOf(engine: CanvasEngine, id: string): string {
  const el = engine.scene.items.get(id)?.element;
  return el?.type === 'frame' ? el.props.name : '';
}
