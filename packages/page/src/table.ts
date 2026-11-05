/**
 * Таблицы (решение 0021, фаза 5.4): типизированные колонки и строки в Yjs-документе с id «tb_…».
 * Как и документ, таблица — тот же Yjs-документ, что у доски: синхронизация, хранение, проекты,
 * удаление и история — общие. Данные — Y.Map «table»: columns — Y.Array<Y.Map>, rows — Y.Array<Y.Map>.
 * Ячейка строки хранится под id колонки; значение приводится к типу колонки (`coerceCell`).
 */

import * as Y from 'yjs';

export const TABLE_FIELD = 'table';
export const TABLE_PREFIX = 'tb_';

export const isTableId = (id: string): boolean => id.startsWith(TABLE_PREFIX);

export function tableIdFrom(boardLikeId: string): string {
  return `${TABLE_PREFIX}${boardLikeId}`.slice(0, 64);
}

export type ColumnType = 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'url';

export const COLUMN_TYPES: readonly { type: ColumnType; name: string }[] = [
  { type: 'text', name: 'Текст' },
  { type: 'number', name: 'Число' },
  { type: 'checkbox', name: 'Флажок' },
  { type: 'date', name: 'Дата' },
  { type: 'select', name: 'Выбор' },
  { type: 'url', name: 'Ссылка' },
];

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** Варианты для «Выбора». */
  options?: string[];
}

export type Cell = string | number | boolean | null;

export interface Row {
  id: string;
  cells: Record<string, Cell>;
}

export interface TableData {
  columns: Column[];
  rows: Row[];
}

function shortId(): string {
  const a = '0123456789abcdefghjkmnpqrstvwxyz';
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += a[x % 32];
  return s;
}

function root(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(TABLE_FIELD);
}

function arr(doc: Y.Doc, key: 'columns' | 'rows'): Y.Array<Y.Map<unknown>> {
  const r = root(doc);
  let a = r.get(key) as Y.Array<Y.Map<unknown>> | undefined;
  if (!a) {
    a = new Y.Array<Y.Map<unknown>>();
    r.set(key, a);
  }
  return a;
}

/** Есть ли в документе таблица (хотя бы одна колонка). */
export function hasTable(doc: Y.Doc): boolean {
  const c = root(doc).get('columns') as Y.Array<unknown> | undefined;
  return !!c && c.length > 0;
}

/** Значение ячейки — к типу колонки. Пустое и непонятное — null. */
export function coerceCell(type: ColumnType, v: unknown, options?: readonly string[]): Cell {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'number': {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const s = String(v).replace(/\s/g, '').replace(',', '.');
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      if (typeof v === 'boolean') return v;
      return /^(1|true|да|yes|x|✓|✔)$/i.test(String(v).trim());
    case 'date': {
      const s = String(v).trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? null;
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      if (ru) return `${ru[3]}-${ru[2]!.padStart(2, '0')}-${ru[1]!.padStart(2, '0')}`;
      return null;
    }
    case 'select': {
      const s = String(v).trim();
      if (!s) return null;
      return options?.find((o) => o.toLowerCase() === s.toLowerCase()) ?? s;
    }
    case 'url': {
      const s = String(v).trim();
      if (!s) return null;
      return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    }
    default: {
      const s = typeof v === 'string' ? v : String(v);
      return s === '' ? null : s;
    }
  }
}

function readColumn(m: Y.Map<unknown>): Column {
  const options = m.get('options') as string[] | undefined;
  return {
    id: String(m.get('id')),
    name: String(m.get('name') ?? ''),
    type: (m.get('type') as ColumnType) ?? 'text',
    ...(options?.length ? { options } : {}),
  };
}

/** Массив таблицы без записи в документ (чтение не должно создавать данные). */
function peek(doc: Y.Doc, key: 'columns' | 'rows'): Y.Map<unknown>[] {
  const a = root(doc).get(key) as Y.Array<Y.Map<unknown>> | undefined;
  return a ? a.toArray() : [];
}

export function readTable(doc: Y.Doc): TableData {
  const columns = peek(doc, 'columns').map(readColumn);
  const rows = peek(doc, 'rows').map((m) => {
    const cells: Record<string, Cell> = {};
    for (const c of columns) {
      const v = m.get(c.id);
      if (v !== undefined && v !== null) cells[c.id] = v as Cell;
    }
    return { id: String(m.get('id')), cells };
  });
  return { columns, rows };
}

