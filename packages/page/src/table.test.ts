import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addColumn,
  addRow,
  coerceCell,
  columnTotal,
  compareCells,
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
