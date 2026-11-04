/**
 * Окружение приложения.
 *
 *   - VITE_DEFAULT_HUB — адрес хаба по умолчанию на экране подключения. Задаётся при сборке
 *     (в GitHub Actions — переменная репозитория KAYOSPACE_DEFAULT_HUB), в коде его нет.
 *   - VITE_DEV_HUB — локальный хаб разработки. Его задаёт `pnpm dev` (scripts/dev.mjs).
 *     Действует только в режиме разработки: в сборке `import.meta.env.DEV` — false, и Vite вырезает ветку целиком.
 */

/** Хаб разработки: только при `vite` (DEV) и только локальный адрес. */
export function resolveDevHub(env: { DEV: boolean; VITE_DEV_HUB?: string }): string | null {
  if (!env.DEV) return null;
  const url = env.VITE_DEV_HUB?.trim();
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? url : null;
  } catch {
    return null;
  }
}

// Обе проверки статические: в сборке (`vite build`, режим production) ветка вырезается целиком.
export const DEV_HUB: string | null =
  import.meta.env.DEV && import.meta.env.MODE !== 'production'
    ? resolveDevHub({ DEV: true, VITE_DEV_HUB: import.meta.env.VITE_DEV_HUB })
    : null;

export const DEFAULT_HUB: string = (import.meta.env.VITE_DEFAULT_HUB ?? '').trim();

/**
 * Префикс локальных хранилищ. В режиме разработки — свой, чтобы доски и настройки локального хаба
 * не смешивались с настоящими (у дев-сервера тот же адрес localhost:5180).
 */
export const STORAGE_NS: string = DEV_HUB ? 'kayospace.dev' : 'kayospace';
