/**
 * Цвет для палитры: HSV ↔ #rrggbb и положение на круге.
 * Круг: угол — тон, расстояние от центра — насыщенность; яркость — отдельным ползунком.
 * Толщина на ползунке — логарифмическая шкала: тонкие линии различаются так же хорошо, как толстые.
 */

export interface Hsv {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const hex = (x: number): string =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(5))}${hex(f(3))}${hex(f(1))}`;
}

export function hexToHsv(hex: string): Hsv | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

/** Точка на круге радиуса 1 (центр 0,0; y вниз) → тон и насыщенность. */
export function wheelPick(x: number, y: number): { h: number; s: number } {
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { h, s: Math.min(1, Math.hypot(x, y)) };
}

/** Где на круге радиуса 1 стоит цвет. */
export function wheelPoint(h: number, s: number): { x: number; y: number } {
  const a = (h * Math.PI) / 180;
  return { x: Math.cos(a) * s, y: Math.sin(a) * s };
}

/** Ползунок 0..1 → толщина в [min, max] по логарифмической шкале, с шагом 0,5. */
export function sliderToSize(t: number, min: number, max: number): number {
  const v = min * Math.pow(max / min, Math.max(0, Math.min(1, t)));
  return Math.max(min, Math.min(max, Math.round(v * 2) / 2));
}

export function sizeToSlider(size: number, min: number, max: number): number {
  const v = Math.max(min, Math.min(max, size));
  return Math.log(v / min) / Math.log(max / min);
}

/** Читается ли текст тёмного цвета на этом фоне (для подписи на образце). */
export function isLight(hex: string): boolean {
  const c = hexToHsv(hex);
  if (!c) return true;
  const n = Number.parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6;
}
