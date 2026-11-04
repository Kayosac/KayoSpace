import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdate, updatesSupported, type AppUpdate } from './updates';

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; update: AppUpdate }
  | { kind: 'installing'; update: AppUpdate; progress: number | null }
  | { kind: 'error'; message: string };

const RECHECK_MS = 6 * 3_600_000;

/** Проверка обновлений: через несколько секунд после запуска, потом раз в 6 часов и по кнопке. */
export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const busy = useRef(false);

  const check = useCallback(async (manual: boolean) => {
    if (!updatesSupported() || busy.current) return;
    busy.current = true;
    if (manual) setStatus({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      setStatus(update ? { kind: 'available', update } : { kind: 'none' });
      if (manual) setDismissed(null);
    } catch (err) {
      // Фоновая проверка без сети — не повод показывать ошибку.
      if (manual) {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Не получилось проверить',
        });
      }
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!updatesSupported()) return;
    const first = setTimeout(() => void check(false), 5000);
    const again = setInterval(() => void check(false), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [check]);

  const install = useCallback(async () => {
    if (status.kind !== 'available') return;
    const update = status.update;
    setStatus({ kind: 'installing', update, progress: null });
    try {
      await update.install((progress) => setStatus({ kind: 'installing', update, progress }));
      // Android: ссылку открыли в браузере — дальше установку ведёт система.
      if (update.kind === 'android') setStatus({ kind: 'available', update });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Обновление не установилось',
      });
    }
  }, [status]);

  const shown =
    (status.kind === 'available' && status.update.version !== dismissed) ||
    status.kind === 'installing';
  return {
    status,
    supported: updatesSupported(),
    shown,
    check: () => void check(true),
    install: () => void install(),
    dismiss: () => status.kind === 'available' && setDismissed(status.update.version),
  };
}

/** Плашка «Доступна версия …» над панелью инструментов. */
export function UpdateBanner({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { status } = updates;
  if (!updates.shown) return null;
  if (status.kind !== 'available' && status.kind !== 'installing') return null;
  const { update } = status;
  const installing = status.kind === 'installing';
  const pct =
    installing && status.progress !== null ? ` ${Math.round(status.progress * 100)}%` : '';
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span>
        {installing
          ? `Загружаю версию ${update.version}…${pct}`
          : `Доступна версия ${update.version}`}
      </span>
      {!installing && (
        <>
          <button className="primary" onClick={updates.install} data-testid="update-install">
            {update.kind === 'android' ? 'Скачать' : 'Установить'}
          </button>
          <button className="link-btn" onClick={updates.dismiss}>
            Позже
          </button>
        </>
      )}
    </div>
  );
}
