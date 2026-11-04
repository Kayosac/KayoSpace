import { useEffect, useReducer } from 'react';
import { worldToScreen, type CanvasEngine, type EngineState } from '@kayospace/canvas';
import { CopyIcon, DuplicateIcon, TrashIcon } from './icons';

const MENU_GAP = 14;
const MENU_HEIGHT = 44;

/** Меню над выделением: на планшете без клавиатуры это единственный способ копировать и удалять. */
export function SelectionMenu({ engine, state }: { engine: CanvasEngine; state: EngineState }) {
  // Меню привязано к холсту: перерисовываем при движении камеры.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onCamera(bump), [engine]);

  if (state.selected === 0 || state.transforming || state.editing || state.tool !== 'select') {
    return null;
  }
  const b = engine.getSelectionBounds();
  if (!b) return null;
  const cam = engine.getCamera();
  const tl = worldToScreen(cam, b.minX, b.minY);
  const br = worldToScreen(cam, b.maxX, b.maxY);
  const above = tl.y - MENU_GAP - MENU_HEIGHT > 64;
  const top = above ? tl.y - MENU_GAP - MENU_HEIGHT : br.y + MENU_GAP;
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
    </div>
  );
}
