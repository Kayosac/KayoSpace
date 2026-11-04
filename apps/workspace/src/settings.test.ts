import { describe, expect, it } from 'vitest';
import {
  SETTINGS_KEY,
  defaultSettings,
  loadCamera,
  loadSettings,
  saveCamera,
  saveSettings,
  touchRecent,
  cleanPenStyles,
  pushRecentColor,
  type KeyValue,
} from './settings';

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('настройки', () => {
  it('без сохранённых — значения по умолчанию', () => {
    expect(loadSettings(memory())).toEqual(defaultSettings);
    expect(loadSettings(null)).toEqual(defaultSettings);
  });

  it('сохраняются и читаются', () => {
    const kv = memory();
    saveSettings({ ...defaultSettings, board: 'ideas', color: '#e5484d', size: 6 }, kv);
    const s = loadSettings(kv);
    expect(s.board).toBe('ideas');
    expect(s.color).toBe('#e5484d');
    expect(s.size).toBe(6);
  });

  it('испорченные значения заменяются безопасными', () => {
    const kv = memory();
    kv.setItem(SETTINGS_KEY, JSON.stringify({ tool: 'laser', size: -3, board: '' }));
    const s = loadSettings(kv);
    expect(s.tool).toBe('pen');
    expect(s.size).toBe(defaultSettings.size);
    expect(s.board).toBe('main');
    kv.setItem(SETTINGS_KEY, '{не json');
    expect(loadSettings(kv)).toEqual(defaultSettings);
  });

  it('вид доски хранится отдельно для каждой доски', () => {
    const kv = memory();
    saveCamera('a', { x: 10, y: -20, zoom: 2 }, kv);
    expect(loadCamera('a', kv)).toEqual({ x: 10, y: -20, zoom: 2 });
    expect(loadCamera('b', kv)).toBeNull();
    kv.setItem('kayospace.camera.v1:c', JSON.stringify({ x: 1, y: 2, zoom: 0 }));
    expect(loadCamera('c', kv)).toBeNull();
  });
});

describe('недавние доски', () => {
  it('свежая — первой, без повторов, название не теряется', () => {
    let list = touchRecent([], 'a', 'Альфа');
    list = touchRecent(list, 'b', null);
    list = touchRecent(list, 'a', null);
    expect(list).toEqual([
      { id: 'a', name: 'Альфа' },
      { id: 'b', name: null },
    ]);
    for (let i = 0; i < 40; i++) list = touchRecent(list, `x${i}`, null);
    expect(list).toHaveLength(30);
  });
});

describe('стили пера и недавние цвета', () => {
  it('из сохранённого берём только корректные стили', () => {
    expect(
      cleanPenStyles({
        pen: { color: null, size: 2 },
        marker: { color: '#FF0000', size: 6 },
        highlighter: { color: 'red', size: 6 },
        extra: { color: '#000000', size: 1 },
      }),
    ).toEqual({ pen: { color: null, size: 2 }, marker: { color: '#FF0000', size: 6 } });
    expect(cleanPenStyles('мусор')).toEqual({});
  });

  it('недавние: свежий — первым, без повторов, до 8', () => {
    const list = ['#111111', '#222222'];
    expect(pushRecentColor(list, '#222222')).toEqual(['#222222', '#111111']);
    const many = Array.from({ length: 10 }, (_, i) => `#00000${i}`);
    expect(pushRecentColor(many, '#abcdef')).toHaveLength(8);
  });
});
