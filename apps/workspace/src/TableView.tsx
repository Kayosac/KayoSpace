import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import {
  COLUMN_TYPES,
  TABLE_FIELD,
  addColumn,
  addRow,
  cellText,
  columnTotal,
  compareCells,
  moveColumn,
  readTable,
  removeColumn,
  removeRows,
  updateColumn,
  updateRow,
  type Cell,
  type Column,
  type ColumnType,
  type TableData,
} from '@kayospace/page';
import type { BoardSession } from './session';
import { CommitInput } from './CommitInput';
import { CloseIcon } from './icons';

/** Свои правки таблицы — только их отменяет «Отменить» (правки агентов и других устройств — нет). */
export const TABLE_ORIGIN = 'kayospace:table';

const TYPE_ICON: Record<ColumnType, string> = {
  text: 'Аа',
  number: '#',
  checkbox: '☑',
  date: '📅',
  select: '▾',
  url: '↗',
};

/** Таблица из Yjs-документа: перечитывается при любой правке (своей, агента, другого устройства). */
function useTable(doc: Y.Doc): TableData {
  const [data, setData] = useState(() => readTable(doc));
  useEffect(() => {
    const on = (): void => setData(readTable(doc));
    on();
    doc.on('update', on);
    return () => doc.off('update', on);
  }, [doc]);
  return data;
}

