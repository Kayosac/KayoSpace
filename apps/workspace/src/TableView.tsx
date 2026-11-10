import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  computeTable,
  addCellImages,
  clampRowHeight,
  setCellImages,
  setColumnWidth,
  setRowHeight,
  clampColWidth,
  fitTable,
  type Cell,
  type Column,
  type ColumnType,
  type TableData,
} from '@kayospace/page';
import type { BoardSession } from './session';
import { CommitInput } from './CommitInput';
import { openInClaude } from './claude';
import { CloseIcon } from './icons';
import { CellImageViewer, CellImages, storeCellImages, useImagePicker } from './TableImages';
import { imageFiles } from './assets';
import { notify } from './notify';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  canvasMeasure,
  clampZoom,
  columnWidth,
  fitColumnWidth,
  fitSizes,
  zoomStep,
} from './table-fit';

/** Свои правки таблицы — только их отменяет «Отменить» (правки агентов и других устройств — нет). */
export const TABLE_ORIGIN = 'kayospace:table';

const TYPE_ICON: Record<ColumnType, string> = {
  text: 'Аа',
  number: '#',
  checkbox: '☑',
  date: '📅',
  select: '▾',
  url: '↗',
  formula: 'ƒ',
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

/** Значение формулы: только показать; ошибка — «#ОШИБКА» с причиной по касанию. */
function FormulaCell({
  column,
  value,
  error,
}: {
  column: Column;
  value: Cell | undefined;
  error: string | undefined;
}) {
  const [show, setShow] = useState(false);
  if (error)
    return (
      <button className="kt-formula err" title={error} onClick={() => setShow((v) => !v)}>
        {show ? error : '#ОШИБКА'}
      </button>
    );
  return (
    <span className={typeof value === 'number' ? 'kt-formula num' : 'kt-formula'}>
      {cellText(column, value)}
    </span>
  );
}

/** Настройки колонки: название, тип, варианты, сортировка, порядок, удаление — касаниями. */
function ColumnMenu({
  column,
  first,
  last,
  sort,
  onSort,
  doc,
  columns,
  formulaError,
  onFitWidth,
  onClose,
}: {
  column: Column;
  /** Ширина колонки под содержимое. */
  onFitWidth: () => void;
  /** Все колонки — для вставки ссылок в формулу. */
  columns: readonly Column[];
  /** Первая ошибка формулы этой колонки (если есть). */
  formulaError: string | null;
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
      {column.type === 'formula' && (
        <div className="field" data-testid="column-formula-field">
          <span>Формула</span>
          <CommitInput
            value={column.formula ?? ''}
            placeholder="[Цена] * [Количество]"
            spellCheck={false}
            autoCapitalize="off"
            onCommit={(v) => updateColumn(doc, column.id, { formula: v }, TABLE_ORIGIN)}
            data-testid="column-formula"
          />
          <div className="kt-types" aria-label="Вставить колонку">
            {columns
              .filter((c) => c.id !== column.id)
              .map((c) => (
                <button
                  key={c.id}
                  className="project-chip"
                  onClick={() =>
                    updateColumn(
                      doc,
                      column.id,
                      { formula: `${(column.formula ?? '').trim()} [${c.name}]`.trim() },
                      TABLE_ORIGIN,
                    )
                  }
                >
                  [{c.name}]
                </button>
              ))}
          </div>
          <small className="muted">
            + − × / ^ и скобки; ЕСЛИ(условие; да; нет), ОКРУГЛ(x; 2), СУММ([Колонка]), СРЗНАЧ, МИН,
            МАКС, СЧЁТ, ДНИ(дата; СЕГОДНЯ()), «текст» & [Колонка].
          </small>
          {formulaError && <small className="bad">{formulaError}</small>}
        </div>
      )}
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
        <button className="secondary" onClick={onFitWidth} data-testid="column-fit">
          Ширина по содержимому
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
  const raw = useTable(doc);
  // Формулы (решение 0023) считаются при каждом изменении таблицы.
  const data = useMemo(() => computeTable(raw), [raw]);
  const order = useMemo(() => new Map(raw.rows.map((r, i) => [r.id, i + 1])), [raw]);
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

  // Картинки в ячейках и высота строк (решение 0024).
  const [active, setActive] = useState<{ row: string; col: string } | null>(null);
  const [viewer, setViewer] = useState<{ row: string; col: string; index: number } | null>(null);
  const [resize, setResize] = useState<{ row: string; h: number } | null>(null);
  const target = useRef<{ row: string; col: string } | null>(null);
  const addImages = async (row: string, col: string, files: File[]): Promise<void> => {
    try {
      const imgs = await storeCellImages(files);
      addCellImages(doc, row, col, imgs, TABLE_ORIGIN);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не получилось добавить картинку');
    }
  };
  const picker = useImagePicker((files) => {
    const t = target.current;
    if (t) void addImages(t.row, t.col, files);
  });
  /** Тянуть номер строки (или полоску под ним) вверх-вниз — высота строки; касание — меню строки. */
  const drag = useRef<{ row: string; y: number; h: number; moved: boolean } | null>(null);
  const skipClick = useRef(false);
  const startResize = (e: React.PointerEvent<HTMLElement>, row: string): void => {
    if (e.button !== 0) return;
    // После прошлого перетаскивания щелчка могло и не быть — не глотаем следующее касание.
    skipClick.current = false;
    const tr = e.currentTarget.closest('tr');
    if (!tr) return;
    drag.current = { row, y: e.clientY, h: tr.getBoundingClientRect().height, moved: false };
    const move = (ev: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dy = ev.clientY - d.y;
      if (!d.moved && Math.abs(dy) < 6) return;
      d.moved = true;
      setResize({ row: d.row, h: clampRowHeight(d.h + dy) });
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const d = drag.current;
      drag.current = null;
      setResize(null);
      if (d?.moved && ev.type === 'pointerup') {
        skipClick.current = true;
        setRowHeight(doc, d.row, clampRowHeight(d.h + ev.clientY - d.y), TABLE_ORIGIN);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const viewerImages = viewer && data.rows.find((r) => r.id === viewer.row)?.images?.[viewer.col];

  // На весь экран, листается в обе стороны, масштаб — как в Google Таблицах (решение 0025).
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomKey = `kayospace.table-zoom.${session.board}`;
  const [zoom, setZoomState] = useState(() => {
    try {
      const z = Number(localStorage.getItem(zoomKey));
      return z ? clampZoom(z) : 1;
    } catch {
      return 1;
    }
  });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Точка таблицы под (x, y) окна остаётся на месте после смены масштаба. */
  const anchor = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const setZoom = (next: number, at?: { x: number; y: number }): void => {
    const z = clampZoom(next);
    const wrap = wrapRef.current;
    if (wrap && z !== zoomRef.current) {
      const x = at?.x ?? wrap.clientWidth / 2;
      const y = at?.y ?? wrap.clientHeight / 2;
      anchor.current = {
        px: (wrap.scrollLeft + x) / zoomRef.current,
        py: (wrap.scrollTop + y) / zoomRef.current,
        x,
        y,
      };
    }
    zoomRef.current = z;
    setZoomState(z);
    try {
      localStorage.setItem(zoomKey, String(z));
    } catch {
      // Только удобство: без хранилища масштаб просто не запомнится.
    }
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const wrap = wrapRef.current;
    if (!a || !wrap) return;
    anchor.current = null;
    wrap.scrollLeft = a.px * zoom - a.x;
    wrap.scrollTop = a.py * zoom - a.y;
  }, [zoom]);
  // Ctrl/⌘ + колёсико (и щипок на тачпаде) — масштаб; два пальца на экране — тоже.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const local = (cx: number, cy: number) => {
      const r = wrap.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0025), local(e.clientX, e.clientY));
    };
    let pinch: { d: number; z: number } | null = null;
    const dist = (t: TouchList) =>
      Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const mid = (t: TouchList) =>
      local((t[0]!.clientX + t[1]!.clientX) / 2, (t[0]!.clientY + t[1]!.clientY) / 2);
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), z: zoomRef.current };
    };
    const onMove = (e: TouchEvent): void => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      setZoom((pinch.z * dist(e.touches)) / pinch.d, mid(e.touches));
    };
    const onEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2) pinch = null;
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('touchstart', onStart, { passive: true });
    wrap.addEventListener('touchmove', onMove, { passive: false });
    wrap.addEventListener('touchend', onEnd);
    wrap.addEventListener('touchcancel', onEnd);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('touchstart', onStart);
      wrap.removeEventListener('touchmove', onMove);
      wrap.removeEventListener('touchend', onEnd);
      wrap.removeEventListener('touchcancel', onEnd);
    };
    // setZoom читает всё из ref — подписываемся один раз на таблицу.
  }, [session.board]);

  // Ширина колонки: тянуть правый край заголовка; двойной щелчок по краю — по содержимому.
  const [colDrag, setColDrag] = useState<{ col: string; w: number } | null>(null);
  const startColResize = (e: React.PointerEvent<HTMLElement>, c: Column): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = columnWidth(c);
    let moved = false;
    const width = (ev: PointerEvent) => clampColWidth(w0 + (ev.clientX - x0) / zoomRef.current);
    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      setColDrag({ col: c.id, w: width(ev) });
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setColDrag(null);
      if (moved && ev.type === 'pointerup') setColumnWidth(doc, c.id, width(ev), TABLE_ORIGIN);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const fitColumn = (c: Column): void => {
    setColumnWidth(doc, c.id, fitColumnWidth(c, data.rows, canvasMeasure()), TABLE_ORIGIN);
  };
  const fitAll = (): void => {
    fitTable(doc, fitSizes(data.columns, data.rows, canvasMeasure()), TABLE_ORIGIN);
    notify('Размеры подогнаны под содержимое', 2000);
  };

  /** Enter и ↑↓ в ячейке — к соседней по колонке (как в таблицах); Tab — как обычно. */
  const moveFocus = (e: React.KeyboardEvent<HTMLTableCellElement>): void => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'INPUT' || (t as HTMLInputElement).type === 'date') return;
    const dir =
      e.key === 'Enter'
        ? e.shiftKey
          ? -1
          : 1
        : e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowUp'
            ? -1
            : 0;
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    const td = e.currentTarget;
    const r = Number(td.dataset.r) + dir;
    const next = wrapRef.current?.querySelector<HTMLElement>(
      `td[data-r="${r}"][data-c="${td.dataset.c}"] input, td[data-r="${r}"][data-c="${td.dataset.c}"] select`,
    );
    if (!next) return;
    e.preventDefault();
    next.focus();
    if (next instanceof HTMLInputElement && next.type !== 'checkbox') next.select();
  };
  const tableWidth =
    44 + data.columns.reduce((s, c) => s + (colDrag?.col === c.id ? colDrag.w : columnWidth(c)), 0);

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
        <button
          className="page-tool wide"
          title="Ширины колонок и высоты строк — под содержимое"
          onClick={fitAll}
          data-testid="table-fit"
        >
          ⤢ Подогнать
        </button>
        <span className="kt-zoom" role="group" aria-label="Масштаб">
          <button
            className="page-tool"
            aria-label="Мельче"
            title="Мельче (Ctrl/⌘ + колёсико, щипок)"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => setZoom(zoomStep(zoom, -1))}
            data-testid="table-zoom-out"
          >
            −
          </button>
          <button
            className="page-tool kt-zoom-value"
            title="Масштаб 100%"
            onClick={() => setZoom(1)}
            data-testid="table-zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="page-tool"
            aria-label="Крупнее"
            title="Крупнее (Ctrl/⌘ + колёсико, щипок)"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => setZoom(zoomStep(zoom, 1))}
            data-testid="table-zoom-in"
          >
            +
          </button>
        </span>
        <span className="page-tool-gap" />
        <button
          className="page-tool wide"
          onClick={() => void openInClaude(session.board, name)}
          data-testid="to-claude"
        >
          В Claude
        </button>
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
      <div className="kt-titlebar">
        <CommitInput
          className="page-title"
          value={name ?? ''}
          placeholder="Без названия"
          aria-label="Название таблицы"
          onCommit={(v) => v.trim() && onRename(v)}
          data-testid="page-title"
        />
      </div>
      <div className="kt-wrap" ref={wrapRef} data-testid="table-scroll">
        <table className="kt" data-testid="table" style={{ zoom, width: tableWidth }}>
          <colgroup>
            <col style={{ width: 44 }} />
            {data.columns.map((c) => (
              <col
                key={c.id}
                style={{ width: colDrag?.col === c.id ? colDrag.w : columnWidth(c) }}
              />
            ))}
          </colgroup>
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
                  <span
                    className="kt-col-grip"
                    aria-hidden
                    title="Тяните — ширина колонки; двойной щелчок — по содержимому"
                    onPointerDown={(e) => startColResize(e, c)}
                    onDoubleClick={() => fitColumn(c)}
                    data-testid="column-resize"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const n = order.get(r.id) ?? 0;
              const height = resize?.row === r.id ? resize.h : r.height;
              return (
                <tr
                  key={r.id}
                  data-testid="table-row"
                  className={rowMenu === r.id ? 'picked' : undefined}
                  style={height ? { height } : undefined}
                >
                  <td className="kt-num" onPointerDown={(e) => startResize(e, r.id)}>
                    <button
                      aria-label={`Строка ${n}`}
                      onClick={() => {
                        if (skipClick.current) {
                          skipClick.current = false;
                          return;
                        }
                        setRowMenu((m) => (m === r.id ? null : r.id));
                      }}
                      data-testid="row-number"
                    >
                      {n}
                    </button>
                    {rowMenu === r.id && r.height !== undefined && (
                      <button
                        className="kt-row-action"
                        onClick={() => setRowHeight(doc, r.id, null, TABLE_ORIGIN)}
                        data-testid="row-height-reset"
                      >
                        По тексту
                      </button>
                    )}
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
                    <span
                      className="kt-row-grip"
                      aria-hidden
                      title="Тяните — высота строки"
                      data-testid="row-resize"
                    />
                  </td>
                  {data.columns.map((c, ci) => {
                    const imgs = r.images?.[c.id];
                    const on = active?.row === r.id && active.col === c.id;
                    return (
                      <td
                        key={c.id}
                        className={`kt-cell kt-${c.type}${on ? ' active' : ''}`}
                        data-testid="cell"
                        data-col={c.name}
                        data-r={ri}
                        data-c={ci}
                        onKeyDown={moveFocus}
                        // После касания (а не до): иначе кнопка «+ 🖼» сдвинет флажок под пальцем.
                        onClick={() => setActive({ row: r.id, col: c.id })}
                        onFocus={() => setActive({ row: r.id, col: c.id })}
                        onPaste={(e) => {
                          const files = imageFiles(e.clipboardData.files);
                          if (!files.length) return;
                          e.preventDefault();
                          e.stopPropagation();
                          void addImages(r.id, c.id, files);
                        }}
                        onDragOver={(e) => {
                          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          const files = imageFiles(e.dataTransfer.files);
                          if (!files.length) return;
                          e.preventDefault();
                          e.stopPropagation();
                          void addImages(r.id, c.id, files);
                        }}
                      >
                        <div className="kt-cellbox">
                          {imgs && (
                            <CellImages
                              images={imgs}
                              rowHeight={height}
                              onOpen={(index) => setViewer({ row: r.id, col: c.id, index })}
                            />
                          )}
                          <div className="kt-cellval">
                            {c.type === 'formula' ? (
                              <FormulaCell
                                column={c}
                                value={r.cells[c.id]}
                                error={data.errors[`${r.id}|${c.id}`]}
                              />
                            ) : (
                              <CellEditor
                                column={c}
                                value={r.cells[c.id]}
                                label={`${c.name}, строка ${n}`}
                                onChange={(v) => updateRow(doc, r.id, { [c.id]: v }, TABLE_ORIGIN)}
                              />
                            )}
                          </div>
                          {on && (
                            <button
                              className="kt-img-add"
                              aria-label="Добавить картинку"
                              title="Добавить картинку"
                              onPointerDown={(e) => e.preventDefault()}
                              onClick={() => {
                                target.current = { row: r.id, col: c.id };
                                picker.pick();
                              }}
                              data-testid="cell-add-image"
                            >
                              + 🖼
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  })}
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
      {picker.input}
      {viewer && viewerImages && (
        <CellImageViewer
          images={viewerImages}
          index={Math.min(viewer.index, viewerImages.length - 1)}
          onIndex={(index) => setViewer({ ...viewer, index })}
          onRemove={(i) => {
            const next = viewerImages.filter((_, k) => k !== i);
            setCellImages(doc, viewer.row, viewer.col, next, TABLE_ORIGIN);
            if (!next.length) setViewer(null);
          }}
          onChange={(i, patch) => {
            const next = viewerImages.map((img, k) => {
              if (k !== i) return img;
              const out = { ...img };
              if (patch.caption !== undefined) out.caption = patch.caption;
              if (patch.size !== undefined) {
                if (patch.size === null) delete out.size;
                else out.size = patch.size;
              }
              return out;
            });
            setCellImages(doc, viewer.row, viewer.col, next, TABLE_ORIGIN);
          }}
          onClose={() => setViewer(null)}
        />
      )}
      {menuCol && (
        <ColumnMenu
          key={menuCol.id}
          column={menuCol}
          first={menuIndex === 0}
          last={menuIndex === data.columns.length - 1}
          sort={sort?.col === menuCol.id ? sort.dir : null}
          onSort={(dir) => setSort(dir ? { col: menuCol.id, dir } : null)}
          doc={doc}
          columns={data.columns}
          formulaError={
            Object.entries(data.errors).find(([k]) => k.endsWith(`|${menuCol.id}`))?.[1] ?? null
          }
          onFitWidth={() => fitColumn(menuCol)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
