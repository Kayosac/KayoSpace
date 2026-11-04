import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

/** Сборка приложения во временную папку с заданными переменными окружения; весь JS — одной строкой. */
async function buildWith(env: Record<string, string>): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'kayospace-build-'));
  const saved = { ...process.env };
  // Vitest ставит NODE_ENV=test, а с ним Vite собирает как для разработки. Настоящая сборка — production.
  Object.assign(process.env, { NODE_ENV: 'production' }, env);
  try {
    await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('..', import.meta.url)),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
    const dir = join(out, 'assets');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
    const parts = await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')));
    return parts.join('\n');
  } finally {
    process.env = saved;
    await rm(out, { recursive: true, force: true });
  }
}

describe('сборка', () => {
  it('режима разработки в сборке нет, даже если VITE_DEV_HUB задан; адрес по умолчанию — есть', async () => {
    const js = await buildWith({
      VITE_DEV_HUB: 'http://127.0.0.1:4999',
      VITE_DEFAULT_HUB: 'hub-default.example.test:8443',
    });
    // Сравниваем флаги, а не текст: при ошибке не выводить весь бандл.
    expect({
      devHub: js.includes('127.0.0.1:4999'),
      devStorage: js.includes('kayospace.dev') || js.includes('kayospace-dev'),
      defaultHub: js.includes('hub-default.example.test:8443'),
    }).toEqual({ devHub: false, devStorage: false, defaultHub: true });
  }, 120_000);
});
