// Список версий для автообновления (решение 0011): latest.json из подписанных сборок релиза.
// node latest-json.mjs <папка со сборками> <тег, например v0.10.0> <owner/repo> > latest.json
//
// macOS — универсальная сборка (одна на ARM и Intel): Kayospace.app.tar.gz + .sig;
// Windows — установщик NSIS: *-setup.exe + .sig.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function latestJson(files, tag, repo, readSig = (p) => readFileSync(p, 'utf8')) {
  const url = (file) =>
    `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename(file))}`;
  const signed = (re) => {
    const file = files.find((f) => re.test(basename(f)) && files.includes(`${f}.sig`));
    return file ? { signature: readSig(`${file}.sig`).trim(), url: url(file) } : null;
  };
  const platforms = {};
  const mac = signed(/\.app\.tar\.gz$/);
  if (mac) {
    platforms['darwin-aarch64'] = mac;
    platforms['darwin-x86_64'] = mac;
  }
  const win = signed(/-setup\.exe$/);
  if (win) platforms['windows-x86_64'] = win;
  if (Object.keys(platforms).length === 0) throw new Error('нет подписанных сборок (*.sig)');
  return {
    version: tag.replace(/^v/, ''),
    notes: `Kayospace ${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo) {
    console.error('node latest-json.mjs <папка> <тег> <owner/repo>');
    process.exit(2);
  }
  console.log(JSON.stringify(latestJson(walk(dir), tag, repo), null, 2));
}
