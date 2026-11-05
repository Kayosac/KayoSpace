import { useCallback, useEffect, useState } from 'react';
import type { Hub } from './devices';
import { CloseIcon } from './icons';
import { clearTrash, listAllTrash, restoreTrash, trashTime, type BoardTrash } from './trash';

/**
 * Корзина (решение 0016, отдельная панель — решение 0017): удалённые доски и удалённое со всех досок
 * за 7 дней — человеком или агентом. Всё возвращается одним касанием.
 */
export function TrashPanel({
  hub,
  current,
  deletedBoards,
  onRestoreBoard,
  onOpenBoard,
  onClearBoards,
  onClose,
}: {
  /** Хаб (null — синхронизация выключена: корзины элементов нет, доски вернуть можно). */
  hub: Hub | null;
  current: string;
  deletedBoards: readonly { id: string; name: string | null; at: number }[];
  onRestoreBoard: (id: string, name: string | null) => void;
  onOpenBoard: (id: string, name: string | null) => void;
  /** Стереть удалённые доски насовсем (на этом устройстве; хаб стирает у себя сам). */
  onClearBoards: () => void;
  onClose: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 5000);
    return () => clearTimeout(t);
  }, [confirmClear]);
  const [boards, setBoards] = useState<BoardTrash[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hub) return;
    try {
      setBoards(await listAllTrash(hub));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хаб недоступен');
    }
  }, [hub?.url, hub?.token]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (board: string, ids: string[], key: string): Promise<void> => {
    if (!hub) return;
    setBusy(key);
    try {
      await restoreTrash(hub, board, ids);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось вернуть');
    } finally {
      setBusy(null);
    }
  };

  /** «Очистить корзину» (решение 0022): на хабе — всё сразу, на устройстве — удалённые доски. */
  const clear = async (): Promise<void> => {
    setBusy('clear');
    try {
      if (hub) await clearTrash(hub);
      onClearBoards();
      setConfirmClear(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось очистить');
    } finally {
      setBusy(null);
    }
  };

  // Открытая доска — первой: чаще всего возвращают то, что только что удалили здесь.
  const list = boards
    ? [...boards].sort((a, b) => Number(b.board === current) - Number(a.board === current))
    : [];
  const empty = deletedBoards.length === 0 && boards !== null && boards.length === 0;

  return (
    <aside className="panel trash-panel" aria-label="Корзина" data-testid="trash-panel">
      <div className="panel-head">
        <h2>Корзина</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className="muted">Удалённое — вами или агентом — лежит здесь 7 дней, потом стирается.</p>
      {!empty && (boards !== null || !hub) && (
        <div className="row trash-clear">
          {confirmClear ? (
            <>
              <span>Стереть всё насовсем? Вернуть будет нельзя.</span>
              <button
                className="danger-btn confirm"
                disabled={busy !== null}
                onClick={() => void clear()}
                data-testid="trash-clear-confirm"
              >
                {busy === 'clear' ? 'Стираю…' : 'Стереть'}
              </button>
              <button className="project-chip" onClick={() => setConfirmClear(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button
              className="danger-btn"
              onClick={() => setConfirmClear(true)}
              data-testid="trash-clear"
            >
              Очистить корзину
            </button>
          )}
        </div>
      )}

      {deletedBoards.length > 0 && (
        <>
          <h3 className="section-title">Доски</h3>
          <ul className="device-list trash-list" data-testid="deleted-boards">
            {deletedBoards.map((d) => (
              <li key={d.id}>
                <div>
                  <b>{d.name ?? d.id}</b>
                  <small>доска удалена {trashTime(d.at)}</small>
                </div>
                <button className="danger-btn neutral" onClick={() => onRestoreBoard(d.id, d.name)}>
                  Вернуть
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {!hub && (
        <p className="muted">
          Удалённое с досок хранит хаб — включите синхронизацию, чтобы его вернуть.
        </p>
      )}
      {error && <p className="bad">{error}</p>}
      {hub && boards === null && !error && <p className="muted">Загружаю…</p>}
      {empty && <p className="muted trash-empty">Корзина пуста.</p>}

      {list.map((b) => (
        <section key={b.board} className="trash-board" data-testid="trash-board">
          <h3 className="section-title trash-board-title">
            <button
              className="link-btn"
              onClick={() => onOpenBoard(b.board, b.name)}
              disabled={b.board === current}
            >
              {b.name ?? b.board}
            </button>
            {b.board === current && <span className="tag">открыта</span>}
          </h3>
          <ul className="device-list trash-list" data-testid="trash-list">
            {b.groups.map((g) => {
              const key = `${b.board}:${g.at}:${g.ids[0]}`;
              return (
                <li key={key}>
                  <div>
                    <b>{g.preview}</b>
                    <small>
                      {g.by === 'agent' ? 'удалил агент' : 'удалено'} {trashTime(g.at)}
                    </small>
                  </div>
                  <button
                    className="danger-btn neutral"
                    disabled={busy !== null}
                    onClick={() => void restore(b.board, g.ids, key)}
                  >
                    {busy === key ? 'Возвращаю…' : 'Вернуть'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
