import { useState, type FormEvent } from 'react';
import { hubSyncUrl, isValidBoardId } from '@kayospace/sync';
import type { SessionState } from './session';
import type { WorkspaceSettings } from './settings';
import { CloseIcon } from './icons';
import { SYNC_TEXT } from './Chips';

declare const __APP_VERSION__: string;

export function SettingsPanel({
  settings,
  state,
  onApply,
  onTouchDraws,
  onRotateWithFingers,
  onClose,
}: {
  settings: WorkspaceSettings;
  state: SessionState | null;
  onApply: (patch: Partial<WorkspaceSettings>) => void;
  onTouchDraws: (on: boolean) => void;
  onRotateWithFingers: (on: boolean) => void;
  onClose: () => void;
}) {
  const [board, setBoard] = useState(settings.board);
  const [hubUrl, setHubUrl] = useState(settings.hubUrl);
  const [hubToken, setHubToken] = useState(settings.hubToken);
  const [syncOn, setSyncOn] = useState(settings.syncOn);

  const boardOk = isValidBoardId(board.trim());
  const urlOk = !syncOn || hubSyncUrl(hubUrl, boardOk ? board.trim() : 'x') !== null;
  const changed =
    board.trim() !== settings.board ||
    hubUrl.trim() !== settings.hubUrl ||
    hubToken.trim() !== settings.hubToken ||
    syncOn !== settings.syncOn;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!boardOk || !urlOk) return;
    onApply({ board: board.trim(), hubUrl: hubUrl.trim(), hubToken: hubToken.trim(), syncOn });
  };

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
        <label className="check">
          <input type="checkbox" checked={syncOn} onChange={(e) => setSyncOn(e.target.checked)} />
          <span>Синхронизировать через хаб</span>
        </label>
        <label className="field">
          <span>Адрес хаба</span>
          <input
            value={hubUrl}
            onChange={(e) => setHubUrl(e.target.value)}
            placeholder="например, 1-2-3-4.sslip.io:8443"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            disabled={!syncOn}
          />
          {!urlOk && <small className="bad">Адрес не похож на адрес хаба.</small>}
        </label>
        <label className="field">
          <span>Токен</span>
          <input
            type="password"
            value={hubToken}
            onChange={(e) => setHubToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={!syncOn}
          />
          <small>Хранится только на этом устройстве.</small>
        </label>
        <div className="row">
          <button type="submit" className="primary" disabled={!changed || !boardOk || !urlOk}>
            Применить
          </button>
          {state && <span className="muted">{SYNC_TEXT[state.sync] ?? state.sync}</span>}
        </div>
      </form>
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
      <hr />
      <dl className="keys">
        <dt>Сдвиг</dt>
        <dd>два пальца, колесо, пробел + мышь</dd>
        <dt>Масштаб</dt>
        <dd>щипок, Ctrl/⌘ + колесо</dd>
        <dt>Поворот</dt>
        <dd>холст — двумя пальцами, Shift [ и ]; элемент — круглая ручка над рамкой</dd>
        <dt>Инструменты</dt>
        <dd>V выделение · P перо · E ластик · N стикер · T текст · H рука</dd>
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
        <dd>Ctrl/⌘ C, X, V, D (копия рядом), Delete, стрелки</dd>
        <dt>Вид</dt>
        <dd>Shift 1 — всё, Shift 0 — 100%</dd>
      </dl>
      <p className="muted version">Kayospace {__APP_VERSION__}</p>
    </aside>
  );
}
