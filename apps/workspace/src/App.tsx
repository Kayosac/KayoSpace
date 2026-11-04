import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasEngine, type EngineState } from '@kayospace/canvas';
import type { Actor } from '@kayospace/model';
import { BoardSession, type SessionState } from './session';
import {
  loadCamera,
  loadSettings,
  saveCamera,
  saveSettings,
  touchRecent,
  pushRecentColor,
  type WorkspaceSettings,
} from './settings';
import { BoardsPanel } from './BoardsPanel';
import { AssetStore, imageFiles } from './assets';
import { NoteEditor } from './NoteEditor';
import { lowLatencyInk, releaseFieldFocus } from './touch';
import { UpdateBanner, useUpdates } from './UpdateBanner';
import { Toolbar } from './Toolbar';
import { SettingsPanel } from './SettingsPanel';
import { SyncChip, ZoomControls } from './Chips';
import { Minimap } from './Minimap';
import { fileName, saveFile } from './save';
import { useWorkspace } from './projects';
import { addProject, removeProject, renameProject, setBoardProject } from '@kayospace/board';
import type { ExportTarget } from '@kayospace/canvas';
import { SelectionMenu } from './SelectionMenu';
import { AiController, type AiAction, type AiState } from './ai';
import { AiBar } from './AiBar';
import { Connection, type ConnectionState } from './connection';
import { ConnectScreen, type ConnectReason } from './ConnectScreen';
import { parseConnectLink } from './devices';
import { DEFAULT_HUB } from './config';
import { createSecretStore } from './secrets';
import {
  INBOX_BOARD,
  INBOX_NAME,
  sharedFiles,
  sharedText,
  takeShared,
  type SharedPayload,
} from './share';

