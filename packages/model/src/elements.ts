/**
 * Модель данных холста (см. docs/PLAN.md, раздел 5).
 * Воркспейс → Проект → Доска → Элемент. Каждая доска — отдельный Yjs-документ.
 */

export type ElementId = string;
export type AssetId = string; // sha256 содержимого

export type ElementType = 'stroke' | 'text' | 'sticky' | 'image' | 'frame' | 'arrow' | 'shape';

/** Кто создал или изменил элемент. Нужен, чтобы видеть и откатывать правки агентов. */
export interface Actor {
  kind: 'human' | 'agent';
  /** Например: «kayos», «claude-code», «chatgpt». */
  name: string;
  device?: string;
}

export interface Style {
  color?: string;
  size?: number;
  opacity?: number;
  font?: string;
}

export interface BaseElement<T extends ElementType, P> {
  id: ElementId;
  type: T;
  /** Мировые координаты левого верхнего угла рамки. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Дробный индекс для порядка слоёв (строки сравниваются лексикографически). */
  z: string;
  parentId?: ElementId;
  style: Style;
  props: P;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
  links?: ElementId[];
}

export type StrokeTool = 'pen' | 'marker' | 'highlighter';

export interface StrokeProps {
  tool: StrokeTool;
  /** Упакованные точки, см. stroke-codec.ts. Относительно (x, y) элемента. */
  points: Uint8Array;
  /** Было ли настоящее давление пера (иначе — имитация по скорости). */
  hasPressure: boolean;
  /**
   * Мировых единиц на экранный пиксель в момент рисования (1 / zoom). Нужен, чтобы контур
   * пересчитывался из точек точно так же, как его видел автор. Нет — значит 1.
   */
  unit?: number;
}

export interface TextProps {
  /** В Yjs это Y.XmlFragment (TipTap); здесь — сериализованный вид для экспорта. */
  content: string;
}

export interface StickyProps extends TextProps {
  autoSize: boolean;
}

export interface ImageProps {
  assetId: AssetId;
  naturalW: number;
  naturalH: number;
  crop?: { x: number; y: number; w: number; h: number };
  alt?: string;
}

export interface FrameProps {
  name: string;
}

export type ArrowEnd = { kind: 'point'; x: number; y: number } | { kind: 'element'; id: ElementId };

export interface ArrowProps {
  /** Концы стрелки: точка — в мировых координатах. */
  start: ArrowEnd;
  end: ArrowEnd;
  label?: string;
  /** Наконечники: нет (линия), на конце (по умолчанию), на обоих концах. */
  heads?: 'none' | 'end' | 'both';
}

export interface ShapeProps {
  shape: 'rect' | 'ellipse' | 'line';
  label?: string;
}

export type StrokeElement = BaseElement<'stroke', StrokeProps>;
export type TextElement = BaseElement<'text', TextProps>;
export type StickyElement = BaseElement<'sticky', StickyProps>;
export type ImageElement = BaseElement<'image', ImageProps>;
export type FrameElement = BaseElement<'frame', FrameProps>;
export type ArrowElement = BaseElement<'arrow', ArrowProps>;
export type ShapeElement = BaseElement<'shape', ShapeProps>;

export type CanvasElement =
  | StrokeElement
  | TextElement
  | StickyElement
  | ImageElement
  | FrameElement
  | ArrowElement
  | ShapeElement;

export interface Board {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  order: string;
  archived: boolean;
}
