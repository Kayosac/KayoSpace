import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FormulaError, evaluate, formulaRefs, parseFormula, type Value } from './formula';
import {
  addColumn,
  addRow,
  columnTotal,
  computeTable,
  initTable,
  readTable,
  tableToMarkdown,
  updateColumn,
} from './table';

const scope = (row: Record<string, Value>, cols: Record<string, Value[]> = {}) => ({
  cell: (n: string) => {
    if (!(n in row)) throw new FormulaError(`нет колонки «${n}»`);
    return row[n]!;
  },
  column: (n: string) => cols[n] ?? [],
  today: '2026-11-05',
});
const calc = (src: string, row: Record<string, Value> = {}, cols: Record<string, Value[]> = {}) =>
  evaluate(parseFormula(src), scope(row, cols));

describe('формулы (решение 0023)', () => {
  it('арифметика, приоритеты, степень, знак', () => {
    expect(calc('1 + 2 * 3')).toBe(7);
    expect(calc('(1 + 2) * 3')).toBe(9);
    expect(calc('2 ^ 3 ^ 2')).toBe(512);
    expect(calc('-[a] + 1', { a: 5 })).toBe(-4);
    expect(calc('=[Цена] × [Кол-во]', { Цена: 1200, 'Кол-во': 3 })).toBe(3600);
    expect(calc('Цена * 2', { Цена: '1 200' })).toBe(2400);
  });

  it('функции по-английски и по-русски, условия, строки, даты', () => {
    expect(calc('ROUND(10 / 3; 2)')).toBe(3.33);
    expect(calc('ОКРУГЛ(10/3, 1)')).toBe(3.3);
    expect(calc('IF([Готово]; "да"; "нет")', { Готово: true })).toBe('да');
    expect(calc('ЕСЛИ([Цена] > 1000; "дорого"; "ок")', { Цена: 500 })).toBe('ок');
    expect(calc('[Имя] & " — " & [Город]', { Имя: 'Аня', Город: 'Алматы' })).toBe('Аня — Алматы');
    expect(calc('DAYS([Срок]; TODAY())', { Срок: '2026-11-15' })).toBe(10);
    expect(calc('AND(TRUE; [x] = "A")', { x: 'a' })).toBe(true);
    expect(calc('ISBLANK([x])', { x: null })).toBe(true);
    expect(calc('SUM([Цена])', {}, { Цена: [100, 200, null] })).toBe(300);
    expect(calc('СРЗНАЧ([Цена])', {}, { Цена: [100, 200] })).toBe(150);
    expect(calc('COUNT([Готово])', {}, { Готово: [true, false, true] })).toBe(2);
  });

  it('ошибки — понятные', () => {
    expect(() => calc('1 / 0')).toThrow('деление на ноль');
    expect(() => parseFormula('(1 + 2')).toThrow('скобка');
    expect(() => calc('НЕТТАКОЙ(1)')).toThrow('нет функции');
    expect(() => calc('[a] * 2', { a: 'текст' })).toThrow('не число');
    expect(formulaRefs('[Цена] * Кол + SUM([Итог])').sort()).toEqual(['Итог', 'Кол', 'Цена']);
  });

  it('в таблице: зависимые формулы, итог, цикл, markdown', () => {
    const doc = new Y.Doc();
    initTable(doc, [
      { name: 'Что', type: 'text' },
      { name: 'Цена', type: 'number' },
      { name: 'Кол', type: 'number' },
    ]);
    const [what, price, qty] = readTable(doc).columns;
    const sum = addColumn(doc, { name: 'Сумма', type: 'formula', formula: '[Цена] * [Кол]' });
    const share = addColumn(doc, {
      name: 'Доля',
      type: 'formula',
      formula: 'ROUND([Сумма] / SUM([Сумма]) * 100; 1)',
    });
    addRow(doc, { [what!.id]: 'Плитка', [price!.id]: 1200, [qty!.id]: 3 });
    addRow(doc, { [what!.id]: 'Клей', [price!.id]: 350, [qty!.id]: 4 });
    const t = computeTable(readTable(doc));
    expect(t.rows.map((r) => r.cells[sum])).toEqual([3600, 1400]);
    expect(t.rows.map((r) => r.cells[share])).toEqual([72, 28]);
    const sumCol = t.columns.find((c) => c.id === sum)!;
    expect(columnTotal(sumCol, t.rows).replace(/\s/g, ' ')).toBe('Σ 5 000');
    expect(tableToMarkdown(doc)).toContain('Сумма — Формула = [Цена] * [Кол]');
    // Цикл: Сумма ссылается на Долю, а Доля — на Сумму.
    updateColumn(doc, sum, { formula: '[Доля] * 2' });
    const bad = computeTable(readTable(doc));
    expect(Object.values(bad.errors).some((e) => e.includes('по кругу'))).toBe(true);
    // Смена типа на формулу стирает хранимые значения колонки.
    updateColumn(doc, qty!.id, { type: 'formula', formula: '1' });
    expect(readTable(doc).rows[0]!.cells[qty!.id]).toBeUndefined();
  });
});
