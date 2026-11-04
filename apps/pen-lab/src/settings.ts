import type { PalmMode } from '@kayospace/ink';

export type RenderMode = 'raf' | 'immediate';

export interface Settings {
  palm: PalmMode;
  render: RenderMode;
  predicted: boolean;
  desync: boolean;
  rawUpdate: boolean;
  highlightPredicted: boolean;
  flash: boolean;
  size: number;
  thinning: number;
  streamline: number;
  /** Адрес хаба, например 192.168.1.10:4000. */
  hubUrl: string;
  board: string;
  /** Подключаться к хабу при запуске. */
  syncOn: boolean;
}

export const defaultSettings: Settings = {
  palm: 'auto',
  render: 'raf',
  predicted: true,
  desync: true,
  rawUpdate: true,
  highlightPredicted: false,
  flash: false,
  size: 4,
  thinning: 0.6,
  streamline: 0.25,
  hubUrl: '',
  board: 'pen-lab',
  syncOn: false,
};

const KEY = 'kayospace.penlab.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* хранилище недоступно — настройки живут до перезагрузки */
  }
}
