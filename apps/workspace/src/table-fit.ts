/**
 * Размеры таблицы (решение 0025): ширины колонок по умолчанию и «Подогнать» — ширины и высоты
 * под содержимое. Ширину текста меряет переданная функция (в приложении — canvas), поэтому
 * расчёт проверяется тестом без браузера.
 */

import {
  CELL_PAD,
  ROW_MIN_HEIGHT,
  cellText,
  clampColWidth,
  type Column,
  type ColumnType,
  type Row,
} from '@kayospace/page';

/** Ширина колонки без заданной — как у Google Таблиц: одна на тип. */
export const DEFAULT_WIDTH: Record<ColumnType, number> = {
  text: 200,
  number: 120,
  checkbox: 96,
  date: 160,
  select: 160,
  url: 220,
  formula: 140,
};

export const columnWidth = (c: Column): number => c.width ?? DEFAULT_WIDTH[c.type];

/** «Подогнать» не делает колонку шире этого: длинный текст — не на весь экран. */
export const FIT_MAX_WIDTH = 480;
/** Картинки при подгонке — не выше этого (дальше строку тянут руками). */
export const FIT_IMAGE_HEIGHT = 160;

export type Measure = (text: string, kind: 'cell' | 'head') => number;

/** Отступы ячейки и шапки (как в стилях .kt-input, .kt-head). */
const CELL_X = 20;
const HEAD_X = 20 + 28 + 18; // поля, значок типа, место под стрелку сортировки
const IMG_GAP = 4;

/** Высота строки под содержимое: текст — обычная; с картинками — чтобы они были видны, но в меру. */
export function fitRowHeight(r: Row): number | null {
  let tallest = 0;
  for (const list of Object.values(r.images ?? {}))
    for (const img of list) tallest = Math.max(tallest, img.h);
  if (!tallest) return null;
  return Math.max(ROW_MIN_HEIGHT, Math.min(tallest, FIT_IMAGE_HEIGHT) + CELL_PAD * 2);
}

/** Ширина значения ячейки (без картинок). */
function valueWidth(c: Column, r: Row, measure: Measure): number {
  const text = cellText(c, r.cells[c.id]);
  switch (c.type) {
    case 'checkbox':
      return 48;
    case 'date':
      return 150;
    case 'select':
      return measure(text || '—', 'cell') + CELL_X + 28;
    case 'url':
      return measure(text, 'cell') + CELL_X + 32;
    default:
      return text ? measure(text, 'cell') + CELL_X : 0;
  }
}

/** Ширина картинок ячейки при высоте строки. */
function imagesWidth(r: Row, colId: string, rowHeight: number | undefined): number {
  const list = r.images?.[colId];
  if (!list?.length) return 0;
  const h = (rowHeight ?? ROW_MIN_HEIGHT) - CELL_PAD * 2;
  return list.reduce((s, img) => s + (h * img.w) / img.h, 0) + IMG_GAP * list.length + CELL_PAD;
}

/** Ширина колонки под содержимое (при данных высотах строк). */
export function fitColumnWidth(
  c: Column,
  rows: readonly Row[],
  measure: Measure,
  heights: Readonly<Record<string, number | null | undefined>> = {},
): number {
  let w = measure(c.name, 'head') + HEAD_X;
  for (const r of rows) {
    const h = r.id in heights ? (heights[r.id] ?? undefined) : r.height;
    w = Math.max(w, imagesWidth(r, c.id, h) + valueWidth(c, r, measure));
  }
  return clampColWidth(Math.min(FIT_MAX_WIDTH, Math.ceil(w)));
}

/** «Подогнать»: высоты строк под картинки (или по тексту), затем ширины колонок под всё это. */
export function fitSizes(
  columns: readonly Column[],
  rows: readonly Row[],
  measure: Measure,
): { columns: Record<string, number>; rows: Record<string, number | null> } {
  const heights: Record<string, number | null> = {};
  for (const r of rows) heights[r.id] = fitRowHeight(r);
  const widths: Record<string, number> = {};
  for (const c of columns) widths[c.id] = fitColumnWidth(c, rows, measure, heights);
  return { columns: widths, rows: heights };
}

/** Мерка текста шрифтом интерфейса (canvas — без раскладки страницы). */
export function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d');
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() ||
    'system-ui, sans-serif';
  return (text, kind) => {
    if (!ctx) return text.length * 8;
    ctx.font = kind === 'head' ? `600 14px ${family}` : `15px ${family}`;
    return ctx.measureText(text).width;
  };
}

/** Масштаб таблицы: шаги кнопок «−» и «+» и пределы щипка и колёсика. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const clampZoom = (z: number): number =>
  Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

export function zoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN;
}
