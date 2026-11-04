import { useEffect, useMemo, useRef, useState } from 'react';
import { boardIdFromName, hubHttpUrl } from '@kayospace/sync';
import type { RecentBoard } from './settings';
import { matchesQuery, mergeBoards } from './boards';
import { CloseIcon, PlusIcon, SearchIcon } from './icons';

export function BoardsPanel({
  current,
  currentName,
  recent,
  hub,
  onOpen,
  onRename,
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
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [name, setName] = useState(currentName ?? '');
  const [hubBoards, setHubBoards] = useState<
    { id: string; name: string | null; elements: number }[]
  >([]);
  const [hubError, setHubError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

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
    () => mergeBoards(recent, hubBoards).filter((b) => matchesQuery(b, query)),
    [recent, hubBoards, query],
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
            <span>{query.trim() ? `Создать «${query.trim()}»` : 'Новая доска'}</span>
          </button>
        </li>
      </ul>
      {hub && hubError && <p className="muted">Список с хаба недоступен: {hubError}</p>}
      {!hub && <p className="muted">Включите синхронизацию — появятся доски с хаба.</p>}
      <p className="muted">Ctrl/⌘ K — открыть этот список с клавиатуры.</p>
    </aside>
  );
}