/** Новая таблица: колонки по умолчанию — «Название» (текст) и «Готово» (флажок). */
export function initTable(
  doc: Y.Doc,
  columns: readonly Omit<Column, 'id'>[] = [
    { name: 'Название', type: 'text' },
    { name: 'Готово', type: 'checkbox' },
  ],
  origin?: unknown,
): void {
  if (hasTable(doc)) return;
  doc.transact(() => {
    for (const c of columns) addColumn(doc, c);
  }, origin);
}

export function addColumn(doc: Y.Doc, c: Omit<Column, 'id'>, origin?: unknown): string {
  const id = shortId();
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('name', c.name.trim() || 'Колонка');
    m.set('type', c.type);
    if (c.options?.length) m.set('options', [...c.options]);
    arr(doc, 'columns').push([m]);
  }, origin);
  return id;
}

function columnMap(doc: Y.Doc, id: string): { m: Y.Map<unknown>; i: number } | null {
  const cols = arr(doc, 'columns');
  for (let i = 0; i < cols.length; i++) {
    const m = cols.get(i);
    if (m.get('id') === id) return { m, i };
  }
  return null;
}

/** Переименовать, сменить тип или варианты; смена типа приводит значения колонки к новому типу. */
export function updateColumn(
  doc: Y.Doc,
  id: string,
  patch: Partial<Omit<Column, 'id'>>,
  origin?: unknown,
): void {
  const found = columnMap(doc, id);
  if (!found) return;
  doc.transact(() => {
    const { m } = found;
    if (patch.name !== undefined) m.set('name', patch.name.trim() || 'Колонка');
    if (patch.options !== undefined) {
      const opts = [...new Set(patch.options.map((o) => o.trim()).filter(Boolean))];
      if (opts.length) m.set('options', opts);
      else m.delete('options');
    }
    if (patch.type !== undefined && patch.type !== m.get('type')) {
      m.set('type', patch.type);
      const options = m.get('options') as string[] | undefined;
      for (const r of arr(doc, 'rows').toArray()) {
        const v = r.get(id);
        if (v === undefined || v === null) continue;
        const next = coerceCell(patch.type, typeof v === 'boolean' ? (v ? 'да' : '') : v, options);
        if (next === null) r.delete(id);
        else r.set(id, next);
      }
      // У «Выбора» сразу появляются варианты — из уже введённых значений.
      if (patch.type === 'select' && !options?.length) {
        const seen = new Set<string>();
        for (const r of arr(doc, 'rows').toArray()) {
          const v = r.get(id);
          if (typeof v === 'string' && v) seen.add(v);
        }
        if (seen.size) m.set('options', [...seen].slice(0, 30));
      }
    }
  }, origin);
}

export function removeColumn(doc: Y.Doc, id: string, origin?: unknown): void {
  const found = columnMap(doc, id);
  if (!found) return;
  doc.transact(() => {
    arr(doc, 'columns').delete(found.i, 1);
    for (const r of arr(doc, 'rows').toArray()) r.delete(id);
  }, origin);
}

/** Сдвинуть колонку на delta позиций (−1 — влево, 1 — вправо). */
export function moveColumn(doc: Y.Doc, id: string, delta: number, origin?: unknown): void {
  const found = columnMap(doc, id);
  if (!found) return;
  const cols = arr(doc, 'columns');
  const to = Math.max(0, Math.min(cols.length - 1, found.i + delta));
  if (to === found.i) return;
  const c = readColumn(found.m);
  doc.transact(() => {
    cols.delete(found.i, 1);
    const m = new Y.Map<unknown>();
    m.set('id', c.id);
    m.set('name', c.name);
    m.set('type', c.type);
    if (c.options) m.set('options', c.options);
    cols.insert(to, [m]);
  }, origin);
}

/** Строка: значения по id колонки; лишнее отбрасывается, значения — к типу колонки. */
export function addRow(doc: Y.Doc, values: Record<string, unknown> = {}, origin?: unknown): string {
  const id = shortId();
  const cols = readTable(doc).columns;
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    for (const c of cols) {
      const v = coerceCell(c.type, values[c.id], c.options);
      if (v !== null) m.set(c.id, v);
    }
    arr(doc, 'rows').push([m]);
  }, origin);
  return id;
}

