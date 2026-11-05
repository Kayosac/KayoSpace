import { useCallback, useEffect, useState } from 'react';
import type { Hub } from './devices';
import { listTrash, restoreTrash, trashTime, type TrashGroup } from './trash';

/** Панель досок → «Корзина»: удалённое с этой доски за 7 дней — человеком или агентом. */
export function TrashSection({ hub, board }: { hub: Hub; board: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<TrashGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await listTrash(hub, board));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Хаб недоступен');
    }
  }, [hub, board]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <section className="trash" data-testid="trash">
      <button
        className="secondary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="trash-open"
      >
        {open ? 'Скрыть корзину' : 'Корзина этой доски'}
      </button>
      {open && (
        <>
          {error && <small className="bad">{error}</small>}
          {groups && groups.length === 0 && <small>Пусто. Удалённое лежит здесь 7 дней.</small>}
          {groups && groups.length > 0 && (
            <ul className="device-list" data-testid="trash-list">
              {groups.map((g, i) => (
                <li key={`${g.at}:${g.ids[0]}`}>
                  <div>
                    <b>{g.preview}</b>
                    <small>
                      {g.by === 'agent' ? 'удалил агент' : 'удалено'} {trashTime(g.at)}
                    </small>
                  </div>
                  <button
                    className="danger-btn neutral"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(i);
                      try {
                        await restoreTrash(hub, board, g.ids);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Не получилось вернуть');
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === i ? 'Возвращаю…' : 'Вернуть'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
