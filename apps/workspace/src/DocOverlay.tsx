import { useEffect, useState, useSyncExternalStore } from 'react';
import { getBoardName } from '@kayospace/board';
import type { CanvasEngine } from '@kayospace/canvas';
import { docExcerpt, docKind, hasTable, initTable, isDocId } from '@kayospace/page';
import { hubHttpUrl } from '@kayospace/sync';
import { BoardSession } from './session';
import type { Hub } from './devices';
import type { RecentBoard } from './settings';
import { PageView } from './PageView';
import { TableView } from './TableView';

export interface DocSummary {
  title?: string;
  excerpt?: string;
}

/** Название и начало текста документа — для карточки на доске. */
export function summaryOf(id: string, session: BoardSession): DocSummary {
  const title = getBoardName(session.doc) ?? undefined;
  const excerpt = docExcerpt(id, session.doc) || undefined;
  return { ...(title ? { title } : {}), ...(excerpt ? { excerpt } : {}) };
}

/**
 * Новый документ или таблица, когда локальная копия загрузилась: название и (у таблицы)
 * колонки по умолчанию. Не своя правка — «Отменить» её не стирает.
 */
export function prepareNewDoc(session: BoardSession, name: string): () => void {
  const run = (): boolean => {
    if (!session.getState().loaded) return false;
    if (!session.getState().name) session.rename(name);
    if (docKind(session.board) === 'table' && !hasTable(session.doc))
      initTable(session.doc, undefined, 'kayospace:table-init');
    return true;
  };
  if (run()) return () => {};
  const stop = session.subscribe(() => {
    if (run()) stop();
  });
  return stop;
}

/**
 * Документ или таблица поверх доски (решение 0021): своя сессия (синк, локальная копия), редактор
 * на весь экран и «← К доске». Пока документ правят, карточка на доске обновляется сама.
 */
export function DocOverlay({
  id,
  hub,
  boards,
  initialName,
  onSummary,
  onClose,
  onOpenBoard,
}: {
  id: string;
  hub: Hub | null;
  boards: readonly RecentBoard[];
  /** Новый документ: название, которое ему дать. */
  initialName?: string;
  onSummary: (s: DocSummary) => void;
  onClose: () => void;
  onOpenBoard: (board: string, frame: string | null, title: string | null) => void;
}) {
  const [session] = useState(() => new BoardSession(id, hub));
  useEffect(() => () => session.destroy(), [session]);
  useEffect(
    () => (initialName ? prepareNewDoc(session, initialName) : undefined),
    [session, initialName],
  );
  const state = useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => session.getState(),
  );
  // Правки (свои, агента, другого устройства) — в карточку, раз в секунду, не чаще.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (): void => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (session.getState().loaded) onSummary(summaryOf(id, session));
      }, 1000);
    };
    session.doc.on('update', on);
    return () => {
      session.doc.off('update', on);
      if (t) clearTimeout(t);
    };
  }, [session, id, onSummary]);
  const close = (): void => {
    if (session.getState().loaded) onSummary(summaryOf(id, session));
    onClose();
  };
  const table = docKind(id) === 'table';
  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-label={table ? 'Таблица' : 'Документ'}
      data-testid="doc-overlay"
    >
      {!state.loaded ? (
        <div className="loading">{table ? 'Открываю таблицу…' : 'Открываю документ…'}</div>
      ) : table ? (
        <TableView
          session={session}
          name={state.name}
          onRename={(n) => session.rename(n)}
          onClose={close}
        />
      ) : (
        <PageView
          session={session}
          name={state.name}
          hub={hub}
          boards={boards}
          onRename={(n) => session.rename(n)}
          onOpenBoard={(b, f, t) => {
            close();
            onOpenBoard(b, f, t);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

/** Что положить на доску: новый документ, новую таблицу или уже существующий. */
export function DocMenu({
  hub,
  recent,
  onNew,
  onExisting,
}: {
  hub: Hub | null;
  recent: readonly RecentBoard[];
  onNew: (kind: 'page' | 'table') => void;
  onExisting: (id: string, name: string | null) => void;
}) {
  const [list, setList] = useState<{ id: string; name: string | null }[]>(() =>
    recent.filter((b) => isDocId(b.id)),
  );
  useEffect(() => {
    const base = hub ? hubHttpUrl(hub.url) : null;
    if (!base || !hub) return;
    const ctrl = new AbortController();
    fetch(`${base}/api/boards`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) return;
        const all = (await r.json()) as { id: string; name: string | null }[];
        const seen = new Set(all.map((b) => b.id));
        setList([
          ...all.filter((b) => isDocId(b.id)),
          ...recent.filter((b) => isDocId(b.id) && !seen.has(b.id)),
        ]);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [hub, recent]);
  return (
    <div className="doc-menu" data-testid="doc-menu">
      <button className="project-chip" onClick={() => onNew('page')} data-testid="new-doc-card">
        + Документ
      </button>
      <button className="project-chip" onClick={() => onNew('table')} data-testid="new-table-card">
        + Таблица
      </button>
      {list.length > 0 && <span className="muted">Или уже существующий:</span>}
      <ul className="board-list">
        {list.slice(0, 30).map((d) => (
          <li key={d.id}>
            <button onClick={() => onExisting(d.id, d.name)} data-testid="existing-doc">
              <span className="board-title">{d.name ?? d.id}</span>
              <span className="board-meta">
                {docKind(d.id) === 'table' ? 'таблица' : 'документ'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Карточки документов на доске (решение 0021): название и начало текста — с хаба, при открытии доски
 * и раз в минуту. Правка не своя — «Отменить» её не трогает.
 */
export function useDocCards(engine: CanvasEngine | null, hub: Hub | null, loaded: boolean): void {
  useEffect(() => {
    if (!engine || !hub || !loaded) return;
    const base = hubHttpUrl(hub.url);
    if (!base) return;
    let stopped = false;
    const refresh = async (): Promise<void> => {
      const ids = [...new Set(engine.docCards().map((c) => c.doc))];
      if (!ids.length) return;
      try {
        const r = await fetch(`${base}/api/docs?ids=${encodeURIComponent(ids.join(','))}`, {
          headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
        });
        if (!r.ok || stopped) return;
        const { docs } = (await r.json()) as {
          docs: { id: string; title: string | null; excerpt: string }[];
        };
        for (const d of docs)
          engine.refreshDocCards(d.id, {
            ...(d.title ? { title: d.title } : {}),
            ...(d.excerpt ? { excerpt: d.excerpt } : {}),
          });
      } catch {
        // Хаб недоступен — карточки покажут то, что уже записано.
      }
    };
    const first = setTimeout(() => void refresh(), 1500);
    const t = setInterval(() => void refresh(), 60_000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [engine, hub, loaded]);
}