function CellEditor({
  column,
  value,
  onChange,
  label,
}: {
  column: Column;
  value: Cell | undefined;
  onChange: (v: unknown) => void;
  label: string;
}) {
  switch (column.type) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          className="kt-check"
          checked={value === true}
          aria-label={label}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'select':
      return (
        <select
          className="kt-select"
          value={typeof value === 'string' ? value : ''}
          aria-label={label}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">—</option>
          {typeof value === 'string' && value && !column.options?.includes(value) && (
            <option value={value}>{value}</option>
          )}
          {column.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'date':
      return (
        <CommitInput
          type="date"
          className="kt-input"
          value={typeof value === 'string' ? value : ''}
          aria-label={label}
          onCommit={(v) => onChange(v || null)}
        />
      );
    case 'number':
      return (
        <CommitInput
          inputMode="decimal"
          className="kt-input num"
          value={typeof value === 'number' ? String(value).replace('.', ',') : ''}
          aria-label={label}
          onCommit={(v) => onChange(v || null)}
        />
      );
    case 'url':
      return (
        <span className="kt-url">
          <CommitInput
            type="url"
            inputMode="url"
            className="kt-input"
            value={typeof value === 'string' ? value : ''}
            aria-label={label}
            onCommit={(v) => onChange(v || null)}
          />
          {typeof value === 'string' && value && (
            <a href={value} target="_blank" rel="noreferrer" aria-label="Открыть ссылку">
              ↗
            </a>
          )}
        </span>
      );
    default:
      return (
        <CommitInput
          className="kt-input"
          value={typeof value === 'string' ? value : value == null ? '' : String(value)}
          aria-label={label}
          onCommit={(v) => onChange(v || null)}
        />
      );
  }
}

/** Настройки колонки: название, тип, варианты, сортировка, порядок, удаление — касаниями. */
function ColumnMenu({
  column,
  first,
  last,
  sort,
  onSort,
  doc,
  onClose,
}: {
  column: Column;
  first: boolean;
  last: boolean;
  sort: 'asc' | 'desc' | null;
  onSort: (dir: 'asc' | 'desc' | null) => void;
  doc: Y.Doc;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <div className="kt-menu" role="dialog" aria-label="Колонка" data-testid="column-menu">
      <div className="panel-head">
        <h2>Колонка</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <label className="field">
        <span>Название</span>
        <CommitInput
          value={column.name}
          onCommit={(v) => updateColumn(doc, column.id, { name: v }, TABLE_ORIGIN)}
          data-testid="column-name"
        />
      </label>
      <div className="field">
        <span>Тип</span>
        <div className="kt-types" role="radiogroup" aria-label="Тип колонки">
          {COLUMN_TYPES.map((t) => (
            <button
              key={t.type}
              role="radio"
              aria-checked={column.type === t.type}
              className="project-chip"
              onClick={() => updateColumn(doc, column.id, { type: t.type }, TABLE_ORIGIN)}
            >
              <b>{TYPE_ICON[t.type]}</b> {t.name}
            </button>
          ))}
        </div>
      </div>
      {column.type === 'select' && (
        <label className="field">
          <span>Варианты через запятую</span>
          <CommitInput
            value={(column.options ?? []).join(', ')}
            placeholder="Срочно, Потом, Готово"
            onCommit={(v) => updateColumn(doc, column.id, { options: v.split(',') }, TABLE_ORIGIN)}
            data-testid="column-options"
          />
        </label>
      )}
      <div className="field">
        <span>Сортировка (только на этом экране)</span>
        <div className="kt-types" role="radiogroup" aria-label="Сортировка">
          {(
            [
              [null, 'Как есть'],
              ['asc', 'По возрастанию'],
              ['desc', 'По убыванию'],
            ] as const
          ).map(([dir, name]) => (
            <button
              key={name}
              role="radio"
              aria-checked={sort === dir}
              className="project-chip"
              onClick={() => onSort(dir)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="row kt-menu-row">
        <button
          className="secondary"
          disabled={first}
          onClick={() => moveColumn(doc, column.id, -1, TABLE_ORIGIN)}
        >
          ← Левее
        </button>
        <button
          className="secondary"
          disabled={last}
          onClick={() => moveColumn(doc, column.id, 1, TABLE_ORIGIN)}
        >
          Правее →
        </button>
        <button
          className={confirm ? 'danger-btn confirm' : 'danger-btn'}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            removeColumn(doc, column.id, TABLE_ORIGIN);
            onClose();
          }}
          data-testid="column-delete"
        >
          {confirm ? 'Точно удалить?' : 'Удалить колонку'}
        </button>
      </div>
    </div>
  );
}

/**
 * Таблица (решение 0021, фаза 5.4): типизированные колонки — текст, число, флажок, дата, выбор,
 * ссылка. Всё касаниями: ячейка сохраняет сама при уходе фокуса, колонка настраивается в меню
 * по касанию заголовка, внизу — итоги (сумма чисел, сколько отмечено).
 */
export function TableView({
  session,
  name,
  onRename,
  onClose,
}: {
  session: BoardSession;
  name: string | null;
  onRename: (name: string) => void;
  /** Таблица открыта поверх доски — кнопка «К доске». */
  onClose?: () => void;
}) {
  const doc = session.doc;
  const data = useTable(doc);
  const [menu, setMenu] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [query, setQuery] = useState('');
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const undo = useMemo(
    () =>
      new Y.UndoManager(doc.getMap(TABLE_FIELD), {
        trackedOrigins: new Set([TABLE_ORIGIN]),
        captureTimeout: 400,
      }),
    [doc],
  );
  useEffect(() => () => undo.destroy(), [undo]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = (): void => setTick((t) => t + 1);
    undo.on('stack-item-added', on);
    undo.on('stack-item-popped', on);
    return () => {
      undo.off('stack-item-added', on);
      undo.off('stack-item-popped', on);
    };
  }, [undo]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q
      ? data.rows.filter((r) =>
          data.columns.some((c) => cellText(c, r.cells[c.id]).toLowerCase().includes(q)),
        )
      : data.rows;
    const col = sort && data.columns.find((c) => c.id === sort.col);
    if (col && sort) {
      list = [...list].sort(
        (a, b) =>
          compareCells(col, a.cells[col.id], b.cells[col.id]) * (sort.dir === 'asc' ? 1 : -1),
      );
    }
    return list;
  }, [data, query, sort]);

  const menuCol = data.columns.find((c) => c.id === menu) ?? null;
  const menuIndex = menuCol ? data.columns.indexOf(menuCol) : -1;

  return (
    <div className="page-view table-view" data-testid="table-view">
      <div className="page-toolbar" role="toolbar" aria-label="Таблица">
        {onClose && (
          <button className="page-tool wide" onClick={onClose} data-testid="doc-close">
            ← К доске
          </button>
        )}
        <button
          className="page-tool wide"
          onClick={() => addRow(doc, {}, TABLE_ORIGIN)}
          data-testid="table-add-row"
        >
          + Строка
        </button>
        <button
          className="page-tool wide"
          onClick={() => {
            const id = addColumn(
              doc,
              { name: `Колонка ${data.columns.length + 1}`, type: 'text' },
              TABLE_ORIGIN,
            );
            setMenu(id);
          }}
          data-testid="table-add-column"
        >
          + Колонка
        </button>
        <input
          className="kt-search"
          type="search"
          value={query}
          placeholder="Найти в таблице"
          aria-label="Найти в таблице"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="page-tool-gap" />
        <button
          className="page-tool"
          title="Отменить"
          aria-label="Отменить"
          disabled={undo.undoStack.length === 0}
          onClick={() => undo.undo()}
        >
          ↶
        </button>
        <button
          className="page-tool"
          title="Повторить"
          aria-label="Повторить"
          disabled={undo.redoStack.length === 0}
          onClick={() => undo.redo()}
        >
          ↷
        </button>
      </div>
      <div className="page-scroll">
        <article className="page-sheet table-sheet">
          <CommitInput
            className="page-title"
            value={name ?? ''}
            placeholder="Без названия"
            aria-label="Название таблицы"
            onCommit={(v) => v.trim() && onRename(v)}
            data-testid="page-title"
          />
          <div className="kt-wrap">
            <table className="kt" data-testid="table">
              <thead>
                <tr>
                  <th className="kt-num" aria-label="Строка" />
                  {data.columns.map((c) => (
                    <th key={c.id}>
                      <button
                        className={menu === c.id ? 'kt-head open' : 'kt-head'}
                        onClick={() => setMenu((m) => (m === c.id ? null : c.id))}
                        data-testid="column-head"
                      >
                        <span className="kt-type">{TYPE_ICON[c.type]}</span>
                        <span className="kt-name">{c.name}</span>
                        {sort?.col === c.id && <span>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const n = data.rows.indexOf(r) + 1;
                  return (
                    <tr
                      key={r.id}
                      data-testid="table-row"
                      className={rowMenu === r.id ? 'picked' : undefined}
                    >
                      <td className="kt-num">
                        <button
                          aria-label={`Строка ${n}`}
                          onClick={() => setRowMenu((m) => (m === r.id ? null : r.id))}
                        >
                          {n}
                        </button>
                        {rowMenu === r.id && (
                          <button
                            className="kt-row-delete"
                            onClick={() => {
                              removeRows(doc, [r.id], TABLE_ORIGIN);
                              setRowMenu(null);
                            }}
                            data-testid="row-delete"
                          >
                            Удалить
                          </button>
                        )}
                      </td>
                      {data.columns.map((c) => (
                        <td
                          key={c.id}
                          className={`kt-cell kt-${c.type}`}
                          data-testid="cell"
                          data-col={c.name}
                        >
                          <CellEditor
                            column={c}
                            value={r.cells[c.id]}
                            label={`${c.name}, строка ${n}`}
                            onChange={(v) => updateRow(doc, r.id, { [c.id]: v }, TABLE_ORIGIN)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td className="kt-empty" colSpan={data.columns.length + 1}>
                      {query.trim() ? 'Ничего не нашлось.' : 'Строк пока нет — «+ Строка» сверху.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="kt-num" />
                    {data.columns.map((c) => (
                      <td key={c.id} className={`kt-total kt-${c.type}`} data-testid="column-total">
                        {columnTotal(c, rows)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </article>
      </div>
      {menuCol && (
        <ColumnMenu
          key={menuCol.id}
          column={menuCol}
          first={menuIndex === 0}
          last={menuIndex === data.columns.length - 1}
          sort={sort?.col === menuCol.id ? sort.dir : null}
          onSort={(dir) => setSort(dir ? { col: menuCol.id, dir } : null)}
          doc={doc}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
