import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// При `tauri android dev` Tauri передаёт адрес компьютера в TAURI_DEV_HOST,
// чтобы планшет мог достучаться до дев-сервера по сети.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Относительные пути — чтобы сборка открывалась и из Tauri, и как файл.
  base: './',
  clearScreen: false,
  // JSX без плагина: esbuild сам преобразует TSX (быстрое обновление React пока не нужно).
  esbuild: { jsx: 'automatic' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5180,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5181 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  preview: { port: 4174, strictPort: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