declare global {
  interface Window {
    /** Для отладки и e2e-тестов. */
    __kayospace?: { engine: CanvasEngine; session: BoardSession };
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Картинки — одно хранилище на всё приложение (общее для досок). */
const assets = new AssetStore();

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

const actor: Actor = {
  kind: 'human',
  name: 'kayos',
  device: isTauri ? 'app' : 'browser',
};

/** Экран подключения: почему открыт и что подставить. */
interface ConnectUi {
  reason: ConnectReason;
  hub?: string;
  code?: string | null;
}

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
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Сообщение внизу экрана; ms = 0 — пока не заменят другим. */
  const showToast = useCallback((text: string | null, ms = 4000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(text);
    if (text && ms > 0) toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  const ai = useMemo(() => new AiController(), []);
  const [aiPrompt, setAiPrompt] = useState(false);
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

  // Подключение к хабу: адрес — в настройках, токен устройства — в хранилище ОС.
  const connection = useMemo(
    () =>
      new Connection({
        secrets: createSecretStore(),
        settings: settingsRef.current,
        updateSettings: update,
        tauri: isTauri,
      }),
    [update],
  );
  const conn = useStore<ConnectionState>(connection)!;
  const [connectUi, setConnectUi] = useState<ConnectUi | null>(null);
  useEffect(() => {
    void connection.init();
  }, [connection]);
  useEffect(() => {
    connection.settingsChanged(settings);
  }, [connection, settings]);

  // Первый запуск сборки с адресом хаба по умолчанию — сразу предложить подключиться.
  const firstRun = useRef(true);
  useEffect(() => {
    if (conn.loading || !firstRun.current) return;
    firstRun.current = false;
    const s = settingsRef.current;
    if (!conn.hub && !conn.dev && !s.connectSkipped && DEFAULT_HUB) {
      setConnectUi((c) => c ?? { reason: 'first' });
    }
  }, [conn.loading, conn.hub, conn.dev]);

  // Устройство отключили на хабе (или старый ключ больше не подходит) — подключать заново.
  useEffect(() => {
    if (conn.revoked) setConnectUi({ reason: 'revoked' });
  }, [conn.revoked]);

  // Ссылка kayospace://connect?hub=…&code=… — из QR системной камерой или из другого приложения.
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    const handle = (urls: string[] | null): void => {
      for (const u of urls ?? []) {
        const link = parseConnectLink(u);
        if (!link) continue;
        // Уже подключено — не переподключаем молча, а показываем экран с подставленным кодом.
        const reason: ConnectReason = connection.getState().hub ? 'manual' : 'link';
        setConnectUi({ reason, hub: link.hub, code: link.code });
        return;
      }
    };
    void (async () => {
      const dl = await import('@tauri-apps/plugin-deep-link');
      handle(await dl.getCurrent());
      const unlisten = await dl.onOpenUrl(handle);
      if (cancelled) unlisten();
      else off = unlisten;
    })().catch((err: unknown) => console.warn('[kayospace] ссылки kayospace:// недоступны', err));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [connection]);

  const hub = conn.hub;
  const hubUrl = hub?.url ?? '';
  const hubToken = hub?.token ?? '';
  // Проекты и то, в каком проекте какая доска.
  const workspace = useWorkspace(hubUrl ? { url: hubUrl, token: hubToken } : null);
  const wsDoc = workspace.session?.doc ?? null;

  // Доска: пересоздаётся при смене доски или подключения к хабу.
  const { board } = settings;
  useEffect(() => {
    const s = new BoardSession(board, hubUrl ? { url: hubUrl, token: hubToken } : null);
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
  }, [board, hubUrl, hubToken]);

  const updates = useUpdates();
  const lowLatency = lowLatencyInk(settings.lowLatencyInk);
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
      penKind: s.penKind,
      penStyles: s.penStyles,
      stickyColor: s.stickyColor,
      touchDraws: s.touchDraws,
      rotateWithFingers: s.rotateWithFingers,
      assets,
      lowLatency,
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
    // Режим канвы задаётся при создании: смена настройки пересоздаёт холст.
  }, [session, lowLatency]);

  const engineState = useStore<EngineState>(engine);
  const sessionState = useStore<SessionState>(session);

  // Хаб закрыл соединение кодом «не пускаю» — токен этого устройства больше не действует.
  const syncNow = sessionState?.sync;
  useEffect(() => {
    if (syncNow === 'unauthorized') void connection.markRevoked();
  }, [syncNow, connection]);

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
      s.penKind !== engineState.penKind ||
      s.stickyColor !== engineState.stickyColor
    ) {
      update({
        tool: engineState.tool,
        color: engineState.color,
        size: engineState.size,
        eraserSize: engineState.eraserSize,
        shapeKind: engineState.shapeKind,
        penKind: engineState.penKind,
        stickyColor: engineState.stickyColor,
        penStyles: engine?.getPenStyles() ?? s.penStyles,
      });
    }
  }, [engineState, update, engine]);

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
      // Новая доска — в выбранный в списке проект.
      const project = settingsRef.current.project;
      if (isNew && project && wsDoc) setBoardProject(wsDoc, id, project);
      engine?.finishEditing(null);
      const s = settingsRef.current;
      update({ board: id, recentBoards: touchRecent(s.recentBoards, id, name) });
      setPanel(null);
    },
    [engine, update, wsDoc],
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
    assets.setHub(hubUrl ? { url: hubUrl, token: hubToken } : null);
  }, [hubUrl, hubToken]);
  const syncState = sessionState?.sync;
  useEffect(() => {
    if (syncState === 'synced') void assets.uploadPending();
  }, [syncState]);

  // ИИ ходит на тот же хаб.
  useEffect(() => {
    ai.setHub(hubUrl ? { url: hubUrl, token: hubToken } : null);
  }, [ai, hubUrl, hubToken]);
  useEffect(() => () => ai.destroy(), [ai]);
  const aiState = useStore<AiState>(ai);
  // Результат готов — предпросмотр на холсте; результат убрали — убрать и предпросмотр.
  useEffect(() => {
    engine?.setAiPreview(aiState?.kind === 'ready' ? aiState.draft : null);
  }, [engine, aiState]);
  // Сменили доску — задача прошлой доски больше не нужна.
  useEffect(() => () => ai.cancel(), [ai, board]);

  /** Сохранить доску, фрейм или выделенное в PNG, доску — в PDF (по странице на фрейм). */
  const exportTo = useCallback(
    async (target: ExportTarget | 'pdf') => {
      if (!engine) return;
      const title = boardName ?? board;
      showToast('Готовлю файл…', 0);
      try {
        let saved: boolean;
        if (target === 'pdf') {
          const pdf = await engine.exportPdf(title);
          if (!pdf) throw new Error('На доске пока ничего нет');
          saved = await saveFile(pdf, fileName(title, 'pdf'), 'application/pdf');
        } else {
          const png = await engine.exportPng(target);
          if (!png) throw new Error('Нечего сохранять');
          const frameName =
            typeof target === 'object'
              ? engine.getFrames().find((f) => f.id === target.frame)?.name
              : undefined;
          const name =
            target === 'selection'
              ? `${title} — выделенное`
              : frameName
                ? `${title} — ${frameName}`
                : title;
          saved = await saveFile(png, fileName(name, 'png'), 'image/png');
        }
        showToast(saved ? 'Файл сохранён' : null, 2500);
      } catch (e) {
        showToast(e instanceof Error ? `Не сохранилось: ${e.message}` : 'Не сохранилось');
      }
    },
    [engine, board, boardName, showToast],
  );

  /** Почему ИИ недоступен (null — доступен). */
  const aiBlocked: string | null = !hubUrl
    ? 'ИИ работает через хаб: подключите устройство к хабу в настройках'
    : null;

  const runAi = useCallback(
    async (action: AiAction, prompt?: string) => {
      if (!engine || !session) return;
      setAiPrompt(false);
      const sync = session.getState().sync;
      if (sync !== 'synced') {
        ai.fail(
          sync === 'connecting' || sync === 'connected'
            ? 'Доска ещё синхронизируется с хабом — попробуйте через пару секунд.'
            : 'Нет связи с хабом — ИИ работает через него.',
        );
        return;
      }
      const selection = engine.getSelection();
      const area = engine.getSelectionBounds() ?? engine.visibleBounds();
      const ink = selection.some((id) => {
        const type = engine.scene.items.get(id)?.element.type;
        return (
          type === 'stroke' ||
          type === 'image' ||
          engine.scene
            .childrenOf(id)
            .some((c) => engine.scene.items.get(c)?.element.type === 'stroke')
        );
      });
      // Картинку выделенного видит ИИ: для распознавания всегда, для своего запроса — если есть рисунки.
      const image =
        action === 'recognize' || (action === 'prompt' && ink) ? await engine.exportImage() : null;
      await ai.start({
        board,
        action,
        ...(prompt ? { prompt } : {}),
        selection,
        area,
        image,
      });
    },
    [ai, engine, session, board],
  );

  // Ctrl/⌘ J — свой запрос к ИИ.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyJ') {
        e.preventDefault();
        setAiPrompt((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedCount = engineState?.selected ?? 0;
  const aiScope =
    selectedCount > 0 ? `про выделенное (${selectedCount})` : 'про видимую часть доски';

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
          showToast(e instanceof Error ? e.message : 'Картинку не удалось вставить');
        }
      }
    },
    [engine],
  );

  // Буфер обмена (Ctrl/⌘ C, X, V): элементы доски, текст и картинки из других программ.
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      if (!engine || typing(e.target) || engine.getState().selected === 0) return;
      e.preventDefault();
      const text = engine.copySelection();
      if (text) e.clipboardData?.setData('text/plain', text);
      if (cut) engine.deleteSelection();
    };
    const copy = (e: ClipboardEvent): void => onCopy(e, false);
    const cut = (e: ClipboardEvent): void => onCopy(e, true);
    const onPaste = (e: ClipboardEvent): void => {
      if (!engine || typing(e.target)) return;
      e.preventDefault();
      const files = imageFiles(e.clipboardData?.files);
      if (files.length > 0) {
        void insertImages(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      // Если там наш же текст, скопированный с доски, — вставляем сами элементы.
      if (engine.isOwnClipboardText(text) || (!text.trim() && engine.getState().canPaste)) {
        engine.paste();
      } else if (text.trim()) {
        engine.insertText(text);
      }
    };
    window.addEventListener('copy', copy);
    window.addEventListener('cut', cut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', copy);
      window.removeEventListener('cut', cut);
      window.removeEventListener('paste', onPaste);
    };
  }, [engine, insertImages]);

  // Переход к найденному на другой доске: элемент показываем, когда доска откроется
  // (или придёт с хаба, если на этом устройстве её ещё не было).
  const pendingFocus = useRef<{ board: string; id: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p || !engine || p.board !== board || !(sessionState?.loaded ?? false)) return;
    if (engine.focusElement(p.id)) pendingFocus.current = null;
  }, [engine, board, sessionState, focusTick]);
  const searchLocal = useCallback((q: string) => engine?.searchText(q) ?? [], [engine]);

  // «Поделиться» → Kayospace (Android): присланное ложится на доску «Входящие».
  const pendingShare = useRef<SharedPayload | null>(null);
  const [shareTick, setShareTick] = useState(0);
  useEffect(() => {
    const check = async (): Promise<void> => {
      const p = await takeShared();
      if (!p) return;
      pendingShare.current = p;
      if (settingsRef.current.board !== INBOX_BOARD) openBoard(INBOX_BOARD, INBOX_NAME, false);
      setShareTick((t) => t + 1);
    };
    void check();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [openBoard]);
  const boardLoaded = sessionState?.loaded ?? false;
  useEffect(() => {
    const p = pendingShare.current;
    if (!p || !engine || !session || board !== INBOX_BOARD || !boardLoaded) return;
    pendingShare.current = null;
    if (!boardName) session.rename(INBOX_NAME);
    void (async () => {
      const text = sharedText(p);
      if (text) {
        const id = engine.insertText(text);
        if (id) engine.stackBelow(id);
      }
      for (const file of sharedFiles(p)) {
        try {
          const img = await assets.add(file);
          const id = engine.insertImage(
            img.assetId,
            { w: img.width, h: img.height },
            { blob: img.blob, alt: file.name },
          );
          engine.stackBelow(id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Картинку не удалось вставить');
        }
      }
      // Меню выделения закрыло бы только что присланное.
      engine.clearSelection();
    })();
  }, [engine, session, board, boardLoaded, boardName, shareTick, showToast]);

  /** Кнопка «Вставить» (планшет без клавиатуры): системный буфер, если доступен, иначе — свой. */
  const pasteFromButton = useCallback(async () => {
    if (!engine) return;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/') && t !== 'image/svg+xml');
        if (type) {
          const blob = await item.getType(type);
          await insertImages([new File([blob], 'Картинка из буфера', { type })]);
          return;
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          if (engine.isOwnClipboardText(text)) engine.paste();
          else if (!engine.insertText(text) && engine.getState().canPaste) engine.paste();
          return;
        }
      }
    } catch {
      /* системный буфер недоступен (нет разрешения) — вставляем своё */
    }
    if (engine.getState().canPaste) engine.paste();
  }, [engine, insertImages]);

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
        onPointerDownCapture={releaseFieldFocus}
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
      <UpdateBanner updates={updates} />
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
          <ZoomControls
            engine={engine}
            zoom={engineState.zoom}
            rotation={engineState.rotation}
            minimap={settings.minimap}
            onMinimap={() => update({ minimap: !settings.minimap })}
          />
        )}
        {engine && settings.minimap && <Minimap engine={engine} />}
      </div>
      {engine && engineState && (
        <SelectionMenu
          engine={engine}
          state={engineState}
          ai={aiBlocked}
          onAi={(a) => void runAi(a)}
          onAiPrompt={() => setAiPrompt(true)}
          onExport={(t) => void exportTo(t)}
        />
      )}
      {aiState && (
        <AiBar
          state={aiState}
          promptOpen={aiPrompt && !aiBlocked}
          scope={aiScope}
          onPrompt={(text) => void runAi('prompt', text)}
          onClosePrompt={() => setAiPrompt(false)}
          onApply={() => {
            engine?.applyAiPreview();
            ai.cancel();
          }}
          onDiscard={() => ai.cancel()}
        />
      )}
      {aiPrompt && aiBlocked && aiState?.kind === 'idle' && (
        <div className="ai-bar error" role="alert" data-testid="ai-bar">
          <span className="ai-text">{aiBlocked}.</span>
          <button onClick={() => setAiPrompt(false)}>Закрыть</button>
        </div>
      )}
      {engine && engineState && <NoteEditor engine={engine} state={engineState} />}
      {engine && engineState && (
        <Toolbar
          engine={engine}
          state={engineState}
          onSettings={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}
          onImages={(files) => void insertImages(files)}
          onPaste={() => void pasteFromButton()}
          onAi={() => setAiPrompt((p) => !p)}
          aiOn={aiPrompt || (aiState?.kind ?? 'idle') !== 'idle'}
          recentColors={settings.recentColors}
          onRecentColor={(c) =>
            update({ recentColors: pushRecentColor(settingsRef.current.recentColors, c) })
          }
        />
      )}
      {sessionState && !sessionState.loaded && <div className="loading">Открываю доску…</div>}
      {panel === 'boards' && (
        <BoardsPanel
          current={board}
          currentName={boardName}
          recent={settings.recentBoards}
          hub={hubUrl ? { url: hubUrl, token: hubToken } : null}
          onOpen={openBoard}
          onRename={(n) => session?.rename(n)}
          frames={engine?.getFrames() ?? []}
          onFrame={(id) => {
            engine?.goToFrame(id);
            setPanel(null);
          }}
          onExport={(t) => void exportTo(t)}
          projects={workspace.projects}
          membership={workspace.membership}
          project={
            settings.project && workspace.projects.some((p) => p.id === settings.project)
              ? settings.project
              : null
          }
          onProject={(id) => update({ project: id })}
          onCreateProject={(name) => {
            if (!wsDoc) return;
            const id = addProject(wsDoc, name);
            update({ project: id });
          }}
          onRenameProject={(id, name) => wsDoc && renameProject(wsDoc, id, name)}
          onDeleteProject={(id) => {
            if (wsDoc) removeProject(wsDoc, id);
            update({ project: null });
          }}
          onMoveBoard={(project) => wsDoc && setBoardProject(wsDoc, board, project)}
          background={engineState?.background ?? 'dots'}
          onBackground={(bg) => engine?.setBackground(bg)}
          searchLocal={searchLocal}
          onFind={(id, elementId, name) => {
            setPanel(null);
            if (id === board && engine?.focusElement(elementId)) return;
            pendingFocus.current = { board: id, id: elementId };
            if (id !== board) openBoard(id, name, false);
            else setFocusTick((t) => t + 1);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          state={sessionState}
          connection={conn}
          onApply={(patch) => update(patch)}
          onConnect={() => {
            setPanel(null);
            setConnectUi({ reason: 'manual' });
          }}
          onSelfRevoked={() => {
            setPanel(null);
            void connection.forget();
          }}
          onTouchDraws={(on) => {
            update({ touchDraws: on });
            engine?.setTouchDraws(on);
          }}
          onRotateWithFingers={(on) => {
            update({ rotateWithFingers: on });
            engine?.setRotateWithFingers(on);
          }}
          lowLatency={lowLatency}
          onLowLatency={(on) => update({ lowLatencyInk: on })}
          onOpenBoard={(id, name) => openBoard(id, name, false)}
          updates={updates}
          onClose={() => setPanel(null)}
        />
      )}
      {connectUi && !conn.dev && (
        <ConnectScreen
          key={`${connectUi.reason}:${connectUi.hub ?? ''}:${connectUi.code ?? ''}`}
          connection={connection}
          reason={connectUi.reason}
          initialHub={connectUi.hub ?? (settings.hubUrl || DEFAULT_HUB)}
          initialCode={connectUi.code ?? null}
          onDone={() => {
            setConnectUi(null);
            update({ connectSkipped: false });
          }}
          onSkip={() => {
            if (connectUi.reason === 'first') update({ connectSkipped: true });
            setConnectUi(null);
          }}
        />
      )}
    </div>
  );
}
