import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasEngine, type EngineState } from '@kayospace/canvas';
import type { Actor } from '@kayospace/model';
import { BoardSession, type SessionState } from './session';
import {
  loadCamera,
  loadSettings,
  saveCamera,
  saveSettings,
  touchRecent,
  type WorkspaceSettings,
} from './settings';
import { BoardsPanel } from './BoardsPanel';
import { AssetStore, imageFiles } from './assets';
import { NoteEditor } from './NoteEditor';
import { Toolbar } from './Toolbar';
import { SettingsPanel } from './SettingsPanel';
import { SyncChip, ZoomControls } from './Chips';
import { SelectionMenu } from './SelectionMenu';

declare global {
  interface Window {
    /** Для отладки и e2e-тестов. */
    __kayospace?: { engine: CanvasEngine; session: BoardSession };
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Картинки — одно хранилище на всё приложение (общее для досок). */
const assets = new AssetStore();

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
  const [panel, setPanel] = useState<'settings' | 'boards' | null>(null);
  const [dropping, setDropping] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Название новой доски — запишем в неё, когда она откроется. */
  const pendingName = useRef<{ id: string; name: string } | null>(null);
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
    const pending = pendingName.current;
    const nameNewBoard = (): void => {
      if (pending?.id === board && s.getState().loaded) {
        if (!s.getState().name) s.rename(pending.name);
        pendingName.current = null;
        stop();
      }
    };
    const stop = s.subscribe(nameNewBoard);
    nameNewBoard();
    return () => {
      stop();
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
      shapeKind: s.shapeKind,
      stickyColor: s.stickyColor,
      touchDraws: s.touchDraws,
      rotateWithFingers: s.rotateWithFingers,
      assets,
    });
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const stopCamera = e.onCamera((c) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveCamera(session.board, c), 300);
    });
    // Новая на этом устройстве доска: когда загрузится (или придёт с хаба), показать всё содержимое.
    // Один раз и только пока здесь ничего не делали — иначе вид прыгал бы, например, при переименовании.
    let fitted = false;
    const fitWhenLoaded = (): void => {
      if (fitted || !session.getState().loaded || !e.cameraIsDefault) return;
      if (e.getState().canUndo) {
        fitted = true;
        return;
      }
      if (e.scene.size > 0) {
        fitted = true;
        e.zoomToFit();
      }
    };
    // Состояние доски меняется при загрузке из IndexedDB и при «синхронизировано» — содержимое уже на месте.
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
      s.eraserSize !== engineState.eraserSize ||
      s.shapeKind !== engineState.shapeKind ||
      s.stickyColor !== engineState.stickyColor
    ) {
      update({
        tool: engineState.tool,
        color: engineState.color,
        size: engineState.size,
        eraserSize: engineState.eraserSize,
        shapeKind: engineState.shapeKind,
        stickyColor: engineState.stickyColor,
      });
    }
  }, [engineState, update]);

  // Недавние доски: открытая — наверх, с актуальным названием.
  const boardName = sessionState?.name ?? null;
  useEffect(() => {
    const s = settingsRef.current;
    const top = s.recentBoards[0];
    if (top?.id === s.board && (top.name === boardName || !boardName)) return;
    update({ recentBoards: touchRecent(s.recentBoards, s.board, boardName) });
  }, [board, boardName, update]);

  const openBoard = useCallback(
    (id: string, name: string | null, isNew: boolean) => {
      if (isNew && name) pendingName.current = { id, name };
      engine?.finishEditing(null);
      const s = settingsRef.current;
      update({ board: id, recentBoards: touchRecent(s.recentBoards, id, name) });
      setPanel(null);
    },
    [engine, update],
  );

  // Ctrl/⌘ K — список досок.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault();
        setPanel((p) => (p === 'boards' ? null : 'boards'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Картинки ходят на тот же хаб, что и доска; при «синхронизировано» — догрузить очередь.
  useEffect(() => {
    assets.setHub(syncOn && hubUrl.trim() ? { url: hubUrl, token: hubToken } : null);
  }, [syncOn, hubUrl, hubToken]);
  const syncState = sessionState?.sync;
  useEffect(() => {
    if (syncState === 'synced') void assets.uploadPending();
  }, [syncState]);

  const insertImages = useCallback(
    async (files: File[], at?: { x: number; y: number }) => {
      if (!engine) return;
      let offset = 0;
      for (const file of files) {
        try {
          const img = await assets.add(file);
          engine.insertImage(
            img.assetId,
            { w: img.width, h: img.height },
            {
              blob: img.blob,
              ...(at ? { at: { x: at.x + offset, y: at.y + offset } } : {}),
              alt: file.name,
            },
          );
          offset += 24;
        } catch (e) {
          setToast(e instanceof Error ? e.message : 'Картинку не удалось вставить');
          setTimeout(() => setToast(null), 4000);
        }
      }
    },
    [engine],
  );

  // Вставка из буфера обмена (Ctrl/⌘ V) и перетаскивание файлов на холст.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const files = imageFiles(e.clipboardData?.files);
      if (files.length === 0) return;
      e.preventDefault();
      void insertImages(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [insertImages]);

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
      <div
        className="stage"
        ref={stageRef}
        data-testid="stage"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          const files = imageFiles(e.dataTransfer.files);
          const r = e.currentTarget.getBoundingClientRect();
          if (files.length)
            void insertImages(files, { x: e.clientX - r.left, y: e.clientY - r.top });
        }}
      />
      {dropping && <div className="drop-hint">Отпустите — картинка встанет сюда</div>}
      {toast && <div className="toast">{toast}</div>}
      <header className="top top-left">
        <SyncChip
          board={board}
          name={boardName}
          state={sessionState}
          onClick={() => setPanel((p) => (p === 'boards' ? null : 'boards'))}
        />
      </header>
      <div className="top top-right">
        {engine && engineState && (
          <ZoomControls engine={engine} zoom={engineState.zoom} rotation={engineState.rotation} />
        )}
      </div>
      {engine && engineState && <SelectionMenu engine={engine} state={engineState} />}
      {engine && engineState && <NoteEditor engine={engine} state={engineState} />}
      {engine && engineState && (
        <Toolbar
          engine={engine}
          state={engineState}
          onSettings={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}
          onImages={(files) => void insertImages(files)}
        />
      )}
      {sessionState && !sessionState.loaded && <div className="loading">Открываю доску…</div>}
      {panel === 'boards' && (
        <BoardsPanel
          current={board}
          currentName={boardName}
          recent={settings.recentBoards}
          hub={syncOn && hubUrl.trim() ? { url: hubUrl, token: hubToken } : null}
          onOpen={openBoard}
          onRename={(n) => session?.rename(n)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          state={sessionState}
          onApply={(patch) => update(patch)}
          onTouchDraws={(on) => {
            update({ touchDraws: on });
            engine?.setTouchDraws(on);
          }}
          onRotateWithFingers={(on) => {
            update({ rotateWithFingers: on });
            engine?.setRotateWithFingers(on);
          }}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
