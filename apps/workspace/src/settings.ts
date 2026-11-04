/** Настройки приложения: хранятся только на этом устройстве (localStorage). */

import type { Camera, ShapeKind, Tool } from '@kayospace/canvas';
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
  tool: Tool;
  /** null — цвет чернил темы. */
  color: string | null;
  size: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize: number;
  shapeKind: ShapeKind;
  stickyColor: string;
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
  tool: 'pen',
  color: null,
  size: 3,
  eraserSize: 28,
  shapeKind: 'rect',
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
    if (!['select', 'pen', 'eraser', 'hand', 'sticky', 'text', 'shape'].includes(s.tool))
      s.tool = 'pen';
    if (!['rect', 'ellipse', 'line', 'arrow'].includes(s.shapeKind)) s.shapeKind = 'rect';
    if (!Array.isArray(s.recentBoards)) s.recentBoards = [];
    s.recentBoards = s.recentBoards.filter((b) => b && typeof b.id === 'string');
    if (!(typeof s.size === 'number' && s.size > 0 && s.size <= 64)) s.size = defaultSettings.size;
    if (!(typeof s.eraserSize === 'number' && s.eraserSize >= 4 && s.eraserSize <= 200)) {
      s.eraserSize = defaultSettings.eraserSize;
    }
    if (typeof s.board !== 'string' || !s.board) s.board = defaultSettings.board;
    return s;
  } catch {
    return { ...defaultSettings };
  }
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
