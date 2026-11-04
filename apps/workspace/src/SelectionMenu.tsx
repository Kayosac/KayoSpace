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
