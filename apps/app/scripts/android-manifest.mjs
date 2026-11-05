// Фильтры активности Android: «Поделиться» → Kayospace и ссылки kayospace:// (решения 0010, 0013).
//
// Плагины дописывают их в AndroidManifest.xml из своих build.rs — но только когда build.rs запускается.
// С кэшем сборки (решение 0013) он не запускается, а gen/android каждый раз создаётся заново
// (`tauri android init`), и Kayospace пропадал из списка «Поделиться». Поэтому CI дописывает фильтры сам,
// теми же блоками, что и плагины: если build.rs всё же запустится, он заменит блок, а не задублирует.
//
// node android-manifest.mjs <путь к gen/android>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');

/** Фильтры «Поделиться» — из build.rs плагина share-target (один источник). */
export function shareFilters(buildRs) {
  const m = /const INTENT_FILTERS: &str = r#"([\s\S]*?)"#;/.exec(buildRs);
  if (!m) throw new Error('нет INTENT_FILTERS в build.rs share-target');
  return m[1];
}

/** Фильтры ссылок — как у tauri-plugin-deep-link для `plugins.deep-link.mobile`. */
export function deepLinkFilters(conf) {
  const mobile = conf.plugins?.['deep-link']?.mobile ?? [];
  return mobile
    .map((d) => {
      const schemes = [d.scheme ?? []].flat();
      const data = [
        ...schemes.map((s) => `<data android:scheme="${s}" />`),
        ...(d.host ? [`<data android:host="${d.host}" />`] : []),
      ];
      return [
        `<intent-filter${d.appLink ? ' android:autoVerify="true"' : ''}>`,
        '    <action android:name="android.intent.action.VIEW" />',
        '    <category android:name="android.intent.category.DEFAULT" />',
        '    <category android:name="android.intent.category.BROWSABLE" />',
        ...data.map((l) => `    ${l}`),
        '</intent-filter>',
      ].join('\n');
    })
    .join('\n');
}

const comment = (id) => `<!-- ${id}. AUTO-GENERATED. DO NOT REMOVE. -->`;

/** Вставить блок перед </activity> (как tauri-utils insert_into_xml): старый блок с тем же id заменяется. */
export function insertBlock(xml, id, contents) {
  const mark = comment(id);
  const out = [];
  let inBlock = false;
  let inserted = false;
  for (const line of xml.split('\n')) {
    if (line.includes(mark)) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) continue;
    const at = line.indexOf('</activity>');
    if (at >= 0 && !inserted) {
      const pad = ' '.repeat(at + 4);
      out.push(pad + mark, ...contents.split('\n').map((l) => pad + l), pad + mark);
      inserted = true;
    }
    out.push(line);
  }
  if (!inserted) throw new Error('нет </activity> в AndroidManifest.xml');
  return out.join('\n');
}

export function patchManifest(xml, { buildRs, conf }) {
  let out = insertBlock(xml, 'SHARE TARGET PLUGIN', shareFilters(buildRs));
  const links = deepLinkFilters(conf);
  if (links) out = insertBlock(out, 'DEEP LINK PLUGIN', links);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const project = process.argv[2];
  if (!project) {
    console.error('node android-manifest.mjs <gen/android>');
    process.exit(2);
  }
  const file = join(project, 'app', 'src', 'main', 'AndroidManifest.xml');
  const out = patchManifest(readFileSync(file, 'utf8'), {
    buildRs: readFileSync(join(tauriDir, 'plugins', 'share-target', 'build.rs'), 'utf8'),
    conf: JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')),
  });
  writeFileSync(file, out);
  console.log('AndroidManifest.xml: фильтры «Поделиться» и kayospace:// на месте');
}
