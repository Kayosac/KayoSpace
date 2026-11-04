/** Настройки приложения: хранятся только на этом устройстве (localStorage). */

import type { Camera, Tool } from '@kayospace/canvas';

export interface WorkspaceSettings {
  /** Адрес хаба, например x.sslip.io:8443 или 192.168.1.10:4000. */
  hubUrl: string;
  /** Токен доступа к хабу. */
  hubToken: string;
  board: string;
  /** Синхронизировать доску через хаб. */
  syncOn: boolean;
  /** Рисовать пальцем (иначе палец двигает холст). */
  touchDraws: boolean;
  tool: Tool;
  /** null — цвет чернил темы. */
  color: string | null;
  size: number;
  /** Диаметр ластика в экранных пикселях. */
  eraserSize: number;
}

export const defaultSettings: WorkspaceSettings = {
  hubUrl: '',
  hubToken: '',
  board: 'main',
  syncOn: false,
  touchDraws: false,
  tool: 'pen',
  color: null,
  size: 3,
  eraserSize: 28,
};

export const SETTINGS_KEY = 'kayospace.workspace.v1';
const CAMERA_KEY = 'kayospace.camera.v1:';

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
    if (!['select', 'pen', 'eraser', 'hand'].includes(s.tool)) s.tool = 'pen';
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
