import { describe, expect, it } from 'vitest';
import type { Column, Row } from '@kayospace/page';
import { clampZoom, fitColumnWidth, fitRowHeight, fitSizes, zoomStep } from './table-fit';

// Мерка без браузера: 8 пикселей на символ.
const measure = (t: string) => t.length * 8;
const A = 'a'.repeat(64);

describe('подгонка размеров таблицы', () => {
  const name: Column = { id: 'n', name: 'Название', type: 'text' };
  const done: Column = { id: 'd', name: 'Готово', type: 'checkbox' };
  const rows: Row[] = [
    { id: 'r1', cells: { n: 'Керамика белая', d: true } },
    {
      id: 'r2',
      cells: { n: 'Клей' },
      images: { n: [{ asset: A, w: 400, h: 200 }] },
      height: 300,
    },
  ];

  it('строка: с картинками — под них (в меру), без — по тексту', () => {
    expect(fitRowHeight(rows[0]!)).toBeNull();
    expect(fitRowHeight(rows[1]!)).toBe(160 + 12);
    expect(fitRowHeight({ id: 'x', cells: {}, images: { n: [{ asset: A, w: 10, h: 10 }] } })).toBe(
      40,
    );
  });

  it('колонка: шапка, текст и картинки при новой высоте; не уже и не шире пределов', () => {
    const fit = fitSizes([name, done], rows, measure);
    expect(fit.rows).toEqual({ r1: null, r2: 172 });
    // Картинка 160 в высоту → 320 в ширину, плюс отступы и «Клей».
    expect(fit.columns.n).toBe(Math.ceil(320 + 6 + 6 + 4 * 8 + 20));
    expect(fit.columns.d).toBe(Math.ceil(6 * 8 + 66));
    const long: Row = { id: 'l', cells: { n: 'x'.repeat(500) } };
    expect(fitColumnWidth(name, [long], measure)).toBe(480);
    expect(fitColumnWidth({ id: 'e', name: '', type: 'text' }, [], measure)).toBe(66);
  });

  it('картинки своего размера и с подписями (решение 0026): строку растят сами, плитка не уже подписи', () => {
    const row: Row = {
      id: 'z',
      cells: {},
      images: {
        n: [
          { asset: A, w: 100, h: 100, size: 48, caption: '80 монет / Обычный' },
          { asset: A, w: 200, h: 100, size: 48 },
        ],
      },
    };
    expect(fitRowHeight(row)).toBeNull();
    // Плитки: max(48, 56) + 96, по 6 между, и отступ.
    expect(fitColumnWidth(name, [row], measure)).toBe(Math.ceil(56 + 96 + 6 * 2 + 6));
  });

  it('масштаб: шаги и пределы', () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(1.05, -1)).toBe(1);
    expect(zoomStep(2, 1)).toBe(2);
    expect(zoomStep(0.5, -1)).toBe(0.5);
    expect(clampZoom(7)).toBe(2);
    expect(clampZoom(0.333)).toBe(0.5);
  });
});
