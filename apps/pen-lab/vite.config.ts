import { defineConfig } from 'vite';

// При `tauri android dev` Tauri передаёт адрес компьютера в TAURI_DEV_HOST,
// чтобы планшет мог достучаться до дев-сервера по сети.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Относительные пути — чтобы сборка открывалась и из Tauri, и как файл.
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
