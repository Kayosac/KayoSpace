import type { ComponentType } from 'react';
import type { CanvasEngine, EngineState, Tool } from '@kayospace/canvas';
import { STICKY_COLORS, type ShapeKind } from '@kayospace/canvas';
import {
  ArrowIcon,
  EllipseIcon,
  EraserIcon,
  HandIcon,
  LineIcon,
  PasteIcon,
  PenIcon,
  RectIcon,
  RedoIcon,
  SelectIcon,
  SettingsIcon,
  ShapesIcon,
  StickyIcon,
  TextIcon,
  UndoIcon,
} from './icons';

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

/** Диаметр ластика в экранных пикселях. */
export const ERASER_SIZES: { value: number; name: string; dot: number }[] = [
  { value: 12, name: 'Маленький ластик', dot: 6 },
  { value: 28, name: 'Средний ластик', dot: 11 },
  { value: 60, name: 'Большой ластик', dot: 17 },
];

const TOOLS: { value: Tool; name: string; key: string; Icon: ComponentType }[] = [
  { value: 'select', name: 'Выделение', key: 'V', Icon: SelectIcon },
  { value: 'pen', name: 'Перо', key: 'P', Icon: PenIcon },
  { value: 'eraser', name: 'Ластик', key: 'E', Icon: EraserIcon },
  { value: 'sticky', name: 'Стикер', key: 'N', Icon: StickyIcon },
  { value: 'text', name: 'Текст', key: 'T', Icon: TextIcon },
  { value: 'shape', name: 'Фигуры', key: 'R, O, L, A', Icon: ShapesIcon },
  { value: 'hand', name: 'Рука', key: 'H', Icon: HandIcon },
];

const SHAPES: { value: ShapeKind; name: string; key: string; Icon: ComponentType }[] = [
  { value: 'rect', name: 'Прямоугольник', key: 'R', Icon: RectIcon },
  { value: 'ellipse', name: 'Эллипс', key: 'O', Icon: EllipseIcon },
  { value: 'line', name: 'Линия', key: 'L', Icon: LineIcon },
  { value: 'arrow', name: 'Стрелка', key: 'A', Icon: ArrowIcon },
];

const STICKY_NAMES = ['Жёлтый', 'Розовый', 'Мятный', 'Голубой', 'Лавандовый', 'Персиковый'];

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
  const tool = state.tool;
  const eraser = tool === 'eraser';
  // Палитра стикеров — для инструмента «Стикер» и когда выделены только стикеры.
  const stickyPalette =
    tool === 'sticky' || (tool === 'select' && state.selectionKind === 'sticky');
  // Цвет и толщина «чернил» относятся к перу, тексту и фигурам.
  const inkTool = tool === 'pen' || tool === 'text' || tool === 'shape';
  const showSizes = !stickyPalette && tool !== 'text';
  return (
    <nav className="toolbar" aria-label="Инструменты">
      <div className="group" role="radiogroup" aria-label="Инструмент">
        {TOOLS.map(({ value, name, key, Icon }) => (
          <button
            key={value}
            className="tool"
            role="radio"
            aria-checked={tool === value}
            aria-label={name}
            title={`${name} (${key})`}
            data-tool={value}
            onClick={() => engine.setTool(value)}
          >
            <Icon />
          </button>
        ))}
      </div>
      {tool === 'shape' && (
        <>
          <span className="sep" />
          <div className="group" role="radiogroup" aria-label="Фигура">
            {SHAPES.map(({ value, name, key, Icon }) => (
              <button
                key={value}
                className="tool"
                role="radio"
                aria-checked={state.shapeKind === value}
                aria-label={name}
                title={`${name} (${key}); Shift — ровно`}
                onClick={() => engine.setShapeKind(value)}
              >
                <Icon />
              </button>
            ))}
          </div>
        </>
      )}
      <span className="sep" />
      {stickyPalette ? (
        <div className="group colors" role="radiogroup" aria-label="Цвет стикера">
          {STICKY_COLORS.map((value, i) => (
            <button
              key={value}
              className="swatch sticky-swatch"
              role="radio"
              aria-checked={tool === 'sticky' && state.stickyColor === value}
              aria-label={`Стикер: ${STICKY_NAMES[i] ?? value}`}
              title={STICKY_NAMES[i] ?? value}
              onClick={() => engine.setStickyColor(value)}
            >
              <span style={{ background: value }} />
            </button>
          ))}
        </div>
      ) : (
        <div className="group colors" role="radiogroup" aria-label="Цвет">
          {PEN_COLORS.map(({ value, name }) => (
            <button
              key={name}
              className="swatch"
              role="radio"
              aria-checked={inkTool && state.color === value}
              aria-label={name}
              title={name}
              onClick={() => engine.setColor(value)}
            >
              <span style={{ background: value ?? 'var(--canvas-ink)' }} />
            </button>
          ))}
        </div>
      )}
      {showSizes && (
        <>
          <span className="sep" />
          <div
            className="group sizes"
            role="radiogroup"
            aria-label={eraser ? 'Размер ластика' : 'Толщина'}
            data-eraser={eraser || undefined}
          >
            {(eraser ? ERASER_SIZES : PEN_SIZES).map(({ value, name, dot }) => (
              <button
                key={name}
                className="size"
                role="radio"
                aria-checked={
                  eraser
                    ? state.eraserSize === value
                    : (tool === 'pen' || tool === 'shape') && state.size === value
                }
                aria-label={name}
                title={name}
                onClick={() => (eraser ? engine.setEraserSize(value) : engine.setSize(value))}
              >
                <span style={{ width: dot, height: dot }} />
              </button>
            ))}
          </div>
        </>
      )}
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
        {state.canPaste && (
          <button
            className="tool"
            aria-label="Вставить"
            title={`Вставить (${mod}V)`}
            onClick={() => engine.paste()}
          >
            <PasteIcon />
          </button>
        )}
        <button className="tool" aria-label="Настройки" title="Настройки" onClick={onSettings}>
          <SettingsIcon />
        </button>
      </div>
    </nav>
  );
}
