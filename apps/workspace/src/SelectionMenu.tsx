import { useEffect, useReducer, useState } from 'react';
import { worldToScreen, type CanvasEngine, type EngineState } from '@kayospace/canvas';
import { AI_MENU, type AiAction } from './ai';
import { CopyIcon, DuplicateIcon, SparkleIcon, TrashIcon } from './icons';

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
}: {
  engine: CanvasEngine;
  state: EngineState;
  /** null — ИИ доступен; строка — почему нет. */
  ai: string | null;
  onAi: (action: AiAction) => void;
  onAiPrompt: () => void;
}) {
  // Меню привязано к холсту: перерисовываем при движении камеры.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onCamera(bump), [engine]);
  const [aiOpen, setAiOpen] = useState(false);
  // Выделение сняли — список действий закрывается.
  const none = state.selected === 0;
  useEffect(() => {
    if (none) setAiOpen(false);
  }, [none]);

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
      <span className="count">{state.selected}</span>
      <button
        className="ai"
        title={ai ?? 'ИИ: распознать, сгруппировать, резюме, схема…'}
        disabled={ai !== null}
        aria-expanded={aiOpen}
        onClick={() => setAiOpen((o) => !o)}
      >
        <SparkleIcon />
        <span>ИИ</span>
      </button>
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
