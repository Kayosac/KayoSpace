/** Настройки приложения: хранятся только на этом устройстве (localStorage). */

import type { Camera, PenStyle, ShapeKind, Tool } from '@kayospace/canvas';
import { isShapeType, type StrokeTool } from '@kayospace/model';
import { STORAGE_NS } from './config';

export interface WorkspaceSettings {
  /** Адрес хаба, например x.sslip.io:8443 или 192.168.1.10:4000. */
  hubUrl: string;
  /**
   * Устаревшее: общий токен хаба из старых версий. При запуске меняется на токен устройства
   * (хранится в хранилище ОС, не здесь) и стирается.
   */
  hubToken: string;
  board: string;
  /** Синхронизировать доску через хаб. */
  syncOn: boolean;
  /** Человек выбрал «Пока без хаба» — не показывать экран подключения при запуске. */
  connectSkipped: boolean;
  /** Рисовать пальцем (иначе палец двигает холст). */
  touchDraws: boolean;
  /** Поворачивать холст двумя пальцами. */
  rotateWithFingers: boolean;
  /** Канва низкой задержки для пера; null — само (включено на Android). */
  lowLatencyInk: boolean | null;
  tool: Tool;
  /** null — цвет чернил темы. */
  color: string | null;
  size: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize: number;
  shapeKind: ShapeKind;
  /** Заливка новых фигур; null — прозрачная (решение 0022). */
  shapeFill: string | null;
  /** Вид пера: ручка или выделитель (маркер убран — решение 0016; старые штрихи маркером остаются). */
  penKind: StrokeTool;
  /** Свои цвет и толщина у каждого вида пера (color и size выше — у того, что выбран сейчас). */
  penStyles: Partial<Record<StrokeTool, PenStyle>>;
  /** Свои цвета из палитры, свежие — первыми (до 8). */
  recentColors: string[];
  stickyColor: string;
  /** Показывать мини-карту. */
  minimap: boolean;
  /** Проект, выбранный в списке досок (null — все доски). */
  project: string | null;
  /** Недавние доски на этом устройстве (свежие — первыми). */
  recentBoards: RecentBoard[];
}

export interface RecentBoard {
  id: string;
  name: string | null;
}

/** Поднять доску наверх списка недавних (не больше 30). */
export function touchRecent(
  list: readonly RecentBoard[],
  id: string,
  name: string | null,
): RecentBoard[] {
  const prev = list.find((b) => b.id === id);
  const entry = { id, name: name ?? prev?.name ?? null };
  return [entry, ...list.filter((b) => b.id !== id)].slice(0, 30);
}

export const defaultSettings: WorkspaceSettings = {
  hubUrl: '',
  hubToken: '',
  board: 'main',
  syncOn: false,
  connectSkipped: false,
  touchDraws: false,
  rotateWithFingers: true,
  lowLatencyInk: null,
  tool: 'pen',
  color: null,
  size: 3,
  eraserSize: 28,
  shapeKind: 'rect',
  shapeFill: null,
  penKind: 'pen',
  penStyles: {},
  recentColors: [],
  minimap: true,
  project: null,
  stickyColor: '#ffe58a',
  recentBoards: [],
};

export const SETTINGS_KEY = `${STORAGE_NS}.workspace.v1`;
const CAMERA_KEY = `${STORAGE_NS}.camera.v1:`;

/** Хранилище: в тестах подменяется. Любая ошибка доступа — как будто хранилища нет. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const storage = (): KeyValue | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadSettings(kv: KeyValue | null = storage()): WorkspaceSettings {
  try {
    const raw = kv?.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<WorkspaceSettings>;
    const s = { ...defaultSettings, ...parsed };
    const kind: unknown = s.shapeKind;
    if (!(isShapeType(kind) || kind === 'line' || kind === 'arrow')) s.shapeKind = 'rect';
    if (s.shapeFill !== null && !/^#[0-9a-f]{3,8}$/i.test(String(s.shapeFill))) s.shapeFill = null;
    // Маркера в интерфейсе больше нет: выбранный когда-то маркер становится ручкой.
    if (!['pen', 'highlighter'].includes(s.penKind)) s.penKind = 'pen';
    if (!['select', 'pen', 'eraser', 'hand', 'sticky', 'text', 'shape', 'frame'].includes(s.tool)) {
      s.tool = 'pen';
    }
    if (!Array.isArray(s.recentBoards)) s.recentBoards = [];
    s.recentBoards = s.recentBoards.filter((b) => b && typeof b.id === 'string');
    if (!(typeof s.size === 'number' && s.size > 0 && s.size <= 64)) s.size = defaultSettings.size;
    if (!(typeof s.eraserSize === 'number' && s.eraserSize >= 4 && s.eraserSize <= 200)) {
      s.eraserSize = defaultSettings.eraserSize;
    }
    if (typeof s.board !== 'string' || !s.board) s.board = defaultSettings.board;
    if (typeof s.project !== 'string') s.project = null;
    s.penStyles = cleanPenStyles(s.penStyles);
    s.recentColors = Array.isArray(s.recentColors)
      ? s.recentColors.filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, 8)
      : [];
    return s;
  } catch {
    return { ...defaultSettings };
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Стили видов пера из сохранённых настроек: только корректные цвет и толщина. */
export function cleanPenStyles(v: unknown): Partial<Record<StrokeTool, PenStyle>> {
  const out: Partial<Record<StrokeTool, PenStyle>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const kind of ['pen', 'marker', 'highlighter'] as const) {
    const st = (v as Record<string, unknown>)[kind] as Partial<PenStyle> | undefined;
    if (!st || typeof st !== 'object') continue;
    const color = st.color === null || (typeof st.color === 'string' && HEX.test(st.color));
    const size = typeof st.size === 'number' && st.size > 0 && st.size <= 64;
    if (color && size) out[kind] = { color: st.color ?? null, size: st.size! };
  }
  return out;
}

/** Свой цвет — в начало списка недавних, без повторов, не больше 8. */
export function pushRecentColor(list: readonly string[], color: string): string[] {
  const c = color.toLowerCase();
  return [c, ...list.filter((x) => x.toLowerCase() !== c)].slice(0, 8);
}

export function saveSettings(s: WorkspaceSettings, kv: KeyValue | null = storage()): void {
  try {
    kv?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* хранилище недоступно — настройки живут до перезагрузки */
  }
}

/** Последний вид доски на этом устройстве. */
export function loadCamera(board: string, kv: KeyValue | null = storage()): Camera | null {
  try {
    const raw = kv?.getItem(CAMERA_KEY + board);
    if (!raw) return null;
    const c = JSON.parse(raw) as Camera;
    return Number.isFinite(c.x) && Number.isFinite(c.y) && c.zoom > 0 ? c : null;
  } catch {
    return null;
  }
}

export function saveCamera(board: string, c: Camera, kv: KeyValue | null = storage()): void {
  try {
    kv?.setItem(CAMERA_KEY + board, JSON.stringify({ x: c.x, y: c.y, zoom: c.zoom }));
  } catch {
    /* не страшно */
  }
}