function rowMap(doc: Y.Doc, id: string): { m: Y.Map<unknown>; i: number } | null {
  const rows = arr(doc, 'rows');
  for (let i = 0; i < rows.length; i++) {
    const m = rows.get(i);
    if (m.get('id') === id) return { m, i };
  }
  return null;
}

export function updateRow(
  doc: Y.Doc,
  id: string,
  values: Record<string, unknown>,
  origin?: unknown,
): boolean {
  const found = rowMap(doc, id);
  if (!found) return false;
  const cols = new Map(readTable(doc).columns.map((c) => [c.id, c]));
  doc.transact(() => {
    for (const [k, v] of Object.entries(values)) {
      const c = cols.get(k);
      if (!c) continue;
      const cell = coerceCell(c.type, v, c.options);
      if (cell === null) found.m.delete(k);
      else found.m.set(k, cell);
    }
  }, origin);
  return true;
}

export function removeRows(doc: Y.Doc, ids: readonly string[], origin?: unknown): number {
  const set = new Set(ids);
  let n = 0;
  doc.transact(() => {
    const rows = arr(doc, 'rows');
    for (let i = rows.length - 1; i >= 0; i--) {
      if (set.has(String(rows.get(i).get('id')))) {
        rows.delete(i, 1);
        n++;
      }
    }
  }, origin);
  return n;
}

/** Значение ячейки текстом — для markdown, поиска и карточки. */
export function cellText(c: Column, v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (c.type === 'checkbox') return v ? '✓' : '';
  if (c.type === 'date' && typeof v === 'string') {
    const [y, m, d] = v.split('-');
    return d && m && y ? `${d}.${m}.${y}` : v;
  }
  if (c.type === 'number' && typeof v === 'number')
    return v.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
  return String(v);
}

/** Сравнение для сортировки по колонке: пустые — в конце. */
export function compareCells(c: Column, a: Cell | undefined, b: Cell | undefined): number {
  const ea = a === null || a === undefined || a === '';
  const eb = b === null || b === undefined || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (c.type === 'number') return Number(a) - Number(b);
  if (c.type === 'checkbox') return Number(b) - Number(a);
  return String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });
}

/** Итог колонки: сумма чисел, число отмеченных флажков, иначе — сколько заполнено. */
export function columnTotal(c: Column, rows: readonly Row[]): string {
  const vals = rows.map((r) => r.cells[c.id]).filter((v) => v !== undefined && v !== null);
  if (c.type === 'number') {
    const sum = vals.reduce<number>((s, v) => s + Number(v), 0);
    return vals.length ? `Σ ${sum.toLocaleString('ru-RU', { maximumFractionDigits: 6 })}` : '';
  }
  if (c.type === 'checkbox') return `${vals.filter(Boolean).length} из ${rows.length}`;
  return vals.length ? `${vals.length} заполн.` : '';
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Таблица в markdown (для агентов): шапка с типами колонок, строки по порядку. */
export function tableToMarkdown(doc: Y.Doc): string {
  const { columns, rows } = readTable(doc);
  if (!columns.length) return '(пустая таблица)';
  const typeName = (t: ColumnType) => COLUMN_TYPES.find((x) => x.type === t)?.name ?? t;
  const head = `| ${columns.map((c) => esc(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    (r) => `| ${columns.map((c) => esc(cellText(c, r.cells[c.id]))).join(' | ')} |`,
  );
  const types = columns
    .map(
      (c) =>
        `${c.name} — ${typeName(c.type)}${c.options?.length ? ` (${c.options.join(', ')})` : ''}`,
    )
    .join('; ');
  return [`Колонки: ${types}. Строк: ${rows.length}.`, '', head, sep, ...body].join('\n');
}

/** Текст таблицы — по строке на строку таблицы (для поиска). */
export function tableLines(doc: Y.Doc): string[] {
  const { columns, rows } = readTable(doc);
  return rows
    .map((r) =>
      columns
        .map((c) => cellText(c, r.cells[c.id]))
        .filter(Boolean)
        .join(' · '),
    )
    .filter(Boolean);
}

/** Колонка по id или по названию (без учёта регистра) — так к ним обращаются агенты. */
export function findColumn(columns: readonly Column[], ref: string): Column | undefined {
  const low = ref.trim().toLowerCase();
  return columns.find((c) => c.id === ref) ?? columns.find((c) => c.name.toLowerCase() === low);
}
