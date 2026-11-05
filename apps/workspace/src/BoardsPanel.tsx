import { useEffect, useMemo, useRef, useState } from 'react';
import { boardIdFromName, hubHttpUrl } from '@kayospace/sync';
import type { Project } from '@kayospace/model';
import { BOARD_TEMPLATES, type BoardBackground, type TemplateId } from '@kayospace/board';
import { docKind, isDocId, isPageId, pageIdFrom, tableIdFrom } from '@kayospace/page';

const BACKGROUNDS: { value: BoardBackground; name: string }[] = [
  { value: 'dots', name: 'Точки' },
  { value: 'grid', name: 'Клетка' },
  { value: 'lines', name: 'Линейка' },
  { value: 'plain', name: 'Чистый' },
];
import type { RecentBoard } from './settings';
import { matchesQuery, mergeBoards } from './boards';
import { inProject } from './projects';
import { KIND_WORDS } from './DocOverlay';
import { CommitInput } from './CommitInput';
import { searchHub, snippet, type SearchHit } from './search';
import { finePointer } from './touch';
import {
  CloseIcon,
  DocIcon,
  TableIcon,
  ArtifactIcon,
  ExportIcon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from './icons';

type ExportFormat = 'png' | 'pdf' | 'md' | 'src';

/** Правка №6, №8 (решение 0022): у каждого пункта списка — экспорт и удаление маленькими иконками. */
function ItemActions({
  id,
  name,
  onExport,
  onDelete,
}: {
  id: string;
  name: string | null;
  onExport: (id: string, name: string | null, format: ExportFormat) => void;
  onDelete: (id: string, name: string | null) => void;
}) {
  const [open, setOpen] = useState<'export' | 'delete' | null>(null);
  useEffect(() => {
    if (open !== 'delete') return;
    const t = setTimeout(() => setOpen(null), 5000);
    return () => clearTimeout(t);
  }, [open]);
  // Документ — ещё и в .md (решение 0023).
  const formats: ExportFormat[] = isPageId(id)
    ? ['pdf', 'md']
    : docKind(id) === 'artifact'
      ? ['src', 'pdf']
      : isDocId(id)
        ? ['pdf']
        : ['png', 'pdf'];
  return (
    <>
      <span className="item-icons">
        <button
          className="item-icon"
          aria-label="Экспорт"
          title="Экспорт"
          aria-expanded={open === 'export'}
          onClick={() => setOpen((o) => (o === 'export' ? null : 'export'))}
          data-testid="item-export"
        >
          <ExportIcon />
        </button>
        <button
          className="item-icon danger"
          aria-label="Удалить"
          title="Удалить"
          aria-expanded={open === 'delete'}
          onClick={() => setOpen((o) => (o === 'delete' ? null : 'delete'))}
          data-testid="item-delete"
        >
          <TrashIcon />
        </button>
      </span>
      {open === 'export' && (
        <div className="item-menu" data-testid="item-export-menu">
          {formats.map((f) => (
            <button
              key={f}
              className="project-chip"
              onClick={() => {
                setOpen(null);
                onExport(id, name, f);
              }}
            >
              {f === 'src' ? 'Исходник' : f.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {open === 'delete' && (
        <div className="item-menu" data-testid="item-delete-menu">
          <span>Точно удалить?</span>
          <button
            className="danger-btn confirm"
            onClick={() => {
              setOpen(null);
              onDelete(id, name);
            }}
            data-testid="item-delete-confirm"
          >
            Удалить
          </button>
          <button className="project-chip" onClick={() => setOpen(null)}>
            Отмена
          </button>
        </div>
      )}
    </>
  );
}

export function BoardsPanel({
  current,
  currentName,
  recent,
  hub,
  onOpen,
  onRename,
  frames,
  onFrame,
  projects,
  membership,
  project,
  onProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveBoard,
  deleted,
  trashBoards,
  onExportItem,
  onDeleteItem,
  onTrash,
  onHistory,
  onPresent,
  background,
  onBackground,
  searchLocal,
  onFind,
  onClose,
}: {
  current: string;
  currentName: string | null;
  recent: readonly RecentBoard[];
  /** Хаб для списка досок (null — синхронизация выключена). */
  hub: { url: string; token: string } | null;
  /** isNew — новая доска: ей нужно записать название. */
  onOpen: (id: string, name: string | null, isNew: boolean, template?: TemplateId) => void;
  onRename: (name: string) => void;
  /** Фреймы открытой доски. */
  frames: { id: string; name: string }[];
  onFrame: (id: string) => void;
  projects: readonly Project[];
  /** id доски → id проекта. */
  membership: ReadonlyMap<string, string>;
  /** Выбранный проект (null — все доски). */
  project: string | null;
  onProject: (id: string | null) => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  /** Переложить открытую доску в проект (null — без проекта). */
  onMoveBoard: (project: string | null) => void;
  /** Удалённые доски (их нет в списке). */
  deleted: ReadonlyMap<string, unknown>;
  /** Сколько удалённых досок можно вернуть (корзина не пуста — кнопка «Корзина» видна). */
  trashBoards: number;
  /** Экспорт пункта списка: доски — PNG или PDF, документы и таблицы — PDF. */
  onExportItem: (id: string, name: string | null, format: ExportFormat) => void;
  /** Удалить доску, документ или таблицу (7 дней их можно вернуть). */
  onDeleteItem: (id: string, name: string | null) => void;
  /** Открыть корзину (отдельная панель). */
  onTrash: () => void;
  /** Открыть историю версий открытого. */
  onHistory: () => void;
  /** Показать фреймы как слайды. */
  onPresent: () => void;
  background: BoardBackground;
  onBackground: (bg: BoardBackground) => void;
  /** Поиск по открытой доске (когда хаба нет). */
  searchLocal: (query: string) => { id: string; type: string; text: string }[];
  /** Перейти к найденному элементу (на этой или другой доске). */
  onFind: (board: string, id: string, boardName: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hubBoards, setHubBoards] = useState<
    { id: string; name: string | null; elements: number }[]
  >([]);
  const [hubError, setHubError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [newProject, setNewProject] = useState<string | null>(null);
  /** Выбор шаблона новой доски (правка №3) открыт. */
  const [picking, setPicking] = useState(false);
  const [newName, setNewName] = useState('');
  /** Список фреймов раскрыт (правка №5). */
  const [framesOpen, setFramesOpen] = useState(false);
  /** Сколько пачек удалённого в корзине на хабе (null — ещё не знаем). */
  const [trashGroups, setTrashGroups] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = projects.find((p) => p.id === project) ?? null;
  // Сразу ставить курсор в поиск — только при мыши: на планшете это открыло бы клавиатуру на пол-экрана.
  useEffect(() => {
    if (finePointer()) searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!hub) return;
    const base = hubHttpUrl(hub.url);
    if (!base) return;
    const ctrl = new AbortController();
    const headers: Record<string, string> = hub.token
      ? { Authorization: `Bearer ${hub.token}` }
      : {};
    fetch(`${base}/api/boards`, { headers, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(r.status === 401 ? 'хаб не принял токен' : `хаб ответил ${r.status}`);
        setHubBoards((await r.json()) as typeof hubBoards);
        setHubError(null);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setHubError(e instanceof Error ? e.message : 'хаб недоступен');
      });
    // Корзина пустая — кнопки «Корзина» нет (правка №7).
    fetch(`${base}/api/trash`, { headers, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) return;
        const { boards } = (await r.json()) as { boards: { groups: unknown[] }[] };
        setTrashGroups(boards.reduce((n, b) => n + b.groups.length, 0));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [hub?.url, hub?.token, deleted]);

  const list = useMemo(
    () =>
      inProject(mergeBoards(recent, hubBoards), membership, shown ? shown.id : null).filter(
        (b) => !deleted.has(b.id) && matchesQuery(b, query),
      ),
    [recent, hubBoards, query, membership, shown, deleted],
  );
  useEffect(() => setActive(0), [query]);

  // Поиск по содержимому: на хабе — по всем доскам, без хаба — по открытой.
  const [found, setFound] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setFound(null);
      return;
    }
    if (!hub) {
      setFound(searchLocal(q).map((h) => ({ ...h, board: current, boardName: currentName })));
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchHub(hub, q, ctrl.signal)
        .then(setFound)
        .catch(() => {
          if (ctrl.signal.aborted) return;
          // Хаб недоступен — ищем хотя бы на открытой доске.
          setFound(searchLocal(q).map((h) => ({ ...h, board: current, boardName: currentName })));
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, hub?.url, hub?.token, current, currentName, searchLocal]);

  /** Новая доска: шаблон (null — пустая), название — из поля выбора шаблона. */
  const createBoard = (template: TemplateId | null): void => {
    const title =
      newName.trim() ||
      (template ? BOARD_TEMPLATES.find((t) => t.id === template)!.name : 'Новая доска');
    setPicking(false);
    onOpen(boardIdFromName(title), title, true, template ?? undefined);
  };
  // Документ и таблица (решения 0020, 0021): id с «pg_» и «tb_».
  const createPage = (): void => {
    const title = 'Новый документ';
    onOpen(pageIdFrom(boardIdFromName(title)), title, true);
  };
  const createTable = (): void => {
    const title = 'Новая таблица';
    onOpen(tableIdFrom(boardIdFromName(title)), title, true);
  };
  const kind = docKind(current);
  const isDoc = kind !== null;
  const what =
    kind === 'page'
      ? 'этого документа'
      : kind === 'table'
        ? 'этой таблицы'
        : kind === 'artifact'
          ? 'этого артефакта'
          : 'этой доски';
  const trashEmpty = trashBoards === 0 && (trashGroups ?? 0) === 0;

  return (
    <aside
      className="panel boards"
      aria-label="Доски, документы и таблицы"
      data-testid="boards-panel"
    >
      {/* Открытое сейчас: название, история, проект, фон. */}
      <section className="panel-section">
        <div className="panel-head compact">
          <span className="muted small">Название {what}</span>
          <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="row name-row">
          <CommitInput
            value={currentName ?? ''}
            placeholder={current}
            aria-label={`Название ${what}`}
            onCommit={(v) => v.trim() && onRename(v)}
            data-testid="board-name"
          />
          <button
            className="icon-btn"
            aria-label="История"
            title="История версий"
            onClick={onHistory}
            data-testid="open-history"
          >
            <HistoryIcon />
          </button>
        </div>
        <label className="field">
          <span>Проект {what}</span>
          <select
            value={membership.get(current) ?? ''}
            onChange={(e) => onMoveBoard(e.target.value || null)}
            data-testid="board-project"
          >
            <option value="">Без проекта</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!isDoc && (
          <div className="field">
            <span>Фон этой доски</span>
            <div className="backgrounds" role="radiogroup" aria-label="Фон доски">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.value}
                  className="bg-option"
                  role="radio"
                  aria-checked={background === b.value}
                  aria-label={b.name}
                  data-bg={b.value}
                  onClick={() => onBackground(b.value)}
                >
                  <i />
                  <span>{b.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Создать — отдельно от списка (правки №1, №3). */}
      <section className="panel-section" data-testid="create-section">
        <div className="create-row">
          <button
            className="project-chip"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
            data-testid="create-board"
          >
            <PlusIcon /> Доска
          </button>
          <button className="project-chip" onClick={createPage} data-testid="create-page">
            <DocIcon /> Документ
          </button>
          <button className="project-chip" onClick={createTable} data-testid="create-table">
            <TableIcon /> Таблица
          </button>
        </div>
        {picking && (
          <div className="template-picker" data-testid="templates">
            <input
              className="project-input"
              value={newName}
              placeholder="Название новой доски"
              aria-label="Название новой доски"
              enterKeyHint="done"
              maxLength={120}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="new-board-name"
            />
            <div className="template-chips">
              <button className="project-chip primary-chip" onClick={() => createBoard(null)}>
                Пустой
              </button>
              {BOARD_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  className="project-chip"
                  title={t.hint}
                  onClick={() => createBoard(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            {shown && <small className="muted">Появится в проекте «{shown.name}».</small>}
          </div>
        )}
      </section>

      {/* Проекты, поиск и список. */}
      <section className="panel-section">
        <div className="projects" role="tablist" aria-label="Проекты" data-testid="projects">
          <button
            role="tab"
            aria-selected={!shown}
            className="project-chip"
            onClick={() => onProject(null)}
          >
            Всё
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={shown?.id === p.id}
              className="project-chip"
              onClick={() => onProject(p.id)}
            >
              <i style={{ background: p.color }} />
              {p.name}
            </button>
          ))}
          {newProject === null ? (
            <button
              className="project-chip add"
              aria-label="Новый проект"
              title="Новый проект"
              onClick={() => setNewProject('')}
              data-testid="add-project"
            >
              <PlusIcon />
            </button>
          ) : (
            // Форма: «Создать» — кнопкой, «Готово» на экранной клавиатуре или Enter.
            // Уход фокуса ничего не отменяет — на планшете клавиатуру прячут, не закончив ввод.
            <form
              className="project-new"
              data-testid="new-project"
              onSubmit={(e) => {
                e.preventDefault();
                const n = newProject.trim();
                if (!n) return;
                onCreateProject(n);
                setNewProject(null);
              }}
            >
              <input
                className="project-input"
                autoFocus
                value={newProject}
                placeholder="Название проекта"
                aria-label="Название нового проекта"
                enterKeyHint="done"
                maxLength={60}
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNewProject(null);
                }}
                data-testid="new-project-name"
              />
              <button
                type="submit"
                className="project-chip primary-chip"
                disabled={!newProject.trim()}
                data-testid="new-project-create"
              >
                Создать
              </button>
              <button
                type="button"
                className="project-chip add"
                aria-label="Не создавать проект"
                title="Не создавать"
                onClick={() => setNewProject(null)}
              >
                <CloseIcon />
              </button>
            </form>
          )}
        </div>
        {shown && (
          <div className="row project-edit">
            <CommitInput
              key={shown.id}
              value={shown.name}
              aria-label="Название проекта"
              data-testid="project-name"
              onCommit={(v) => onRenameProject(shown.id, v)}
            />
            <button className="link-btn danger-link" onClick={() => onDeleteProject(shown.id)}>
              Удалить проект
            </button>
          </div>
        )}
        <div className="search">
          <SearchIcon />
          <input
            ref={searchRef}
            value={query}
            placeholder="Найти"
            aria-label="Найти"
            enterKeyHint="go"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const b = list[active];
                if (b) onOpen(b.id, b.name, false);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
        </div>
        <ul className="board-list" role="listbox" aria-label="Список">
          {list.length === 0 && (
            <li className="muted empty">
              {query.trim()
                ? 'Ничего не нашлось.'
                : shown
                  ? 'В проекте пока пусто — создайте или перенесите открытое.'
                  : 'Пока пусто.'}
            </li>
          )}
          {list.map((b, i) => (
            <li key={b.id} className="board-item">
              <button
                role="option"
                aria-selected={i === active}
                className={b.id === current ? 'current' : undefined}
                onClick={() => onOpen(b.id, b.name, false)}
                onMouseEnter={() => setActive(i)}
              >
                {isPageId(b.id) && <DocIcon />}
                {docKind(b.id) === 'table' && <TableIcon />}
                {docKind(b.id) === 'artifact' && <ArtifactIcon />}
                <span className="board-title">{b.name ?? b.id}</span>
                <span className="board-meta">
                  {isDocId(b.id)
                    ? b.id === current
                      ? 'открыт'
                      : KIND_WORDS[docKind(b.id) ?? 'page'].meta
                    : b.id === current
                      ? 'открыта'
                      : b.elements !== undefined
                        ? `${b.elements} эл.`
                        : ''}
                </span>
              </button>
              <ItemActions
                id={b.id}
                name={b.name}
                onExport={onExportItem}
                onDelete={onDeleteItem}
              />
            </li>
          ))}
        </ul>
        {found && (
          <>
            <h3 className="section-title">
              {found.length > 0 ? `Найдено внутри: ${found.length}` : 'Внутри ничего не нашлось'}
            </h3>
            {found.length > 0 && (
              <ul className="board-list found-list" aria-label="Найдено" data-testid="found">
                {found.map((h) => (
                  <li key={`${h.board}:${h.id}`}>
                    <button onClick={() => onFind(h.board, h.id, h.boardName)}>
                      <span className="board-title">{snippet(h.text, query)}</span>
                      <span className="board-meta">{h.boardName ?? h.board}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {!isDoc && frames.length > 0 && (
        <section className="panel-section">
          <div className="section-row">
            <button
              className="section-toggle"
              aria-expanded={framesOpen}
              onClick={() => setFramesOpen((o) => !o)}
              data-testid="frames-toggle"
            >
              <span className={framesOpen ? 'chev open' : 'chev'}>›</span>
              Фреймы этой доски <span className="muted">{frames.length}</span>
            </button>
            <button className="secondary" onClick={onPresent} data-testid="present">
              <PlayIcon />
              Показать
            </button>
          </div>
          {framesOpen && (
            <ul className="board-list frames-list" aria-label="Фреймы" data-testid="frames-list">
              {frames.map((f) => (
                <li key={f.id}>
                  <button onClick={() => onFrame(f.id)}>
                    <span className="board-title">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!trashEmpty && (
        <section className="panel-section">
          <button className="secondary" onClick={onTrash} data-testid="open-trash">
            <TrashIcon />
            Корзина
          </button>
        </section>
      )}
      {hub && hubError && <p className="muted">Список с хаба недоступен: {hubError}</p>}
      {!hub && <p className="muted">Включите синхронизацию — появятся доски с хаба.</p>}
      {finePointer() && <p className="muted">Ctrl/⌘ K — открыть этот список с клавиатуры.</p>}
    </aside>
  );
}
