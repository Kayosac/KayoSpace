/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  /** Адрес хаба по умолчанию на экране подключения (задаётся при сборке). */
  readonly VITE_DEFAULT_HUB?: string;
  /** Локальный хаб разработки — задаёт `pnpm dev`. */
  readonly VITE_DEV_HUB?: string;
}
