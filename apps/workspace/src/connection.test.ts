import { describe, expect, it } from 'vitest';
import { Connection } from './connection';
import { resolveDevHub } from './config';
import { detectPlatform, lastSeenText, normalizeCode, parseConnectLink } from './devices';
import { HUB_TOKEN_KEY, MemorySecretStore } from './secrets';
import { defaultSettings, type WorkspaceSettings } from './settings';

const DEVICE_TOKEN = `kd_0123456789abcdef_${'A'.repeat(43)}`;

/** Поддельный хаб: отвечает на /api/devices/claim и /api/devices/register. */
function fakeHub(
  handlers: Record<string, (body: unknown, auth: string | null) => [number, unknown]>,
) {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    calls.push({ path: url.pathname, body, auth });
    const h = handlers[url.pathname];
    if (!h) throw new TypeError('Failed to fetch');
    const [status, json] = h(body, auth);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { f, calls };
}

function setup(
  settings: Partial<WorkspaceSettings>,
  f: typeof fetch,
  opts: { devHub?: string | null; secrets?: MemorySecretStore } = {},
) {
  let saved: WorkspaceSettings = { ...defaultSettings, ...settings };
  const secrets = opts.secrets ?? new MemorySecretStore();
  const c = new Connection({
    secrets,
    settings: saved,
    updateSettings: (p) => (saved = { ...saved, ...p }),
    fetch: f,
    devHub: opts.devHub ?? null,
    tauri: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710)',
  });
  return { c, secrets, saved: () => saved };
}

describe('подключение устройства', () => {
  it('по коду: токен уходит в хранилище секретов, а не в настройки', async () => {
    const hub = fakeHub({
      '/api/devices/claim': (body) => {
        expect(body).toEqual({ code: '123456', name: 'Планшет', platform: 'android' });
        return [200, { token: DEVICE_TOKEN, device: { id: '0123456789abcdef' } }];
      },
    });
    const { c, secrets, saved } = setup({}, hub.f);
    await c.init();
    expect(c.getState()).toMatchObject({ loading: false, hub: null });
    await c.connect('hub.example.com:8443', '123456', 'Планшет');
    expect(secrets.data.get(HUB_TOKEN_KEY)).toBe(DEVICE_TOKEN);
    expect(saved()).toMatchObject({ hubUrl: 'hub.example.com:8443', syncOn: true, hubToken: '' });
    expect(JSON.stringify(saved())).not.toContain(DEVICE_TOKEN);
    expect(c.getState().hub).toEqual({ url: 'hub.example.com:8443', token: DEVICE_TOKEN });
  });

  it('неверный код — понятная ошибка, ничего не сохраняется', async () => {
    const hub = fakeHub({
      '/api/devices/claim': () => [400, { error: 'Код не подошёл или истёк. Попросите новый.' }],
    });
    const { c, secrets } = setup({}, hub.f);
    await c.init();
    await expect(c.connect('hub.example.com', '000000', 'X')).rejects.toThrow('не подошёл');
    expect(secrets.data.size).toBe(0);
    expect(c.getState().hub).toBeNull();
  });

  it('после перезапуска токен читается из хранилища', async () => {
    const secrets = new MemorySecretStore();
    secrets.data.set(HUB_TOKEN_KEY, DEVICE_TOKEN);
    const { c } = setup({ hubUrl: 'hub.example.com', syncOn: true }, fakeHub({}).f, { secrets });
    expect(c.getState().loading).toBe(true);
    await c.init();
    expect(c.getState().hub?.token).toBe(DEVICE_TOKEN);
  });

  it('отключили на хабе: токен стирается, экран подключения с причиной', async () => {
    const secrets = new MemorySecretStore();
    secrets.data.set(HUB_TOKEN_KEY, DEVICE_TOKEN);
    const { c } = setup({ hubUrl: 'hub.example.com', syncOn: true }, fakeHub({}).f, { secrets });
    await c.init();
    await c.markRevoked();
    expect(secrets.data.has(HUB_TOKEN_KEY)).toBe(false);
    expect(c.getState()).toMatchObject({ hub: null, revoked: true });
  });
});

