import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasEngine, type EngineState } from '@kayospace/canvas';
import type { Actor } from '@kayospace/model';
import { BoardSession, forgetLocalBoard, type SessionState } from './session';
import { boardsToForget, pruneDeleted } from './boards';
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
import { TrashPanel } from './TrashPanel';
import { HistoryPanel } from './HistoryPanel';
import { TasksPanel } from './TasksPanel';
import { ChatPanel } from './ChatPanel';
import { KanbanView } from './KanbanView';
import { PageView } from './PageView';
import {
  ARTIFACT_KINDS,
  artifactExt,
  docKind,
  hasTable,
  initTable,
  isDocId,
  pageIdFrom,
  readArtifact,
  tableIdFrom,
} from '@kayospace/page';
import { TableView } from './TableView';
import { ArtifactView } from './ArtifactView';
import { onNotify } from './notify';
import { importMarkdown, isMarkdown, markdownFiles, markdownOf } from './md-import';
import { DocOverlay, DocMenu, useDocCards, type DocSummary } from './DocOverlay';
import { useHubFeatures } from './voice';
import { Presentation } from './Presentation';
import { AssetStore, imageFiles } from './assets';
import { isPdf, pdfFiles, pdfTitle, renderPdf, MAX_PDF_PAGES } from './pdf-import';
import { NoteEditor } from './NoteEditor';
import { finePointer, lowLatencyInk, releaseFieldFocus } from './touch';
import { UpdateBanner, useUpdates } from './UpdateBanner';
import { AgentBar } from './AgentBar';
import { Toolbar } from './Toolbar';
import { SettingsPanel } from './SettingsPanel';
import { SyncChip, ZoomControls } from './Chips';
import { Minimap } from './Minimap';
import { fileName, saveFile } from './save';
import { useWorkspace } from './projects';
import {
  addElements,
  listElements,
  templateElements,
  type TemplateId,
  addProject,
  markBoardDeleted,
  markBoardPurged,
  removeProject,
  renameProject,
  restorableBoards,
  restoreDeletedBoard,
  setBoardProject,
} from '@kayospace/board';
import { boardIdFromName, hubHttpUrl } from '@kayospace/sync';
import type { ExportTarget } from '@kayospace/canvas';
import { SelectionMenu } from './SelectionMenu';
import { AiController, type AiAction, type AiState } from './ai';
import { AiBar } from './AiBar';
import { Connection, type ConnectionState } from './connection';
import { ConnectScreen, type ConnectReason } from './ConnectScreen';
import { parseBoardLink, parseConnectLink } from './devices';
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
  const [panel, setPanel] = useState<
    'settings' | 'boards' | 'trash' | 'history' | 'tasks' | 'chat' | null
  >(null);
  // Презентация по фреймам (решение 0017).
  const [presenting, setPresenting] = useState(false);
  // Канбан задач поверх доски (решение 0020).
  const [kanban, setKanban] = useState(false);
  // Документ или таблица поверх доски (решение 0021); name — у только что созданного.
  const [overlay, setOverlay] = useState<{ id: string; name?: string } | null>(null);
  const openDocRef = useRef<(doc: string) => void>(() => {});
  openDocRef.current = (doc) => setOverlay({ id: doc });
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
  useEffect(() => onNotify((text, ms) => showToast(text, ms)), [showToast]);
  const ai = useMemo(() => new AiController(), []);
  const [aiPrompt, setAiPrompt] = useState(false);
  /** Название новой доски — запишем в неё, когда она откроется. */
  const pendingName = useRef<{ id: string; name: string; template?: TemplateId } | null>(null);
  // Новая доска из шаблона: показать разметку целиком, когда она ляжет.
  const [fitBoard, setFitBoard] = useState<string | null>(null);
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

  /** Открыть доску по ссылке kayospace://board/… (задаётся ниже, когда готов openBoard). */
  const openLinkRef = useRef<((board: string, element: string | null) => void) | null>(null);
  // Ссылка kayospace://connect?hub=…&code=… — из QR системной камерой или из другого приложения.
  // Ссылка kayospace://board/<id> — от агента: открыть доску.
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    const handle = (urls: string[] | null): void => {
      for (const u of urls ?? []) {
        const target = parseBoardLink(u);
        if (target) {
          openLinkRef.current?.(target.board, target.element);
          return;
        }
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
  // Документ (решение 0020) или таблица (решение 0021) — вместо холста их редактор.
  const mode = docKind(board);
  const isPage = mode === 'page';
  useEffect(() => {
    const s = new BoardSession(board, hubUrl ? { url: hubUrl, token: hubToken } : null);
    setSession(s);
    const pending = pendingName.current;
    const nameNewBoard = (): void => {
      if (pending?.id === board && s.getState().loaded) {
        if (!s.getState().name) s.rename(pending.name);
        // Новая таблица — с колонками «Название» и «Готово».
        if (docKind(board) === 'table' && !hasTable(s.doc))
          initTable(s.doc, undefined, 'kayospace:table-init');
        // Шаблон (решение 0017) — только в пустую доску; не своя правка: «Отменить» его не стирает.
        if (pending.template && listElements(s.doc).length === 0) {
          addElements(s.doc, templateElements(pending.template, actor), 'template');
          setFitBoard(board);
        }
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
    if (!session || !host || isDocId(session.board)) return;
    const s = settingsRef.current;
    const e = new CanvasEngine(host, session.doc, {
      actor,
      camera: loadCamera(session.board),
      tool: s.tool,
      color: s.color,
      size: s.size,
      eraserSize: s.eraserSize,
      shapeKind: s.shapeKind,
      fill: s.shapeFill,
      penKind: s.penKind,
      penStyles: s.penStyles,
      stickyColor: s.stickyColor,
      touchDraws: s.touchDraws,
      rotateWithFingers: s.rotateWithFingers,
      assets,
      lowLatency,
      onOpenDoc: (doc) => openDocRef.current(doc),
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
      s.shapeFill !== engineState.fill ||
      s.penKind !== engineState.penKind ||
      s.stickyColor !== engineState.stickyColor
    ) {
      update({
        tool: engineState.tool,
        color: engineState.color,
        size: engineState.size,
        eraserSize: engineState.eraserSize,
        shapeKind: engineState.shapeKind,
        shapeFill: engineState.fill,
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
    (id: string, name: string | null, isNew: boolean, template?: TemplateId) => {
      if (isNew && name) pendingName.current = { id, name, template };
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

  // Удалённые доски (решение 0016): пропадают из недавних; открытую — закрываем и открываем другую.
  // Стёртые насовсем — стираем и локальную копию.
  const deleted = workspace.deleted;
  const restorable = useMemo(() => (wsDoc ? restorableBoards(wsDoc) : []), [wsDoc, deleted]);
  const hubForPanels = useMemo(
    () => (hubUrl ? { url: hubUrl, token: hubToken } : null),
    [hubUrl, hubToken],
  );
  // Голос и генерация картинок — если на хабе есть ключ OpenAI (решение 0018).
  const features = useHubFeatures(hubForPanels);
  const forgotten = useRef(new Set<string>());
  useEffect(() => {
    if (deleted.size === 0) return;
    for (const id of boardsToForget(deleted)) {
      if (forgotten.current.has(id) || id === settingsRef.current.board) continue;
      forgotten.current.add(id);
      forgetLocalBoard(id);
    }
    const s = settingsRef.current;
    const recent = pruneDeleted(s.recentBoards, deleted);
    if (deleted.has(s.board)) {
      engine?.finishEditing(null);
      const next = recent[0];
      if (next) {
        update({ board: next.id, recentBoards: touchRecent(recent, next.id, next.name) });
      } else {
        const name = 'Новая доска';
        const id = boardIdFromName(name);
        pendingName.current = { id, name };
        update({ board: id, recentBoards: touchRecent(recent, id, name) });
      }
    } else if (recent.length !== s.recentBoards.length) {
      update({ recentBoards: recent });
    }
  }, [deleted, engine, update]);

  useEffect(() => {
    if (!engine || fitBoard !== board) return;
    engine.zoomToFit();
    setFitBoard(null);
  }, [engine, fitBoard, board]);

  // Ctrl/⌘ K — список досок.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault();
        setPanel((p) => (p === 'boards' ? null : 'boards'));
      } else if (e.key === 'F5' && engine && engine.getFrames().length > 0) {
        // F5 — презентация по фреймам (на сенсоре — кнопка «Показать» в списке досок).
        e.preventDefault();
        setPanel(null);
        setPresenting(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

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

  /**
   * Экспорт из списка (решение 0022): открытая доска — с устройства (работает и без сети),
   * остальное, а также документы и таблицы — картинкой или PDF с хаба.
   */
  const exportItem = useCallback(
    async (id: string, name: string | null, format: 'png' | 'pdf' | 'md' | 'src') => {
      if (id === board && engine && !isDocId(id))
        return exportTo(format === 'png' ? 'board' : 'pdf');
      // Открытый документ в .md — прямо с устройства (решение 0023).
      if (format === 'md' && id === board && session) {
        const saved = await saveFile(
          new TextEncoder().encode(markdownOf(session.doc, name ?? id)),
          fileName(name ?? id, 'md'),
          'text/markdown',
        );
        showToast(saved ? 'Файл сохранён' : null, 2500);
        return;
      }
      // Исходник открытого артефакта — тоже с устройства.
      const art = format === 'src' && id === board && session ? readArtifact(session.doc) : null;
      if (art) {
        const kind = ARTIFACT_KINDS.find((k) => k.kind === art.kind)!;
        const saved = await saveFile(
          new TextEncoder().encode(art.source),
          fileName(name ?? id, artifactExt(art)),
          kind.mime,
        );
        showToast(saved ? 'Файл сохранён' : null, 2500);
        return;
      }
      const base = hubForPanels ? hubHttpUrl(hubForPanels.url) : null;
      if (!base || !hubForPanels) {
        showToast('Экспорт неоткрытого — через хаб: подключите синхронизацию');
        return;
      }
      showToast('Готовлю файл…', 0);
      try {
        const path =
          format === 'png'
            ? `/api/render/${encodeURIComponent(id)}.png?max=2048`
            : `/api/export/${encodeURIComponent(id)}.${format}`;
        const r = await fetch(`${base}${path}`, {
          headers: hubForPanels.token ? { Authorization: `Bearer ${hubForPanels.token}` } : {},
        });
        if (r.status === 404) throw new Error('пусто или нет на хабе');
        if (!r.ok) throw new Error(`хаб ответил ${r.status}`);
        const title = name ?? id;
        // У исходника расширение — по виду артефакта, его называет хаб.
        const ext =
          format === 'src'
            ? (/\.([A-Za-z0-9]{1,8})$/.exec(
                decodeURIComponent(
                  /filename\*=UTF-8''([^;]+)/.exec(
                    r.headers.get('Content-Disposition') ?? '',
                  )?.[1] ?? '',
                ),
              )?.[1] ?? 'txt')
            : format;
        const saved = await saveFile(
          await r.blob(),
          fileName(title, ext),
          format === 'png'
            ? 'image/png'
            : format === 'md'
              ? 'text/markdown'
              : format === 'src'
                ? (r.headers.get('Content-Type')?.split(';')[0] ?? 'text/plain')
                : 'application/pdf',
        );
        showToast(saved ? 'Файл сохранён' : null, 2500);
      } catch (e) {
        showToast(e instanceof Error ? `Не сохранилось: ${e.message}` : 'Не сохранилось');
      }
    },
    [board, engine, exportTo, hubForPanels, showToast, session],
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
      // Картинку выделенного (или видимого) видит ИИ: для распознавания всегда, для своего запроса
      // и чата — если там есть рукописное или рисунки (решение 0020).
      const freeform = action === 'prompt' || action === 'chat';
      const image =
        action === 'recognize' ||
        (freeform && (ink || (selection.length === 0 && engine.hasInkIn(area))))
          ? await engine.exportImage()
          : null;
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

  // PDF — страницами во фреймах (решение 0017).
  const importPdf = useCallback(
    async (file: File) => {
      if (!engine) return;
      try {
        showToast('Открываю PDF…', 60_000);
        const { pages, total } = await renderPdf(file, (done, count) =>
          showToast(`PDF: страница ${done} из ${count}…`, 60_000),
        );
        const stored = [];
        for (const p of pages) {
          const img = await assets.add(p.blob);
          stored.push({ assetId: img.assetId, w: p.width, h: p.height, blob: img.blob });
        }
        engine.insertPages(pdfTitle(file.name), stored);
        showToast(
          total > pages.length
            ? `Добавлены первые ${MAX_PDF_PAGES} страниц из ${total}`
            : `PDF на доске: ${pages.length} стр. Пишите поверх пером`,
          5000,
        );
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'PDF не удалось открыть', 6000);
      }
    },
    [engine],
  );

  /** Файлы с кнопки, перетаскивания или буфера: картинки — картинками, PDF — страницами. */
  const boardLoaded = sessionState?.loaded ?? false;
  // Карточки документов на доске: название и начало текста — с хаба (решение 0021).
  const refreshDocCards = useDocCards(engine, hubForPanels, boardLoaded);
  const insertFiles = useCallback(
    async (files: File[], at?: { x: number; y: number }) => {
      const md = files.filter(isMarkdown);
      const images = files.filter((f) => !isPdf(f) && !isMarkdown(f));
      if (images.length) await insertImages(images, at);
      for (const f of files.filter(isPdf)) await importPdf(f);
      // .md — документом с карточкой на доске (решение 0023).
      let k = 0;
      for (const f of md) {
        if (!engine) break;
        showToast(`Документ из ${f.name}…`, 0);
        const id = pageIdFrom(boardIdFromName(f.name.replace(/\.(md|markdown)$/i, '')));
        try {
          const { title } = await importMarkdown(id, f, hubForPanels);
          const p = at ? { x: at.x + k * 30, y: at.y + k * 30 } : undefined;
          engine.insertDocCard(id, { title }, p);
          k++;
          showToast(`Документ «${title}» на доске`, 3000);
        } catch (e) {
          showToast(
            e instanceof Error ? `Не открылся ${f.name}: ${e.message}` : 'Не открылся файл',
          );
        }
      }
      if (md.length) refreshDocCards(2000);
    },
    [insertImages, importPdf, engine, hubForPanels, showToast, refreshDocCards],
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
      const files = [...imageFiles(e.clipboardData?.files), ...pdfFiles(e.clipboardData?.files)];
      if (files.length > 0) {
        void insertFiles(files);
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
  }, [engine, insertFiles]);

  // Переход к найденному на другой доске: элемент показываем, когда доска откроется
  // (или придёт с хаба, если на этом устройстве её ещё не было).
  const pendingFocus = useRef<{ board: string; id: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  /** Перейти к элементу (найденному поиском или задаче) — на этой доске или другой. */
  const findElement = useCallback(
    (id: string, elementId: string, name: string | null, close = true) => {
      if (close || id !== board) setPanel(null);
      // Документ: элементов нет — просто открыть.
      if (isDocId(id) || !elementId) {
        if (id !== board) openBoard(id, name, false);
        return;
      }
      if (id === board && engine?.focusElement(elementId)) return;
      pendingFocus.current = { board: id, id: elementId };
      if (id !== board) openBoard(id, name, false);
      else setFocusTick((t) => t + 1);
    },
    [board, engine, openBoard],
  );

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p || !engine || p.board !== board || !(sessionState?.loaded ?? false)) return;
    if (engine.focusElement(p.id)) pendingFocus.current = null;
  }, [engine, board, sessionState, focusTick]);
  const searchLocal = useCallback((q: string) => engine?.searchText(q) ?? [], [engine]);
  openLinkRef.current = (id, element) => {
    setPanel(null);
    if (element) pendingFocus.current = { board: id, id: element };
    if (id !== settingsRef.current.board) openBoard(id, null, false);
    else setFocusTick((t) => t + 1);
  };

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
  const overlayId = overlay?.id ?? null;
  const onDocSummary = useCallback(
    (sum: DocSummary) => {
      if (overlayId) engine?.refreshDocCards(overlayId, sum);
    },
    [engine, overlayId],
  );
  // Сменили доску — открытый поверх неё документ закрываем.
  useEffect(() => setOverlay(null), [board]);
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
        if (isPdf(file)) {
          await importPdf(file);
          continue;
        }
        if (isMarkdown(file)) {
          await insertFiles([file]);
          continue;
        }
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
  }, [
    engine,
    session,
    board,
    boardLoaded,
    boardName,
    shareTick,
    showToast,
    importPdf,
    insertFiles,
  ]);

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
    <div
      className={['app', presenting && 'presenting', mode && 'page-mode'].filter(Boolean).join(' ')}
    >
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
          const files = [
            ...imageFiles(e.dataTransfer.files),
            ...pdfFiles(e.dataTransfer.files),
            ...markdownFiles(e.dataTransfer.files),
          ];
          const r = e.currentTarget.getBoundingClientRect();
          if (files.length)
            void insertFiles(files, { x: e.clientX - r.left, y: e.clientY - r.top });
        }}
      />
      {dropping && <div className="drop-hint">Отпустите — картинка или PDF встанет сюда</div>}
      {toast && <div className="toast">{toast}</div>}
      <div className="top-center">
        <UpdateBanner updates={updates} />
        {engine && <AgentBar engine={engine} onToast={(t) => showToast(t, 6000)} />}
      </div>
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
          voiceHub={features.voice ? hubForPanels : null}
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
          onTasks={() => setPanel((p) => (p === 'tasks' ? null : 'tasks'))}
          onChat={() => setPanel((p) => (p === 'chat' ? null : 'chat'))}
          onImages={(files) => void insertFiles(files)}
          docMenu={(close) => (
            <DocMenu
              hub={hubForPanels}
              recent={settings.recentBoards}
              onNew={(kind) => {
                close();
                const name = kind === 'table' ? 'Новая таблица' : 'Новый документ';
                const id = (kind === 'table' ? tableIdFrom : pageIdFrom)(boardIdFromName(name));
                engine.insertDocCard(id, { title: name });
                setOverlay({ id, name });
              }}
              onExisting={(id, name) => {
                close();
                engine.insertDocCard(id, name ? { title: name } : {});
                refreshDocCards(300);
              }}
            />
          )}
          onPaste={() => void pasteFromButton()}
          onAi={() => setAiPrompt((p) => !p)}
          aiOn={aiPrompt || (aiState?.kind ?? 'idle') !== 'idle'}
          recentColors={settings.recentColors}
          onRecentColor={(c) =>
            update({ recentColors: pushRecentColor(settingsRef.current.recentColors, c) })
          }
        />
      )}
      {isPage && session && (
        <PageView
          key={session.board}
          session={session}
          name={boardName}
          hub={hubForPanels}
          boards={settings.recentBoards}
          onRename={(n) => session.rename(n)}
          onOpenBoard={(id, frame, title) => findElement(id, frame ?? '', title)}
        />
      )}
      {mode === 'artifact' && session && (
        <ArtifactView
          key={session.board}
          session={session}
          name={boardName}
          onRename={(n) => session.rename(n)}
        />
      )}
      {mode === 'table' && session && (
        <TableView
          key={session.board}
          session={session}
          name={boardName}
          onRename={(n) => session.rename(n)}
        />
      )}
      {overlay && (
        <DocOverlay
          key={overlay.id}
          id={overlay.id}
          hub={hubForPanels}
          boards={settings.recentBoards}
          {...(overlay.name ? { initialName: overlay.name } : {})}
          onSummary={onDocSummary}
          onClose={() => {
            setOverlay(null);
            // Миниатюру делает хаб — когда правки дойдут до него.
            refreshDocCards(1500);
          }}
          onOpenBoard={(id, frame, title) => findElement(id, frame ?? '', title)}
        />
      )}
      {sessionState && !sessionState.loaded && (
        <div className="loading">
          {isPage
            ? 'Открываю документ…'
            : mode === 'table'
              ? 'Открываю таблицу…'
              : 'Открываю доску…'}
        </div>
      )}
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
          deleted={deleted}
          trashBoards={restorable.length}
          onExportItem={(id, name, format) => void exportItem(id, name, format)}
          onDeleteItem={(id, name) => wsDoc && markBoardDeleted(wsDoc, id, name)}
          onTrash={() => setPanel('trash')}
          onHistory={() => setPanel('history')}
          onPresent={() => {
            setPanel(null);
            setPresenting(true);
          }}
          background={engineState?.background ?? 'dots'}
          onBackground={(bg) => engine?.setBackground(bg)}
          searchLocal={searchLocal}
          onFind={findElement}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'tasks' && (
        <TasksPanel
          hub={hubForPanels}
          board={board}
          boardName={boardName}
          doc={session?.doc ?? null}
          engine={engine}
          onFind={(id, elementId, name) => {
            // На планшете панель закрывает доску — после перехода прячем её; на компьютере оставляем.
            findElement(id, elementId, name, !finePointer());
          }}
          onKanban={() => {
            setPanel(null);
            setKanban(true);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'chat' && (
        <ChatPanel
          hub={hubForPanels}
          board={board}
          ai={aiState ?? { kind: 'idle' }}
          blocked={aiBlocked}
          voice={features.voice}
          onSend={(text) => void runAi('chat', text)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'history' && (
        <HistoryPanel
          hub={hubForPanels}
          board={board}
          boardName={boardName}
          onOpenBoard={(id, name) => openBoard(id, name, false)}
          onToast={(t) => showToast(t, 5000)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'trash' && (
        <TrashPanel
          hub={hubForPanels}
          current={board}
          deletedBoards={restorable}
          onRestoreBoard={(id, name) => {
            if (wsDoc && restoreDeletedBoard(wsDoc, id)) openBoard(id, name, false);
          }}
          onOpenBoard={(id, name) => openBoard(id, name, false)}
          onClearBoards={() => {
            if (!wsDoc) return;
            for (const d of restorable) markBoardPurged(wsDoc, d.id);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          connection={conn}
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
      {kanban && (
        <KanbanView
          hub={hubForPanels}
          board={board}
          boardName={boardName}
          doc={session?.doc ?? null}
          engine={engine}
          onOpen={(id, elementId, name) => {
            setKanban(false);
            findElement(id, elementId, name);
          }}
          onClose={() => setKanban(false)}
        />
      )}
      {presenting && engine && (
        <Presentation engine={engine} onClose={() => setPresenting(false)} />
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
