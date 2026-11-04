import { useEffect, useMemo, useRef, useState } from 'react';
import { boardIdFromName, hubHttpUrl } from '@kayospace/sync';
import type { Project } from '@kayospace/model';
import type { RecentBoard } from './settings';
import { matchesQuery, mergeBoards } from './boards';
import { inProject } from './projects';
import { CloseIcon, ExportIcon, PlusIcon, SearchIcon } from './icons';

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
  onClose,
}: {
  current: string;
  currentName: string | null;
  recent: readonly RecentBoard[];
  /** Хаб для списка досок (null — синхронизация выключена). */
  hub: { url: string; token: string } | null;
  /** isNew — новая доска: ей нужно записать название. */
  onOpen: (id: string, name: string | null, isNew: boolean) => void;
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
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [name, setName] = useState(currentName ?? '');
  const [hubBoards, setHubBoards] = useState<
    { id: string; name: string | null; elements: number }[]
  >([]);
  const [hubError, setHubError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [newProject, setNewProject] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = projects.find((p) => p.id === project) ?? null;
  const [projectName, setProjectName] = useState(shown?.name ?? '');
  useEffect(() => setProjectName(shown?.name ?? ''), [shown?.id, shown?.name]);

  useEffect(() => setName(currentName ?? ''), [currentName]);
  useEffect(() => searchRef.current?.focus(), []);

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
      inProject(mergeBoards(recent, hubBoards), membership, shown ? shown.id : null).filter((b) =>
        matchesQuery(b, query),
      ),
    [recent, hubBoards, query, membership, shown],
  );
  useEffect(() => setActive(0), [query]);

  const create = (): void => {
    const title = query.trim() || 'Новая доска';
    onOpen(boardIdFromName(title), title, true);
  };

  return (
    <aside className="panel boards" aria-label="Доски" data-testid="boards-panel">
      <div className="panel-head">
        <h2>Доски</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <label className="field">
        <span>Название этой доски</span>
        <input
          value={name}
          placeholder={current}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && onRename(name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          data-testid="board-name"
        />
      </label>
      <label className="field">
        <span>Проект этой доски</span>
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
          <input
            className="project-input"
            autoFocus
            value={newProject}
            placeholder="Название проекта"
            aria-label="Название нового проекта"
            onChange={(e) => setNewProject(e.target.value)}
            onBlur={() => setNewProject(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newProject.trim()) {
                onCreateProject(newProject.trim());
                setNewProject(null);
              } else if (e.key === 'Escape') {
                setNewProject(null);
              }
            }}
          />
        )}
      </div>
      {shown && (
        <div className="row project-edit">
          <input
            value={projectName}
            aria-label="Название проекта"
            data-testid="project-name"
            onChange={(e) => setProjectName(e.target.value)}
            onBlur={() => onRenameProject(shown.id, projectName)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
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
              <span className="board-title">{b.name ?? b.id}</span>
              <span className="board-meta">
                {b.id === current ? 'открыта' : b.elements !== undefined ? `${b.elements} эл.` : ''}
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
      </ul>
      {frames.length > 0 && (
        <>
          <h3 className="section-title">Фреймы этой доски</h3>
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
      {hub && hubError && <p className="muted">Список с хаба недоступен: {hubError}</p>}
      {!hub && <p className="muted">Включите синхронизацию — появятся доски с хаба.</p>}
      <p className="muted">Ctrl/⌘ K — открыть этот список с клавиатуры.</p>
    </aside>
  );
}
