import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { CanvasEngine, EngineState, Tool } from '@kayospace/canvas';
import { shapePolygon, type ShapeType, type StrokeTool } from '@kayospace/model';
import { HIGHLIGHTER_COLOR, STICKY_COLORS, type ShapeKind } from '@kayospace/canvas';
import { ColorPicker } from './ColorPicker';
import { sizeToSlider } from './colors';
import { Popover } from './Popover';
import { SizePicker } from './SizePicker';
import {
  ArrowIcon,
  DocIcon,
  EllipseIcon,
  EraserIcon,
  FrameIcon,
  HandIcon,
  HighlighterIcon,
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
  ChatIcon,
  TaskIcon,
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
  { value: 'highlighter', name: 'Выделитель', key: 'I', Icon: HighlighterIcon },
];

/** Значок фигуры по её контуру (решение 0022). */
const glyph = (shape: ShapeType): ComponentType =>
  function Glyph() {
    const pts = shapePolygon(shape, 3.5, 5.5, 17, 13);
    return (
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polygon points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} />
      </svg>
    );
  };

/** Фигуры — списком, который выпадает вверх от кнопки «Фигуры» (решение 0022). */
const SHAPES: { value: ShapeKind; name: string; key?: string; Icon: ComponentType }[] = [
  { value: 'rect', name: 'Прямоугольник', key: 'R', Icon: RectIcon },
  { value: 'roundRect', name: 'Скруглённый прямоугольник', Icon: glyph('roundRect') },
  { value: 'ellipse', name: 'Эллипс', key: 'O', Icon: EllipseIcon },
  { value: 'triangle', name: 'Треугольник', Icon: glyph('triangle') },
  { value: 'diamond', name: 'Ромб', Icon: glyph('diamond') },
  { value: 'hexagon', name: 'Шестиугольник', Icon: glyph('hexagon') },
  { value: 'star', name: 'Звезда', Icon: glyph('star') },
  { value: 'blockArrow', name: 'Блок-стрелка', Icon: glyph('blockArrow') },
  { value: 'bubble', name: 'Выноска', Icon: glyph('bubble') },
  { value: 'line', name: 'Линия', key: 'L', Icon: LineIcon },
  { value: 'arrow', name: 'Стрелка', key: 'A', Icon: ArrowIcon },
];

