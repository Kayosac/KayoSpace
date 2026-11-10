import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  COL_MIN_WIDTH,
  imageDisplayHeight,
  ROW_MIN_HEIGHT,
  fitTable,
  setColumnWidth,
  addCellImages,
  cellImageHeight,
  setCellImages,
  setRowHeight,
  addColumn,
  addRow,
  coerceCell,
  columnTotal,
  compareCells,
  computeTable,
  initTable,
  moveColumn,
  readTable,
  removeColumn,
  removeRows,
  tableLines,
  tableToMarkdown,
  updateColumn,
  updateRow,
} from './table';
import { docExcerpt, docKind } from './summary';
import { writePage } from './yjs';

/** Разделитель разрядов у toLocaleString — неразрывный пробел. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('значения ячеек по типу колонки', () => {
  it('число, флажок, дата, выбор, ссылка', () => {
    expect(coerceCell('number', '1 234,5')).toBe(1234.5);
    expect(coerceCell('number', 'abc')).toBeNull();
    expect(coerceCell('checkbox', 'да')).toBe(true);
    expect(coerceCell('checkbox', '')).toBe(false);
    expect(coerceCell('date', '05.11.2026')).toBe('2026-11-05');
    expect(coerceCell('date', '2026-11-05T10:00')).toBe('2026-11-05');
    expect(coerceCell('date', 'завтра')).toBeNull();
    expect(coerceCell('select', 'срочно', ['Срочно', 'Потом'])).toBe('Срочно');
    expect(coerceCell('url', 'example.com')).toBe('https://example.com');
    expect(coerceCell('text', '')).toBeNull();
  });
});

describe('таблица в Yjs', () => {
  it('колонки, строки, смена типа, перенос, удаление, markdown', () => {
    const doc = new Y.Doc();
    initTable(doc);
    const [name, done] = readTable(doc).columns;
    expect(name).toMatchObject({ name: 'Название', type: 'text' });
    expect(done).toMatchObject({ name: 'Готово', type: 'checkbox' });
    const price = addColumn(doc, { name: 'Цена', type: 'text' });
    const a = addRow(doc, { [name!.id]: 'Плитка', [price]: '1200' });
    const b = addRow(doc, { [name!.id]: 'Клей', [price]: '350,5', [done!.id]: true });
    // Текст → число: значения приводятся.
    updateColumn(doc, price, { type: 'number' });
    const t = readTable(doc);
    expect(t.rows.map((r) => r.cells[price])).toEqual([1200, 350.5]);
    const priceCol = t.columns.find((c) => c.id === price)!;
    expect(sp(columnTotal(priceCol, t.rows))).toBe('Σ 1 550,5');
    expect(columnTotal(done!, t.rows)).toBe('1 из 2');
    expect(compareCells(priceCol, 350.5, 1200)).toBeLessThan(0);
    updateRow(doc, a, { [done!.id]: 'x', nope: 1 });
    expect(readTable(doc).rows[0]!.cells[done!.id]).toBe(true);
    moveColumn(doc, price, -2);
    expect(readTable(doc).columns.map((c) => c.name)).toEqual(['Цена', 'Название', 'Готово']);
    expect(tableToMarkdown(doc)).toContain('| Цена | Название | Готово |');
    expect(tableToMarkdown(doc)).toContain('Цена — Число');
    expect(tableLines(doc).map(sp)).toContain('1 200 · Плитка · ✓');
    // Выбор: варианты — из введённого.
    const st = addColumn(doc, { name: 'Статус', type: 'text' });
    updateRow(doc, a, { [st]: 'Заказано' });
    updateColumn(doc, st, { type: 'select' });
    expect(readTable(doc).columns.find((c) => c.id === st)!.options).toEqual(['Заказано']);
    removeColumn(doc, st);
    expect(readTable(doc).rows[0]!.cells[st]).toBeUndefined();
    expect(removeRows(doc, [b])).toBe(1);
    expect(readTable(doc).rows).toHaveLength(1);
    expect(docKind('tb_x')).toBe('table');
    expect(docExcerpt('tb_x', doc)).toBe('1 строка · Цена, Название, Готово');
  });

  it('начало документа для карточки', () => {
    const doc = new Y.Doc();
    writePage(doc, '# Кухня\n\n- [x] Плитка\n- [ ] **Клей**\n\n[[board:k#f|Схема]]\n\nКонец');
    expect(docExcerpt('pg_x', doc)).toBe('Кухня\n☑ Плитка\n☐ Клей\nКонец');
  });
});

describe('картинки в ячейках и высота строки (решение 0024)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  it('в любой ячейке, рядом со значением; формулы и итоги не мешают', () => {
    const doc = new Y.Doc();
    initTable(doc, [
      { name: 'Что', type: 'text' },
      { name: 'Цена', type: 'number' },
      { name: 'Вдвое', type: 'formula', formula: '[Цена] * 2' },
    ]);
    const [what, price, twice] = readTable(doc).columns;
    const row = addRow(doc, { [what!.id]: 'Плитка', [price!.id]: 10 });
    expect(setCellImages(doc, row, what!.id, [{ asset: A, w: 400, h: 200, alt: 'Белая' }])).toBe(
      true,
    );
    expect(addCellImages(doc, row, twice!.id, [{ asset: B, w: 100, h: 100 }])).toBe(true);
    addCellImages(doc, row, what!.id, [{ asset: B, w: 300, h: 300 }]);
    // Мусор не проходит.
    addCellImages(doc, row, what!.id, [{ asset: 'не хэш', w: 1, h: 1 } as never]);
    const t = computeTable(readTable(doc));
    expect(t.rows[0]!.images).toEqual({
      [what!.id]: [
        { asset: A, w: 400, h: 200, alt: 'Белая' },
        { asset: B, w: 300, h: 300 },
      ],
      [twice!.id]: [{ asset: B, w: 100, h: 100 }],
    });
    expect(t.rows[0]!.cells[twice!.id]).toBe(20);
    expect(tableToMarkdown(doc)).toContain('| Плитка [картинок: 2] | 10 | 20 [картинок: 1] |');
    // Удалить картинки — пустым списком; удалить колонку — вместе с её картинками.
    setCellImages(doc, row, twice!.id, []);
    expect(readTable(doc).rows[0]!.images).toEqual({ [what!.id]: expect.any(Array) });
    removeColumn(doc, what!.id);
    expect(readTable(doc).rows[0]!.images).toBeUndefined();
    expect(setCellImages(doc, 'нет', price!.id, [])).toBe(false);
  });

  it('высота строки — в пределах; картинка — высота минус отступы', () => {
    const doc = new Y.Doc();
    initTable(doc);
    const row = addRow(doc);
    expect(readTable(doc).rows[0]!.height).toBeUndefined();
    setRowHeight(doc, row, 10);
    expect(readTable(doc).rows[0]!.height).toBe(ROW_MIN_HEIGHT);
    setRowHeight(doc, row, 5000);
    expect(readTable(doc).rows[0]!.height).toBe(800);
    setRowHeight(doc, row, 120.4);
    expect(readTable(doc).rows[0]!.height).toBe(120);
    expect(cellImageHeight(120)).toBe(108);
    expect(cellImageHeight(undefined)).toBe(28);
    setRowHeight(doc, row, null);
    expect(readTable(doc).rows[0]!.height).toBeUndefined();
  });
});

describe('ширина колонок и подгонка (решение 0025)', () => {
  it('ширина в пределах, переживает перестановку; подгонка — одним шагом отмены', () => {
    const doc = new Y.Doc();
    initTable(doc);
    const [a, b] = readTable(doc).columns;
    const row = addRow(doc);
    setColumnWidth(doc, a!.id, 20);
    expect(readTable(doc).columns[0]!.width).toBe(COL_MIN_WIDTH);
    setColumnWidth(doc, a!.id, 333.6);
    moveColumn(doc, a!.id, 1);
    expect(readTable(doc).columns.map((c) => c.width)).toEqual([undefined, 334]);
    const undo = new Y.UndoManager(doc.getMap('table'), { trackedOrigins: new Set(['me']) });
    setRowHeight(doc, row, 300);
    fitTable(doc, { columns: { [a!.id]: null, [b!.id]: 150 }, rows: { [row]: 80 } }, 'me');
    expect(readTable(doc).columns.map((c) => c.width)).toEqual([150, undefined]);
    expect(readTable(doc).rows[0]!.height).toBe(80);
    undo.undo();
    expect(readTable(doc).columns.map((c) => c.width)).toEqual([undefined, 334]);
    expect(readTable(doc).rows[0]!.height).toBe(300);
  });
});

describe('подпись и размер картинки в ячейке (решение 0026)', () => {
  it('хранятся у картинки; видны агентам в markdown; размер — в пределах', () => {
    const doc = new Y.Doc();
    initTable(doc, [{ name: 'Добыча', type: 'text' }]);
    const [col] = readTable(doc).columns;
    const row = addRow(doc);
    const A = 'a'.repeat(64);
    setCellImages(doc, row, col!.id, [
      { asset: A, w: 100, h: 100, caption: '  80 монет / Обычный ', size: 48, alt: 'Монеты' },
      { asset: A, w: 100, h: 50, caption: '', size: 5000 },
      { asset: A, w: 100, h: 50, size: Number.NaN },
    ]);
    const imgs = readTable(doc).rows[0]!.images![col!.id]!;
    expect(imgs).toEqual([
      { asset: A, w: 100, h: 100, alt: 'Монеты', caption: '80 монет / Обычный', size: 48 },
      { asset: A, w: 100, h: 50, size: 512 },
      { asset: A, w: 100, h: 50 },
    ]);
    expect(imageDisplayHeight(imgs[0]!, 200)).toBe(48);
    expect(imageDisplayHeight(imgs[2]!, 100)).toBe(88);
    expect(tableToMarkdown(doc)).toContain('| [🖼 80 монет / Обычный] [🖼] [🖼] |');
  });
});
