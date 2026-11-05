import { useState, type FormEvent } from 'react';
import { isValidBoardId } from '@kayospace/sync';
import type { ConnectionState } from './connection';
import { DevicesSection } from './DevicesSection';
import { BackupsSection } from './BackupsSection';
import type { useUpdates } from './UpdateBanner';
import type { SessionState } from './session';
import type { WorkspaceSettings } from './settings';
import { CloseIcon } from './icons';
import { SYNC_TEXT } from './Chips';

declare const __APP_VERSION__: string;

export function SettingsPanel({
  settings,
  state,
  connection,
  onApply,
  onConnect,
  onSelfRevoked,
  onTouchDraws,
  onRotateWithFingers,
  lowLatency,
  onLowLatency,
  onOpenBoard,
  updates,
  onClose,
}: {
  settings: WorkspaceSettings;
  state: SessionState | null;
  connection: ConnectionState;
  onApply: (patch: Partial<WorkspaceSettings>) => void;
  /** Открыть экран подключения к хабу. */
  onConnect: () => void;
  /** Это устройство отключили из списка устройств. */
  onSelfRevoked: () => void;
  onTouchDraws: (on: boolean) => void;
  onRotateWithFingers: (on: boolean) => void;
  lowLatency: boolean;
  onLowLatency: (on: boolean) => void;
  /** Открыть доску (восстановленную из копии). */
  onOpenBoard: (id: string, name: string) => void;
  updates: ReturnType<typeof useUpdates>;
  onClose: () => void;
}) {
  const [board, setBoard] = useState(settings.board);

  const boardOk = isValidBoardId(board.trim());
  const changed = board.trim() !== settings.board;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!boardOk) return;
    onApply({ board: board.trim() });
  };

  const hub = connection.hub;
  const status = state ? (SYNC_TEXT[state.sync] ?? state.sync) : '';

  return (
    <aside className="panel" aria-label="Настройки">
      <div className="panel-head">
        <h2>Доска и синхронизация</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <form onSubmit={submit}>
        <label className="field">
          <span>Доска</span>
          <input
            value={board}
            onChange={(e) => setBoard(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-testid="board-input"
          />
          {!boardOk && <small className="bad">Латиница, цифры, «-» и «_», до 64 символов.</small>}
        </label>
        {changed && (
          <div className="row">
            <button type="submit" className="primary" disabled={!boardOk}>
              Открыть
            </button>
          </div>
        )}
      </form>
      <hr />
      <div className="hub-info" data-testid="hub-info">
        {connection.dev ? (
          <>
            <span className="muted">Локальный хаб разработки</span>
            <b className="mono">{hub?.url}</b>
            <span className="muted">{status}</span>
          </>
        ) : hub ? (
          <>
            <span className="muted">Хаб</span>
            <b className="mono">{hub.url}</b>
            <span className="muted">{status}</span>
            <button className="link-btn" onClick={onConnect}>
              Подключить к другому хабу
            </button>
          </>
        ) : (
          <>
            <span className="muted">Доски хранятся только на этом устройстве.</span>
            <button className="primary" onClick={onConnect} data-testid="open-connect">
              Подключить к хабу
            </button>
          </>
        )}
      </div>
      {hub && !connection.dev && <DevicesSection hub={hub} onSelfRevoked={onSelfRevoked} />}
      {hub && <BackupsSection hub={hub} current={settings.board} onOpen={onOpenBoard} />}
      <hr />
      <label className="check">
        <input
          type="checkbox"
          checked={settings.touchDraws}
          onChange={(e) => onTouchDraws(e.target.checked)}
        />
        <span>
          Рисовать пальцем
          <small>Выключено — пальцем двигаете холст, рисуете пером или мышью.</small>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.rotateWithFingers}
          onChange={(e) => onRotateWithFingers(e.target.checked)}
        />
        <span>
          Поворачивать холст двумя пальцами
          <small>
            Начинается после заметного поворота пальцев; у прямого угла холст выравнивается сам.
          </small>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={lowLatency}
          onChange={(e) => onLowLatency(e.target.checked)}
          data-testid="low-latency"
        />
        <span>
          Перо с минимальной задержкой
          <small>
            Линия появляется под пером быстрее. На некоторых экранах (чаще Windows) при сдвиге
            холста видны разрывы картинки — тогда выключите. Само включается только на Android.
          </small>
        </span>
      </label>
      <hr />
      <dl className="keys">
        <dt>Сдвиг</dt>
        <dd>два пальца, колесо, пробел + мышь</dd>
        <dt>Масштаб</dt>
        <dd>щипок, Ctrl/⌘ + колесо</dd>
        <dt>Поворот</dt>
        <dd>холст — двумя пальцами, Shift [ и ]; элемент — круглая ручка над рамкой</dd>
        <dt>Инструменты</dt>
        <dd>
          V выделение · P ручка · I выделитель · E ластик · N стикер · T текст · F фрейм · H рука
        </dd>
        <dt>Фигуры</dt>
        <dd>R прямоугольник · O эллипс · L линия · A стрелка; Shift — ровно</dd>
        <dt>Заметки</dt>
        <dd>повторный тап или Enter — править; Esc или тап мимо — готово</dd>
        <dt>Доски</dt>
        <dd>Ctrl/⌘ K — найти, создать, переключить</dd>
        <dt>Отмена</dt>
        <dd>Ctrl/⌘ Z, Shift — повтор; тап двумя пальцами — отмена, тремя — повтор</dd>
        <dt>Выделение</dt>
        <dd>лассо пером, рамка мышью, Shift — добавить; угол — масштаб</dd>
        <dt>Правка</dt>
        <dd>Ctrl/⌘ C, X, V (текст и картинки тоже), D (копия рядом), Delete, стрелки</dd>
        <dt>Слои</dt>
        <dd>Ctrl/⌘ ] — наверх, Ctrl/⌘ [ — вниз; выравнивание — «⋯» в меню выделения</dd>
        <dt>Фреймы</dt>
        <dd>
          F и протянуть рамку; за заголовок — перенос вместе с содержимым; список и экспорт — в
          панели досок
        </dd>
        <dt>ИИ</dt>
        <dd>«✦ ИИ» в меню выделения; Ctrl/⌘ J — свой запрос</dd>
        <dt>Вид</dt>
        <dd>Shift 1 — всё, Shift 0 — 100%</dd>
      </dl>
      <div className="version">
        <span className="muted">Kayospace {__APP_VERSION__}</span>
        {updates.supported && (
          <>
            <button
              className="link-btn"
              onClick={updates.check}
              disabled={updates.status.kind === 'checking' || updates.status.kind === 'installing'}
              data-testid="update-check"
            >
              Проверить обновления
            </button>
            <small data-testid="update-status">{updateText(updates.status)}</small>
          </>
        )}
      </div>
    </aside>
  );
}

function updateText(s: ReturnType<typeof useUpdates>['status']): string {
  switch (s.kind) {
    case 'checking':
      return 'Проверяю…';
    case 'none':
      return 'Установлена последняя версия.';
    case 'available':
      return `Доступна версия ${s.update.version}.`;
    case 'installing':
      return `Устанавливаю ${s.update.version}…`;
    case 'error':
      return s.message;
    default:
      return '';
  }
}
