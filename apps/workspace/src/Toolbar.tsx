import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import type { CanvasEngine, EngineState, Tool } from '@kayospace/canvas';
import type { StrokeTool } from '@kayospace/model';
import { HIGHLIGHTER_COLOR, STICKY_COLORS, type ShapeKind } from '@kayospace/canvas';
import { ColorPicker } from './ColorPicker';
import { sizeToSlider } from './colors';
import { Popover } from './Popover';
import { SizePicker } from './SizePicker';
import {
  ArrowIcon,
  EllipseIcon,
  EraserIcon,
  FrameIcon,
  HandIcon,
  HighlighterIcon,
  MarkerIcon,
  ImageIcon,
  LineIcon,
  PasteIcon,
  PenIcon,
  RectIcon,
  RedoIcon,
  SelectIcon,
  SettingsIcon,
  ShapesIcon,
  SparkleIcon,
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
  { value: 'frame', name: 'Фрейм', key: 'F', Icon: FrameIcon },
  { value: 'hand', name: 'Рука', key: 'H', Icon: HandIcon },
];

const PEN_KINDS: { value: StrokeTool; name: string; key: string; Icon: ComponentType }[] = [
  { value: 'pen', name: 'Ручка', key: 'P', Icon: PenIcon },
  { value: 'marker', name: 'Маркер', key: 'M', Icon: MarkerIcon },
  { value: 'highlighter', name: 'Выделитель', key: 'I', Icon: HighlighterIcon },
];

const SHAPES: { value: ShapeKind; name: string; key: string; Icon: ComponentType }[] = [
  { value: 'rect', name: 'Прямоугольник', key: 'R', Icon: RectIcon },
  { value: 'ellipse', name: 'Эллипс', key: 'O', Icon: EllipseIcon },
  { value: 'line', name: 'Линия', key: 'L', Icon: LineIcon },
  { value: 'arrow', name: 'Стрелка', key: 'A', Icon: ArrowIcon },
];

const STICKY_NAMES = ['Жёлтый', 'Розовый', 'Мятный', 'Голубой', 'Лавандовый', 'Персиковый'];

/** Можно ли прочитать системный буфер кнопкой (без клавиатуры). */
const canReadClipboard =
  typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function';

