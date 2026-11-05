/**
 * Фигуры (решение 0022): контур каждой — многоугольник в рамке элемента. Общий код для холста,
 * картинки доски на хабе и попадания по контуру (ластик). Эллипс и прямоугольники холст рисует
 * своими средствами, но многоугольник нужен им для попадания и для хаба.
 */

export type ShapeType =
  | 'rect'
  | 'roundRect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'hexagon'
  | 'star'
  | 'blockArrow'
  | 'bubble'
  | 'line';

/** Замкнутые фигуры — у них бывает заливка. */
export const CLOSED_SHAPES: readonly ShapeType[] = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'star',
  'blockArrow',
  'bubble',
];

export const isShapeType = (v: unknown): v is ShapeType =>
  typeof v === 'string' && (CLOSED_SHAPES as readonly string[]).includes(v);

interface Pt {
  x: number;
  y: number;
}

function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  n: number,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

/** Скругление прямоугольника — радиус в долях меньшей стороны. */
export const ROUND_RECT_RADIUS = 0.2;

function roundedRect(x: number, y: number, w: number, h: number, r: number, n = 6): Pt[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const P = Math.PI;
  return [
    ...arc(x + w - rr, y + rr, rr, rr, -P / 2, 0, n),
    ...arc(x + w - rr, y + h - rr, rr, rr, 0, P / 2, n),
    ...arc(x + rr, y + h - rr, rr, rr, P / 2, P, n),
    ...arc(x + rr, y + rr, rr, rr, P, (3 * P) / 2, n),
  ];
}

/** Контур фигуры многоугольником (мировые координаты, без поворота). */
export function shapePolygon(shape: ShapeType, x: number, y: number, w: number, h: number): Pt[] {
  switch (shape) {
    case 'ellipse':
      return arc(x + w / 2, y + h / 2, w / 2, h / 2, 0, Math.PI * 2, 48).slice(0, -1);
    case 'roundRect':
      return roundedRect(x, y, w, h, Math.min(w, h) * ROUND_RECT_RADIUS);
    case 'triangle':
      return [
        { x: x + w / 2, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    case 'diamond':
      return [
        { x: x + w / 2, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
      ];
    case 'hexagon':
      return [
        { x: x + w * 0.25, y },
        { x: x + w * 0.75, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w * 0.75, y: y + h },
        { x: x + w * 0.25, y: y + h },
        { x, y: y + h / 2 },
      ];
    case 'star': {
      // Пятиконечная звезда, растянутая точно в рамку.
      const pts: Pt[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const k = i % 2 === 0 ? 1 : 0.42;
        pts.push({ x: Math.cos(a) * k, y: Math.sin(a) * k });
      }
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      return pts.map((p) => ({
        x: x + ((p.x - minX) / (maxX - minX)) * w,
        y: y + ((p.y - minY) / (maxY - minY)) * h,
      }));
    }
    case 'blockArrow': {
      const head = Math.min(w * 0.45, h * 0.9);
      const t = h * 0.25;
      return [
        { x, y: y + t },
        { x: x + w - head, y: y + t },
        { x: x + w - head, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w - head, y: y + h },
        { x: x + w - head, y: y + h - t },
        { x, y: y + h - t },
      ];
    }
    case 'bubble': {
      // Выноска для реплики: скруглённый прямоугольник и хвостик внизу слева.
      const bh = h * 0.78;
      const r = Math.min(w, bh) * 0.22;
      const body = roundedRect(x, y, w, bh, r);
      // Вставляем хвостик в нижний край (между нижними правым и левым скруглениями).
      const n = body.length / 4;
      const bottomRightEnd = Math.round(2 * n) - 1; // последняя точка второй дуги
      const tail: Pt[] = [
        { x: x + w * 0.42, y: y + bh },
        { x: x + w * 0.16, y: y + h },
        { x: x + w * 0.26, y: y + bh },
      ];
      return [...body.slice(0, bottomRightEnd + 1), ...tail, ...body.slice(bottomRightEnd + 1)];
    }
    default:
      return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
  }
}
