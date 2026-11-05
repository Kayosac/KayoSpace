import { useEffect, useState } from 'react';
import type { Hub } from './devices';
import { CloseIcon } from './icons';
import {
  authorsText,
  copyVersion,
  listVersions,
  restoreVersion,
  versionPreview,
  type Version,
} from './history';
import { trashTime } from './trash';

/**
 * История доски (решение 0018): хаб сам запоминает версии; любую можно посмотреть, вернуть
 * (новой правкой — текущее состояние тоже станет версией) или открыть копией рядом.
 */
export function HistoryPanel({
  hub,
  board,
  boardName,
  onOpenBoard,
  onToast,
  onClose,
}: {
  hub: Hub | null;
  board: string;
  boardName: string | null;
  onOpenBoard: (id: string, name: string) => void;
  onToast: (text: string) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!hub) return;
    let off = false;
    listVersions(hub, board)
      .then((v) => !off && (setVersions(v), setError(null)))
      .catch((e: unknown) => !off && setError(e instanceof Error ? e.message : 'Хаб недоступен'));
    return () => {
      off = true;
    };
  }, [hub?.url, hub?.token, board, tick]);

  useEffect(() => {
    if (confirm === null) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  return (
    <aside className="panel history-panel" aria-label="История доски" data-testid="history-panel">
      <div className="panel-head">
        <h2>История</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className="muted">
        {boardName ?? board}: хаб сам сохраняет версии, когда доска затихает. «Вернуть» тоже можно
        вернуть — текущий вид станет версией.
      </p>
      {!hub && <p className="muted">История хранится на хабе — включите синхронизацию.</p>}
      {error && <p className="bad">{error}</p>}
      {hub && versions === null && !error && <p className="muted">Загружаю…</p>}
      {versions?.length === 0 && (
        <p className="muted">Версий пока нет — они появятся после правок.</p>
      )}
      <ul className="versions" data-testid="versions">
        {versions?.map((v, i) => (
          <li key={v.at} data-testid="version">
            {hub && <Preview hub={hub} board={board} at={v.at} />}
            <div className="version-meta">
              <b>
                {trashTime(v.at)}
                {i === 0 && <span className="tag">последняя</span>}
              </b>
              <small>
                {v.elements} эл.{v.authors.length ? ` · ${authorsText(v.authors)}` : ''}
              </small>
              <div className="row version-actions">
                <button
                  className={confirm === v.at ? 'danger-btn confirm' : 'danger-btn neutral'}
                  disabled={busy || !hub}
                  onClick={async () => {
                    if (!hub) return;
                    if (confirm !== v.at) return setConfirm(v.at);
                    setConfirm(null);
                    setBusy(true);
                    try {
                      const n = await restoreVersion(hub, board, v.at);
                      onToast(n ? `Доска возвращена к версии (${n} изм.)` : 'Доска уже такая');
                      setTick((t) => t + 1);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Не получилось вернуть');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {confirm === v.at ? 'Точно вернуть?' : 'Вернуть'}
                </button>
                <button
                  className="danger-btn neutral"
                  disabled={busy || !hub}
                  onClick={async () => {
                    if (!hub) return;
                    setBusy(true);
                    try {
                      const c = await copyVersion(hub, board, v.at);
                      onOpenBoard(c.id, c.name);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Не получилось открыть копию');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Копией
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Preview({ hub, board, at }: { hub: Hub; board: string; at: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let off = false;
    versionPreview(hub, board, at)
      .then((u) => {
        url = u;
        if (!off) setSrc(u);
      })
      .catch(() => {});
    return () => {
      off = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [hub, board, at]);
  return src ? (
    <img className="version-preview" src={src} alt="" />
  ) : (
    <div className="version-preview empty" />
  );
}
