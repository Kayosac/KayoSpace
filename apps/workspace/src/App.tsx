import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasEngine, type EngineState } from '@kayospace/canvas';
import type { Actor } from '@kayospace/model';
import { BoardSession, type SessionState } from './session';
import {
  loadCamera,
  loadSettings,
  saveCamera,
  saveSettings,
  type WorkspaceSettings,
} from './settings';
import { Toolbar } from './Toolbar';
import { SettingsPanel } from './SettingsPanel';
import { SyncChip, ZoomControls } from './Chips';

declare global {
  interface Window {
    /** Для отладки и e2e-тестов. */
    __kayospace?: { engine: CanvasEngine; session: BoardSession };
    __TAURI_INTERNALS__?: unknown;
  }
}

const actor: Actor = {
  kind: 'human',
  name: 'kayos',
  device: typeof window !== 'undefined' && window.__TAURI_INTERNALS__ ? 'app' : 'browser',
};

function useStore<T>(
  store: { subscribe(cb: () => void): () => void; getState(): T } | null,
): T | null {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  );
  const get = useCallback(() => (store ? store.getState() : null), [store]);
  return useSyncExternalStore(subscribe, get);
}

export function App() {
  const [settings, setSettings] = useState<WorkspaceSettings>(loadSettings);
  const [session, setSession] = useState<BoardSession | null>(null);
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const update = useCallback((patch: Partial<WorkspaceSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // Доска: пересоздаётся при смене доски или подключения к хабу.
  const { board, syncOn, hubUrl, hubToken } = settings;
  useEffect(() => {
    const s = new BoardSession(
      board,
      syncOn && hubUrl.trim() ? { url: hubUrl, token: hubToken } : null,
    );
    setSession(s);
    return () => {
      setSession(null);
      s.destroy();
    };
  }, [board, syncOn, hubUrl, hubToken]);

  // Холст для открытой доски.
  useEffect(() => {
    const host = stageRef.current;
    if (!session || !host) return;
    const s = settingsRef.current;
    const e = new CanvasEngine(host, session.doc, {
      actor,
      camera: loadCamera(session.board),
      tool: s.tool,
      color: s.color,
      size: s.size,
      eraserSize: s.eraserSize,
      touchDraws: s.touchDraws,
    });
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const stopCamera = e.onCamera((c) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveCamera(session.board, c), 300);
    });
    // Новая на этом устройстве доска: когда загрузится, показать всё содержимое.
    const fitWhenLoaded = (): void => {
      if (session.getState().loaded && e.cameraIsDefault && e.scene.size > 0) e.zoomToFit();
    };
    const stopSession = session.subscribe(fitWhenLoaded);
    fitWhenLoaded();
    setEngine(e);
    window.__kayospace = { engine: e, session };
    return () => {
      clearTimeout(saveTimer);
      saveCamera(session.board, e.getCamera());
      stopCamera();
      stopSession();
      setEngine(null);
      e.destroy();
    };
  }, [session]);

  const engineState = useStore<EngineState>(engine);
  const sessionState = useStore<SessionState>(session);

  // Инструмент, цвет и толщину запоминаем (их можно сменить и с клавиатуры).
  useEffect(() => {
    if (!engineState) return;
    const s = settingsRef.current;
    if (
      s.tool !== engineState.tool ||
      s.color !== engineState.color ||
      s.size !== engineState.size ||
      s.eraserSize !== engineState.eraserSize
    ) {
      update({
        tool: engineState.tool,
        color: engineState.color,
        size: engineState.size,
        eraserSize: engineState.eraserSize,
      });
    }
  }, [engineState, update]);

  // Вернулись в приложение (после сна, из фона) — переподключиться сразу, не дожидаясь паузы.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') session?.reconnect();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [session]);

  return (
    <div className="app">
      <div className="stage" ref={stageRef} data-testid="stage" />
      <header className="top top-left">
        <SyncChip board={board} state={sessionState} onClick={() => setPanelOpen((v) => !v)} />
      </header>
      <div className="top top-right">
        {engine && engineState && <ZoomControls engine={engine} zoom={engineState.zoom} />}
      </div>
      {engine && engineState && (
        <Toolbar engine={engine} state={engineState} onSettings={() => setPanelOpen((v) => !v)} />
      )}
      {sessionState && !sessionState.loaded && <div className="loading">Открываю доску…</div>}
      {panelOpen && (
        <SettingsPanel
          settings={settings}
          state={sessionState}
          onApply={(patch) => update(patch)}
          onTouchDraws={(on) => {
            update({ touchDraws: on });
            engine?.setTouchDraws(on);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}
