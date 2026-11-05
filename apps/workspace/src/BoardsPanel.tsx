import { useEffect, useMemo, useRef, useState } from 'react';
import { boardIdFromName, hubHttpUrl } from '@kayospace/sync';
import type { Project } from '@kayospace/model';
import { BOARD_TEMPLATES, type BoardBackground, type TemplateId } from '@kayospace/board';
import { isPageId, pageIdFrom } from '@kayospace/page';

const BACKGROUNDS: { value: BoardBackground; name: string }[] = [
  { value: 'dots', name: 'Точки' },
  { value: 'grid', name: 'Клетка' },
  { value: 'lines', name: 'Линейка' },
  { value: 'plain', name: 'Чистый' },
];
import type { RecentBoard } from './settings';
import { matchesQuery, mergeBoards } from './boards';
import { inProject } from './projects';
import { CommitInput } from './CommitInput';
import { searchHub, snippet, type SearchHit } from './search';
import { finePointer } from './touch';
import {
  CloseIcon,
  DocIcon,
  ExportIcon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from './icons';

export function BoardsPanel({
  current,
  currentName,
  recent,
  hub,
  onOpen,
  onRename,
  frames,
  onFrame,
  onExport,
  projects,
  membership,
  project,
  onProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveBoard,
  deleted,
  trashCount,
  onDeleteBoard,
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
  onExport: (target: 'board' | 'pdf') => void;
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
  /** Сколько удалённых досок можно вернуть (подсказка на кнопке «Корзина»). */
  trashCount: number;
  /** Удалить открытую доску (7 дней её можно вернуть). */
  onDeleteBoard: () => void;
  /** Открыть корзину (отдельная панель). */
  onTrash: () => void;
  /** Открыть историю версий этой доски. */
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
  // Удаление — в два касания: первое спрашивает «Точно?», через 4 секунды вопрос снимается.
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  useEffect(() => setConfirmDelete(false), [current]);
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
    fetch(`${base}/api/boards`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(r.status === 401 ? 'хаб не принял токен' : `хаб ответил ${r.status}`);
        setHubBoards((await r.json()) as typeof hubBoards);
        setHubError(null);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setHubError(e instanceof Error ? e.message : 'хаб недоступен');
      });
    return () => ctrl.abort();
  }, [hub?.url, hub?.token]);

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

  const create = (): void => {
    const title = query.trim() || 'Новая доска';
    onOpen(boardIdFromName(title), title, true);
  };
  // Документ (решение 0020): id с «pg_» — по нему сразу видно, что это страница.
  const createPage = (): void => {
    const title = query.trim() || 'Новый документ';
    onOpen(pageIdFrom(boardIdFromName(title)), title, true);
  };
  const isPage = isPageId(current);
  const what = isPage ? 'этого документа' : 'этой доски';

  return (
    <aside className="panel boards" aria-label="Доски" data-testid="boards-panel">
      <div className="panel-head">
        <h2>Доски</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <label className="field">
        <span>Название {what}</span>
        <CommitInput
          value={currentName ?? ''}
          placeholder={current}
          onCommit={(v) => v.trim() && onRename(v)}
          data-testid="board-name"
        />
      </label>
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
      {!isPage && (
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
      <div className="projects" role="tablist" aria-label="Проекты" data-testid="projects">
        <button
          role="tab"
          aria-selected={!shown}
          className="project-chip"
          onClick={() => onProject(null)}
        >
          Все доски
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
          placeholder="Найти или создать доску"
          aria-label="Найти или создать доску"
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, list.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const b = list[active];
              if (b) onOpen(b.id, b.name, false);
              else create();
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
      </div>
      <ul className="board-list" role="listbox" aria-label="Список досок">
        {list.length === 0 && shown && !query.trim() && (
          <li className="muted empty">
            В проекте пока нет досок — создайте или перенесите текущую.
          </li>
        )}
        {list.map((b, i) => (
          <li key={b.id}>
            <button
              role="option"
              aria-selected={i === active}
              className={b.id === current ? 'current' : undefined}
              onClick={() => onOpen(b.id, b.name, false)}
              onMouseEnter={() => setActive(i)}
            >
              {isPageId(b.id) && <DocIcon />}
              <span className="board-title">{b.name ?? b.id}</span>
              <span className="board-meta">
                {isPageId(b.id)
                  ? b.id === current
                    ? 'открыт'
                    : 'документ'
                  : b.id === current
                    ? 'открыта'
                    : b.elements !== undefined
                      ? `${b.elements} эл.`
                      : ''}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            className="create"
            aria-selected={active === list.length}
            onClick={create}
            onMouseEnter={() => setActive(list.length)}
          >
            <PlusIcon />
            <span>
              {query.trim() ? `Создать «${query.trim()}»` : 'Новая доска'}
              {shown ? ` в «${shown.name}»` : ''}
            </span>
          </button>
        </li>
        <li>
          <button className="create" onClick={createPage} data-testid="create-page">
            <DocIcon />
            <span>
              {query.trim() ? `Документ «${query.trim()}»` : 'Новый документ'}
              {shown ? ` в «${shown.name}»` : ''}
            </span>
          </button>
        </li>
      </ul>
      <div className="templates" data-testid="templates">
        <span className="muted">Или новая доска из шаблона:</span>
        <div className="template-chips">
          {BOARD_TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="project-chip"
              title={t.hint}
              onClick={() => {
                const title = query.trim() || t.name;
                onOpen(boardIdFromName(title), title, true, t.id);
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>
      {found && (
        <>
          <h3 className="section-title">
            {found.length > 0
              ? `Найдено на досках: ${found.length}`
              : 'На досках ничего не нашлось'}
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
      {!isPage && frames.length > 0 && (
        <>
          <div className="section-row">
            <h3 className="section-title">Фреймы этой доски</h3>
            <button className="secondary" onClick={onPresent} data-testid="present">
              <PlayIcon />
              Показать
            </button>
          </div>
          <ul className="board-list frames-list" aria-label="Фреймы" data-testid="frames-list">
            {frames.map((f) => (
              <li key={f.id}>
                <button onClick={() => onFrame(f.id)}>
                  <span className="board-title">{f.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!isPage && (
        <div className="row export-row">
          <button className="secondary" onClick={() => onExport('board')} data-testid="export-png">
            <ExportIcon />
            PNG
          </button>
          <button className="secondary" onClick={() => onExport('pdf')} data-testid="export-pdf">
            <ExportIcon />
            PDF{frames.length > 0 ? ` (${frames.length} стр.)` : ''}
          </button>
        </div>
      )}
      <div className="row board-danger">
        <button
          className={confirmDelete ? 'danger-btn confirm' : 'danger-btn'}
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            setConfirmDelete(false);
            onDeleteBoard();
          }}
          data-testid="delete-board"
        >
          {confirmDelete
            ? isPage
              ? 'Точно удалить документ?'
              : 'Точно удалить доску?'
            : isPage
              ? 'Удалить этот документ'
              : 'Удалить эту доску'}
        </button>
        {confirmDelete && <small>Её можно будет вернуть 7 дней.</small>}
        {!confirmDelete && (
          <button className="secondary" onClick={onHistory} data-testid="open-history">
            <HistoryIcon />
            История
          </button>
        )}
        {!confirmDelete && (
          <button className="secondary" onClick={onTrash} data-testid="open-trash">
            <TrashIcon />
            Корзина{trashCount > 0 ? ` · досок: ${trashCount}` : ''}
          </button>
        )}
      </div>
      {hub && hubError && <p className="muted">Список с хаба недоступен: {hubError}</p>}
      {!hub && <p className="muted">Включите синхронизацию — появятся доски с хаба.</p>}
      {finePointer() && <p className="muted">Ctrl/⌘ K — открыть этот список с клавиатуры.</p>}
    </aside>
  );
}