const mod =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function Toolbar({
  engine,
  state,
  onSettings,
  onImages,
  onPaste,
  onAi,
  aiOn,
  recentColors,
  onRecentColor,
}: {
  engine: CanvasEngine;
  state: EngineState;
  onSettings: () => void;
  onImages: (files: File[]) => void;
  onPaste: () => void;
  onAi: () => void;
  aiOn: boolean;
  /** Свои цвета из палитры, свежие — первыми. */
  recentColors: string[];
  onRecentColor: (color: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const tool = state.tool;
  const eraser = tool === 'eraser';
  // Палитра стикеров — для инструмента «Стикер» и когда выделены только стикеры.
  const stickyPalette =
    tool === 'sticky' || (tool === 'select' && state.selectionKind === 'sticky');
  // Цвет и толщина «чернил» относятся к перу, тексту и фигурам.
  const inkTool = tool === 'pen' || tool === 'text' || tool === 'shape';
  const showSizes = !stickyPalette && tool !== 'text' && tool !== 'frame';
  const [open, setOpen] = useState<'color' | 'size' | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const sizeBtn = useRef<HTMLButtonElement>(null);
  // Сменили инструмент (в том числе с клавиатуры) — окно о прежнем инструменте закрываем.
  useEffect(() => setOpen(null), [tool, stickyPalette]);
  const inkColor = inkTool ? state.color : null;
  const shownColor = stickyPalette
    ? state.stickyColor
    : tool === 'pen' && state.penKind === 'highlighter' && !state.color
      ? HIGHLIGHTER_COLOR
      : (inkColor ?? 'var(--canvas-ink)');
  // Кружок на кнопке — от 4 до 18 пикселей, растёт вместе с толщиной.
  const sizeDot = eraser
    ? Math.round(6 + 12 * sizeToSlider(state.eraserSize, 6, 160))
    : Math.round(4 + 14 * sizeToSlider(state.size, 0.5, 48));
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
        <button
          className="tool"
          aria-label="Картинка"
          title="Картинка (или вставьте из буфера, перетащите файл)"
          onClick={() => fileRef.current?.click()}
        >
          <ImageIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          data-testid="image-input"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            if (files.length) onImages(files);
          }}
        />
      </div>
      {tool === 'pen' && (
        <>
          <span className="sep" />
          <div className="group" role="radiogroup" aria-label="Вид пера">
            {PEN_KINDS.map(({ value, name, key, Icon }) => (
              <button
                key={value}
                className="tool"
                role="radio"
                aria-checked={state.penKind === value}
                aria-label={name}
                title={`${name} (${key})`}
                onClick={() => engine.setPenKind(value)}
              >
                <Icon />
              </button>
            ))}
          </div>
        </>
      )}
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
      <div className="group">
        <button
          ref={colorBtn}
          className="tool picker-btn"
          aria-label={stickyPalette ? 'Цвет стикера' : 'Цвет'}
          title={stickyPalette ? 'Цвет стикера' : 'Цвет'}
          aria-haspopup="dialog"
          aria-expanded={open === 'color'}
          data-testid="color-button"
          onClick={() => setOpen((o) => (o === 'color' ? null : 'color'))}
        >
          <span className="current-swatch" style={{ background: shownColor }} />
        </button>
        {showSizes && (
          <button
            ref={sizeBtn}
            className="tool picker-btn"
            aria-label={eraser ? 'Размер ластика' : 'Толщина'}
            title={eraser ? 'Размер ластика' : 'Толщина'}
            aria-haspopup="dialog"
            aria-expanded={open === 'size'}
            data-testid="size-button"
            onClick={() => setOpen((o) => (o === 'size' ? null : 'size'))}
          >
            <span
              className={eraser ? 'current-size hollow' : 'current-size'}
              style={{ width: sizeDot, height: sizeDot }}
            />
          </button>
        )}
      </div>
      {open === 'color' && (
        <Popover anchor={colorBtn} label="Цвет" onClose={close} testId="color-popover">
          {stickyPalette ? (
            <ColorPicker
              pastel
              value={state.stickyColor}
              presets={STICKY_COLORS.map((value, i) => ({
                value,
                name: `Стикер: ${STICKY_NAMES[i] ?? value}`,
              }))}
              recent={[]}
              onPick={(c, o) => {
                if (c) engine.setStickyColor(c);
                if (o.close) close();
              }}
            />
          ) : (
            <ColorPicker
              value={inkColor}
              presets={PEN_COLORS}
              recent={recentColors}
              onPick={(c, o) => {
                engine.setColor(c);
                if (o.custom && c) onRecentColor(c);
                if (o.close) close();
              }}
            />
          )}
        </Popover>
      )}
      {open === 'size' && showSizes && (
        <Popover anchor={sizeBtn} label="Толщина" onClose={close} testId="size-popover">
          <SizePicker
            label={eraser ? 'Ластик' : 'Толщина'}
            value={eraser ? state.eraserSize : state.size}
            min={eraser ? 6 : 0.5}
            max={eraser ? 160 : 48}
            presets={eraser ? ERASER_SIZES : PEN_SIZES}
            hollow={eraser}
            color={shownColor}
            onChange={(v) => (eraser ? engine.setEraserSize(v) : engine.setSize(v))}
            onPreset={(v) => {
              if (eraser) engine.setEraserSize(v);
              else engine.setSize(v);
              close();
            }}
          />
        </Popover>
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
        {(state.canPaste || canReadClipboard) && (
          <button
            className="tool"
            aria-label="Вставить"
            title={`Вставить из буфера: текст, картинку или скопированное (${mod}V)`}
            onClick={onPaste}
          >
            <PasteIcon />
          </button>
        )}
        <button
          className="tool ai-tool"
          aria-label="ИИ"
          aria-pressed={aiOn}
          title={`Попросить ИИ (${mod}J)`}
          onClick={onAi}
        >
          <SparkleIcon />
        </button>
        <button className="tool" aria-label="Настройки" title="Настройки" onClick={onSettings}>
          <SettingsIcon />
        </button>
      </div>
    </nav>
  );
}
