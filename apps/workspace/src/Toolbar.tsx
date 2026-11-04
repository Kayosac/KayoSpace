import type { ComponentType } from 'react';
import type { CanvasEngine, EngineState, Tool } from '@kayospace/canvas';
import { EraserIcon, HandIcon, PenIcon, RedoIcon, SettingsIcon, UndoIcon } from './icons';

/** Цвета пера. null — цвет чернил темы (тёмный на светлой бумаге, светлый на тёмной). */
export const PEN_COLORS: { value: string | null; name: string }[] = [
  { value: null, name: 'Чернила' },
  { value: '#e5484d', name: 'Красный' },
  { value: '#f76b15', name: 'Оранжевый' },
  { value: '#30a46c', name: 'Зелёный' },
  { value: '#3e63dd', name: 'Синий' },
  { value: '#8e4ec6', name: 'Фиолетовый' },
];

/** Толщина пера в экранных пикселях; dot — размер кружка на кнопке. */
export const PEN_SIZES: { value: number; name: string; dot: number }[] = [
  { value: 1.5, name: 'Тонкое', dot: 4 },
  { value: 3, name: 'Среднее', dot: 8 },
  { value: 7, name: 'Толстое', dot: 14 },
];

const TOOLS: { value: Tool; name: string; key: string; Icon: ComponentType }[] = [
  { value: 'pen', name: 'Перо', key: 'P', Icon: PenIcon },
  { value: 'eraser', name: 'Ластик', key: 'E', Icon: EraserIcon },
  { value: 'hand', name: 'Рука', key: 'H', Icon: HandIcon },
];

const mod =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function Toolbar({
  engine,
  state,
  onSettings,
}: {
  engine: CanvasEngine;
  state: EngineState;
  onSettings: () => void;
}) {
  const pen = state.tool === 'pen';
  return (
    <nav className="toolbar" aria-label="Инструменты">
      <div className="group" role="radiogroup" aria-label="Инструмент">
        {TOOLS.map(({ value, name, key, Icon }) => (
          <button
            key={value}
            className="tool"
            role="radio"
            aria-checked={state.tool === value}
            aria-label={name}
            title={`${name} (${key})`}
            data-tool={value}
            onClick={() => engine.setTool(value)}
          >
            <Icon />
          </button>
        ))}
      </div>
      <span className="sep" />
      <div className="group colors" role="radiogroup" aria-label="Цвет">
        {PEN_COLORS.map(({ value, name }) => (
          <button
            key={name}
            className="swatch"
            role="radio"
            aria-checked={pen && state.color === value}
            aria-label={name}
            title={name}
            onClick={() => engine.setColor(value)}
          >
            <span style={{ background: value ?? 'var(--canvas-ink)' }} />
          </button>
        ))}
      </div>
      <span className="sep" />
      <div className="group sizes" role="radiogroup" aria-label="Толщина">
        {PEN_SIZES.map(({ value, name, dot }) => (
          <button
            key={value}
            className="size"
            role="radio"
            aria-checked={pen && state.size === value}
            aria-label={name}
            title={name}
            onClick={() => engine.setSize(value)}
          >
            <span style={{ width: dot, height: dot }} />
          </button>
        ))}
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className="tool"
          aria-label="Отменить"
          title={`Отменить (${mod}Z)`}
          disabled={!state.canUndo}
          onClick={() => engine.undo()}
        >
          <UndoIcon />
        </button>
        <button
          className="tool"
          aria-label="Повторить"
          title={`Повторить (${mod}Shift+Z)`}
          disabled={!state.canRedo}
          onClick={() => engine.redo()}
        >
          <RedoIcon />
        </button>
        <button className="tool" aria-label="Настройки" title="Настройки" onClick={onSettings}>
          <SettingsIcon />
        </button>
      </div>
    </nav>
  );
}
