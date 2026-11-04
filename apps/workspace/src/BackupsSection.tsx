import { useEffect, useState } from 'react';
import { backupTime, listBackups, restoreBoard, type BackupInfo } from './backups';
import type { Hub } from './devices';

/**
 * Настройки → Резервные копии: когда хаб последний раз снимал копию, и восстановление доски.
 * Восстановленная доска — новая копия рядом с исходной; исходная не меняется.
 */
export function BackupsSection({
  hub,
  current,
  onOpen,
}: {
  hub: Hub;
  /** Открытая доска — в списке первой. */
  current: string;
  onOpen: (id: string, name: string) => void;
}) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    listBackups(hub)
      .then((b) => {
        if (!alive) return;
        setBackups(b);
        setChosen(b[0]?.id ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Хаб недоступен');
      });
    return () => {
      alive = false;
    };
  }, [hub]);

  const backup = backups?.find((b) => b.id === chosen) ?? null;
  const boards = backup
    ? [...backup.boards].sort((a, b) => Number(b.id === current) - Number(a.id === current))
    : [];

  const restore = async (board: string): Promise<void> => {
    if (!backup) return;
    setBusy(board);
    setError(null);
    try {
      setMade(await restoreBoard(hub, backup.id, board));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось восстановить');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="devices backups" aria-label="Резервные копии" data-testid="backups">
      <div className="section-head">
        <h3>Резервные копии</h3>
        {backups && backups.length > 0 && (
          <button
            className="add-btn"
            onClick={() => setPicking((p) => !p)}
            aria-expanded={picking}
            data-testid="restore-open"
          >
            {picking ? 'Скрыть' : 'Восстановить доску'}
          </button>
        )}
      </div>
      {error && <small className="bad">{error}</small>}
      {backups && backups.length === 0 && (
        <small>Хаб снимает копию раз в несколько часов, если доски менялись. Пока копий нет.</small>
      )}
      {backups && backups.length > 0 && (
        <small data-testid="backups-last">
          Последняя — {backupTime(backups[0]!.at)}. Всего копий: {backups.length}.
        </small>
      )}
      {made && (
        <div className="restored" role="status">
          <span>Готово: «{made.name}». Исходная доска не изменилась.</span>
          <button className="primary" onClick={() => onOpen(made.id, made.name)}>
            Открыть
          </button>
        </div>
      )}
      {picking && backups && (
        <>
          <label className="field">
            <span>Копия от</span>
            <select
              value={chosen ?? ''}
              onChange={(e) => setChosen(e.target.value)}
              data-testid="backup-select"
            >
              {backups.map((b) => (
                <option key={b.id} value={b.id}>
                  {backupTime(b.at)} — досок: {b.boards.length}
                </option>
              ))}
            </select>
          </label>
          <ul className="device-list" data-testid="backup-boards">
            {boards.map((b) => (
              <li key={b.id}>
                <div>
                  <b>{b.name ?? b.id}</b>
                  {b.id === current && <span className="tag">открыта</span>}
                  <small>{b.elements} эл.</small>
                </div>
                <button
                  className="danger-btn neutral"
                  disabled={busy !== null}
                  onClick={() => void restore(b.id)}
                >
                  {busy === b.id ? 'Восстанавливаю…' : 'Восстановить'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