describe('переход со старого общего токена', () => {
  it('HUB_TOKEN из настроек меняется на свой токен устройства и стирается', async () => {
    const hub = fakeHub({
      '/api/devices/register': (_b, auth) => {
        expect(auth).toBe('Bearer old-shared');
        return [200, { token: DEVICE_TOKEN, device: { id: '0123456789abcdef' } }];
      },
    });
    const { c, secrets, saved } = setup(
      { hubUrl: 'hub.example.com', hubToken: 'old-shared', syncOn: true },
      hub.f,
    );
    await c.init();
    expect(secrets.data.get(HUB_TOKEN_KEY)).toBe(DEVICE_TOKEN);
    expect(saved().hubToken).toBe('');
    expect(c.getState().hub?.token).toBe(DEVICE_TOKEN);
  });

  it('хаб не принял старый токен — подключать заново', async () => {
    const hub = fakeHub({ '/api/devices/register': () => [401, { error: 'нет' }] });
    const { c, saved } = setup(
      { hubUrl: 'hub.example.com', hubToken: 'wrong', syncOn: true },
      hub.f,
    );
    await c.init();
    expect(saved().hubToken).toBe('');
    expect(c.getState()).toMatchObject({ hub: null, revoked: true });
  });

  it('хаб недоступен или старый — пока работаем по старому токену', async () => {
    for (const hub of [fakeHub({}), fakeHub({ '/api/devices/register': () => [404, {}] })]) {
      const { c, saved } = setup(
        { hubUrl: 'hub.example.com', hubToken: 'old-shared', syncOn: true },
        hub.f,
      );
      await c.init();
      expect(c.getState().hub?.token).toBe('old-shared');
      expect(saved().hubToken).toBe('old-shared'); // обменяем при следующем запуске
    }
  });
});

describe('режим разработки', () => {
  it('подключается к локальному хабу сразу, без токена и экрана подключения', async () => {
    const { c } = setup({}, fakeHub({}).f, { devHub: 'http://127.0.0.1:4000' });
    expect(c.getState()).toMatchObject({
      loading: false,
      dev: true,
      hub: { url: 'http://127.0.0.1:4000', token: '' },
    });
    await c.init();
    await c.markRevoked(); // в разработке «отключить» нечего
    expect(c.getState().hub?.url).toBe('http://127.0.0.1:4000');
  });

  it('хаб разработки — только в DEV и только локальный адрес', () => {
    expect(resolveDevHub({ DEV: true, VITE_DEV_HUB: 'http://127.0.0.1:4000' })).toBe(
      'http://127.0.0.1:4000',
    );
    expect(resolveDevHub({ DEV: false, VITE_DEV_HUB: 'http://127.0.0.1:4000' })).toBeNull();
    expect(resolveDevHub({ DEV: true, VITE_DEV_HUB: 'https://hub.example.com' })).toBeNull();
    expect(resolveDevHub({ DEV: true })).toBeNull();
  });
});

describe('ссылки и коды', () => {
  it('kayospace://connect несёт адрес хаба и код', () => {
    const link = `kayospace://connect?hub=${encodeURIComponent('https://1-2-3-4.sslip.io:8443')}&code=042517`;
    expect(parseConnectLink(link)).toEqual({
      hub: 'https://1-2-3-4.sslip.io:8443',
      code: '042517',
    });
    // На некоторых платформах «connect» приходит путём.
    expect(parseConnectLink('kayospace:///connect?hub=192.168.1.10:4000&code=111222')).toEqual({
      hub: '192.168.1.10:4000',
      code: '111222',
    });
    expect(parseConnectLink('kayospace://connect?hub=x.sslip.io')?.code).toBeNull();
    expect(parseConnectLink('https://evil.example.com/connect?hub=x&code=123456')).toBeNull();
    expect(parseConnectLink('kayospace://other?hub=x.sslip.io&code=123456')).toBeNull();
    expect(parseConnectLink('kayospace://connect?code=123456')).toBeNull();
    expect(parseConnectLink('не ссылка')).toBeNull();
  });

  it('код: 6 цифр, пробел и дефис допустимы', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
  });

  it('платформа по User-Agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', true)).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', true)).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14)', true)).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (Macintosh)', false)).toBe('browser');
  });

  it('последний вход по-человечески', () => {
    const now = new Date(2026, 10, 4, 21, 50).getTime();
    expect(lastSeenText(now - 30_000, now)).toBe('только что');
    expect(lastSeenText(now - 15 * 60_000, now)).toBe('15 мин назад');
    expect(lastSeenText(new Date(2026, 10, 4, 9, 5).getTime(), now)).toBe('сегодня в 09:05');
    expect(lastSeenText(new Date(2026, 10, 3, 20, 0).getTime(), now)).toBe('вчера в 20:00');
    expect(lastSeenText(new Date(2026, 9, 1).getTime(), now)).toBe('1 октября');
  });
});
