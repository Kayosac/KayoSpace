import type { CanvasEngine } from '@kayospace/canvas';
import type { SessionState } from './session';
import { CompassIcon, FitIcon, MinusIcon, PlusIcon } from './icons';

export const SYNC_TEXT: Record<string, string> = {
  off: 'Только на этом устройстве',
  'bad-address': 'Неверный адрес хаба',
  connecting: 'Подключаюсь…',
  connected: 'Подключено',
  synced: 'Синхронизировано',
  offline: 'Нет связи с хабом',
  unauthorized: 'Хаб не принял токен',
  stopped: 'Отключено',
};

const ERROR_TEXT: Record<string, string> = {
  timeout: 'хаб не отвечает',
  closed: 'соединение закрыто',
  'invalid-url': 'адрес не подходит',
  unauthorized: 'неверный токен',
};

/** Тон индикатора: ok — синхронизировано, wait — в процессе, bad — проблема, idle — без хаба. */
export function syncTone(sync: string): 'ok' | 'wait' | 'bad' | 'idle' {
  if (sync === 'synced') return 'ok';
  if (sync === 'connecting' || sync === 'connected') return 'wait';
  if (sync === 'off' || sync === 'stopped') return 'idle';
  return 'bad';
}

export function SyncChip({
  board,
  name,
  state,
  onClick,
}: {
  board: string;
  name: string | null;
  state: SessionState | null;
  onClick: () => void;
}) {
  const sync = state?.sync ?? 'off';
  const detail =
    sync === 'offline' && state?.error ? ` — ${ERROR_TEXT[state.error] ?? state.error}` : '';
  const text = (SYNC_TEXT[sync] ?? sync) + detail;
  return (
    <button className="chip board-chip" onClick={onClick} title="Доски (Ctrl/⌘ K)">
      <span className="brand">Kayospace</span>
      <span className="board-name" data-testid="board-title">
        {name ?? board}
      </span>
      <span className="sync" data-tone={syncTone(sync)} data-testid="sync" data-sync={sync}>
        <i />
        <span>{text}</span>
      </span>
    </button>
  );
}

export function ZoomControls({
  engine,
  zoom,
  rotation,
}: {
  engine: CanvasEngine;
  zoom: number;
  rotation: number;
}) {
  const deg = Math.round((rotation * 180) / Math.PI);
  return (
    <div className="chip zoom" role="group" aria-label="Масштаб">
      {deg !== 0 && (
        <button
          className="compass"
          aria-label="Вернуть поворот холста"
          title={`Холст повёрнут на ${deg}° — нажмите, чтобы выровнять`}
          data-testid="compass"
          onClick={() => engine.resetRotation()}
        >
          <span style={{ transform: `rotate(${rotation}rad)` }}>
            <CompassIcon />
          </span>
        </button>
      )}
      <button aria-label="Отдалить" title="Отдалить (Ctrl −)" onClick={() => engine.zoomBy(0.8)}>
        <MinusIcon />
      </button>
      <button
        className="zoom-value"
        title="Масштаб 100% (Shift+0)"
        data-testid="zoom"
        onClick={() => engine.resetZoom()}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        aria-label="Приблизить"
        title="Приблизить (Ctrl +)"
        onClick={() => engine.zoomBy(1.25)}
      >
        <PlusIcon />
      </button>
      <button
        aria-label="Показать всё"
        title="Показать всё (Shift+1)"
        onClick={() => engine.zoomToFit()}
      >
        <FitIcon />
      </button>
    </div>
  );
}
