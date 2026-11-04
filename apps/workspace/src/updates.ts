/**
 * Обновления приложения (решение 0011).
 *
 *   - Компьютер (macOS, Windows): модуль обновлений Tauri. Он читает latest.json из последнего
 *     релиза на GitHub, проверяет подпись ключом владельца, ставит обновление и перезапускает приложение.
 *   - Android: тихо заменить себя приложение не может — узнаём версию последнего релиза через API GitHub
 *     и предлагаем скачать APK; установку подтверждает система.
 *   - Браузер: обновляется вместе со страницей, проверять нечего.
 */

export const RELEASES_API = 'https://api.github.com/repos/Kayosac/KayoSpace/releases/latest';

export interface AppUpdate {
  version: string;
  notes: string | null;
  /** desktop — ставится в приложении; android — скачать APK в браузере. */
  kind: 'desktop' | 'android';
  /** Скачать и поставить (desktop) или открыть ссылку на APK (android). */
  install(onProgress?: (fraction: number | null) => void): Promise<void>;
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);
const isAndroid = (): boolean =>
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** Обновления есть только в приложении. */
export function updatesSupported(): boolean {
  return isTauri();
}

/** Версия a новее b (1.2.10 > 1.2.9; «v» в начале не мешает). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

interface GithubRelease {
  tag_name: string;
  body?: string | null;
  assets: { name: string; browser_download_url: string }[];
}

/** APK из релиза, если версия новее установленной. */
export function androidUpdateFrom(
  release: GithubRelease,
  current: string,
): { version: string; url: string; notes: string | null } | null {
  const version = release.tag_name.replace(/^v/, '');
  if (!isNewer(version, current)) return null;
  const apk = release.assets.find((a) => a.name.endsWith('.apk'));
  if (!apk) return null;
  return { version, url: apk.browser_download_url, notes: release.body?.trim() || null };
}

/** Есть ли версия новее. null — нет (или проверять нечего). Ошибки сети — исключением. */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!isTauri()) return null;
  if (isAndroid()) {
    const { getVersion } = await import('@tauri-apps/api/app');
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) return null; // релизов ещё нет
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    const found = androidUpdateFrom((await res.json()) as GithubRelease, await getVersion());
    if (!found) return null;
    return {
      version: found.version,
      notes: found.notes,
      kind: 'android',
      async install() {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(found.url);
      },
    };
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body?.trim() || null,
    kind: 'desktop',
    async install(onProgress) {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          onProgress?.(total > 0 ? done / total : null);
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