/** Заливка фигур: «Прозрачный» — без заливки, дальше — светлые и насыщенные заготовки. */
const FILL_COLORS: { value: string | null; name: string }[] = [
  { value: null, name: 'Прозрачный' },
  { value: '#ffe58a', name: 'Жёлтый' },
  { value: '#ffc4d1', name: 'Розовый' },
  { value: '#b8e3c9', name: 'Мятный' },
  { value: '#bcd7ff', name: 'Голубой' },
  { value: '#1c1f26', name: 'Чёрный' },
  { value: '#ffffff', name: 'Белый' },
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
  onTasks,
  onChat,
  onImages,
  docMenu,
  onPaste,
  onAi,
  aiOn,
  recentColors,
  onRecentColor,
}: {
  engine: CanvasEngine;
  state: EngineState;
  onSettings: () => void;
  /** Панель «Задачи» (решение 0019). */
  onTasks: () => void;
  /** Чат с ИИ (решение 0019). */
  onChat: () => void;
  onImages: (files: File[]) => void;
  /** Меню «Документ или таблица» (решение 0021): close — закрыть окно. */
  docMenu?: (close: () => void) => ReactNode;
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
  const [open, setOpen] = useState<'color' | 'size' | 'doc' | 'shapes' | 'fill' | null>(null);
  const shapeBtn = useRef<HTMLButtonElement>(null);
  const fillBtn = useRef<HTMLButtonElement>(null);
  // Выделены фигуры — цвет контура, заливка и толщина относятся к ним (решение 0022).
  const selShapes = tool === 'select' ? state.selectionShapes : null;
  const showFill =
    (tool === 'shape' && state.shapeKind !== 'line' && state.shapeKind !== 'arrow') ||
    selShapes !== null;
  const shownFill = selShapes ? selShapes.fill : tool === 'shape' ? state.fill : null;
  const currentShape = SHAPES.find((x) => x.value === state.shapeKind) ?? SHAPES[0]!;
  const docBtn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(null), []);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const sizeBtn = useRef<HTMLButtonElement>(null);
  // Сменили инструмент (в том числе с клавиатуры) — окно о прежнем инструменте закрываем.
  // Список фигур открывается тем же касанием, что выбирает инструмент, — его не закрываем.
  useEffect(
    () => setOpen((o) => (o === 'shapes' && tool === 'shape' ? o : null)),
    [tool, stickyPalette],
  );
  const inkColor = selShapes ? selShapes.color : inkTool ? state.color : null;
  const shownColor = stickyPalette
    ? state.stickyColor
    : tool === 'pen' && state.penKind === 'highlighter' && !state.color
      ? HIGHLIGHTER_COLOR
      : (inkColor ?? 'var(--canvas-ink)');
  // Кружок на кнопке — от 4 до 18 пикселей, растёт вместе с толщиной.
  const sizeDot = eraser
    ? Math.round(6 + 12 * sizeToSlider(state.eraserSize, 6, 160))
    : Math.round(4 + 14 * sizeToSlider(selShapes ? selShapes.size : state.size, 0.5, 48));
  return (
    <nav className="toolbar" aria-label="Инструменты">
      <div className="group" role="radiogroup" aria-label="Инструмент">
        {TOOLS.map(({ value, name, key, Icon }) =>
          value === 'shape' ? (
            // «Фигуры»: касание выбирает инструмент и открывает список фигур вверх.
            <button
              key={value}
              ref={shapeBtn}
              className="tool"
              role="radio"
              aria-checked={tool === value}
              aria-label={name}
              aria-haspopup="dialog"
              aria-expanded={open === 'shapes'}
              title={`${name}: ${currentShape.name}`}
              data-tool={value}
              onClick={() => {
                if (tool !== 'shape') engine.setTool('shape');
                setOpen((o) => (o === 'shapes' ? null : 'shapes'));
              }}
            >
              {tool === 'shape' ? <currentShape.Icon /> : <Icon />}
            </button>
          ) : (
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
          ),
        )}
        <button
          className="tool"
          aria-label="Картинка, PDF или .md"
          title="Картинка, PDF или .md (или вставьте из буфера, перетащите файл)"
          onClick={() => fileRef.current?.click()}
        >
          <ImageIcon />
        </button>
        {docMenu && (
          <button
            ref={docBtn}
            className="tool"
            aria-label="Документ или таблица"
            title="Документ или таблица на доске"
            aria-expanded={open === 'doc'}
            onClick={() => setOpen((o) => (o === 'doc' ? null : 'doc'))}
            data-testid="doc-button"
          >
            <DocIcon />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf,.md,.markdown,text/markdown"
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
        {showFill && (
          <button
            ref={fillBtn}
            className="tool picker-btn"
            aria-label="Заливка"
            title="Заливка"
            aria-haspopup="dialog"
            aria-expanded={open === 'fill'}
            data-testid="fill-button"
            onClick={() => setOpen((o) => (o === 'fill' ? null : 'fill'))}
          >
            <span
              className={shownFill ? 'current-swatch filled' : 'current-swatch filled none'}
              style={shownFill ? { background: shownFill } : undefined}
            />
          </button>
        )}
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
      {open === 'shapes' && tool === 'shape' && (
        <Popover anchor={shapeBtn} label="Фигуры" onClose={close} testId="shapes-popover">
          <div className="shape-grid" role="radiogroup" aria-label="Фигура">
            {SHAPES.map(({ value, name, key, Icon }) => (
              <button
                key={value}
                className="tool"
                role="radio"
                aria-checked={state.shapeKind === value}
                aria-label={name}
                title={key ? `${name} (${key}); Shift — ровно` : `${name}; Shift — ровно`}
                onClick={() => {
                  engine.setShapeKind(value);
                  close();
                }}
              >
                <Icon />
              </button>
            ))}
          </div>
        </Popover>
      )}
      {open === 'fill' && showFill && (
        <Popover anchor={fillBtn} label="Заливка" onClose={close} testId="fill-popover">
          <ColorPicker
            value={shownFill}
            presets={FILL_COLORS}
            recent={recentColors}
            transparentNull
            onPick={(c, o) => {
              engine.setFill(c);
              if (o.custom && c) onRecentColor(c);
              if (o.close) close();
            }}
          />
        </Popover>
      )}
      {open === 'doc' && docMenu && (
        <Popover anchor={docBtn} label="Документ или таблица" onClose={close} testId="doc-popover">
          {docMenu(close)}
        </Popover>
      )}
      {open === 'size' && showSizes && (
        <Popover anchor={sizeBtn} label="Толщина" onClose={close} testId="size-popover">
          <SizePicker
            label={eraser ? 'Ластик' : 'Толщина'}
            value={eraser ? state.eraserSize : selShapes ? selShapes.size : state.size}
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
        <button className="tool" aria-label="Чат с ИИ" title="Чат с ИИ" onClick={onChat}>
          <ChatIcon />
        </button>
        <button className="tool" aria-label="Задачи" title="Задачи со всех досок" onClick={onTasks}>
          <TaskIcon />
        </button>
        <button className="tool" aria-label="Настройки" title="Настройки" onClick={onSettings}>
          <SettingsIcon />
        </button>
      </div>
    </nav>
  );
}
