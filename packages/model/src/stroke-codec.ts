/**
 * Компактное хранение точек штриха.
 *
 * Штрих после создания не меняется, поэтому храним его одним бинарным блоком,
 * а не массивом Yjs: в разы меньше по объёму и быстрее при загрузке доски.
 *
 * Формат v1: [версия u8][флаги u8][count u32 LE] затем count точек по 6 × float32:
 *   x, y — относительно начала штриха; p — давление 0..1; tx, ty — наклон в градусах; t — мс от начала.
 */

export interface StrokePoint {
  x: number;
  y: number;
  /** Давление 0..1 (0.5 — если устройство его не передаёт). */
  p: number;
  tx: number;
  ty: number;
  /** Время от начала штриха, мс. */
  t: number;
}

const VERSION = 1;
const HEADER_BYTES = 6;
const FLOATS_PER_POINT = 6;
const BYTES_PER_POINT = FLOATS_PER_POINT * 4;

export function encodeStroke(points: readonly StrokePoint[]): Uint8Array {
  const buf = new ArrayBuffer(HEADER_BYTES + points.length * BYTES_PER_POINT);
  const view = new DataView(buf);
  view.setUint8(0, VERSION);
  view.setUint8(1, 0);
  view.setUint32(2, points.length, true);
  let o = HEADER_BYTES;
  for (const pt of points) {
    view.setFloat32(o, pt.x, true);
    view.setFloat32(o + 4, pt.y, true);
    view.setFloat32(o + 8, pt.p, true);
    view.setFloat32(o + 12, pt.tx, true);
    view.setFloat32(o + 16, pt.ty, true);
    view.setFloat32(o + 20, pt.t, true);
    o += BYTES_PER_POINT;
  }
  return new Uint8Array(buf);
}

export function decodeStroke(bytes: Uint8Array): StrokePoint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) {
    throw new Error(`Неизвестная версия формата штриха: ${version}`);
  }
  const count = view.getUint32(2, true);
  const expected = HEADER_BYTES + count * BYTES_PER_POINT;
  if (bytes.byteLength < expected) {
    throw new Error(`Штрих обрезан: ожидалось ${expected} байт, есть ${bytes.byteLength}`);
  }
  const out: StrokePoint[] = new Array(count);
  let o = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    out[i] = {
      x: view.getFloat32(o, true),
      y: view.getFloat32(o + 4, true),
      p: view.getFloat32(o + 8, true),
      tx: view.getFloat32(o + 12, true),
      ty: view.getFloat32(o + 16, true),
      t: view.getFloat32(o + 20, true),
    };
    o += BYTES_PER_POINT;
  }
  return out;
}

/** Рамка штриха в тех же координатах, что и точки. */
export function strokeBounds(points: readonly StrokePoint[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}
