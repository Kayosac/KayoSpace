// Собирает Pen Lab в один HTML-файл (CSS и JS внутри) — открыть где угодно без сервера.
//   node scripts/build-single.mjs             → dist-single/pen-lab.html (обычная страница)
//   node scripts/build-single.mjs --artifact  → dist-single/pen-lab.artifact.html (без doctype/head — для публикации)
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-single');
const artifact = process.argv.includes('--artifact');

const result = await build({
  entryPoints: [join(root, 'src/main.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  minify: true,
  outdir: 'out',
  logLevel: 'warning',
});

const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const title = 'Kayospace Pen Lab';
const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';

const body = `<div id="app"></div>\n<script type="module">${safeJs}</script>`;

const html = artifact
  ? `<title>${title}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>${css}</style>\n${body}\n`
  : `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">\n<title>${title}</title>\n${fonts}\n<style>${css}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

mkdirSync(out, { recursive: true });
const file = join(out, artifact ? 'pen-lab.artifact.html' : 'pen-lab.html');
writeFileSync(file, html);
console.log(`${file} — ${(html.length / 1024).toFixed(1)} КБ`);
