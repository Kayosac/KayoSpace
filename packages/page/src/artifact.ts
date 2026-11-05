/**
 * Артефакты на доске (решение 0023): то, что Claude делает в чате артефактом, — HTML-страница,
 * рисунок SVG, схема Mermaid или код — живёт документом «ar_…» рядом с досками и документами.
 * Синхронизация, хранение, проекты, удаление и история — те же. Содержимое — Map «artifact»:
 * kind, lang (язык кода), source — Y.Text исходника.
 */

import * as Y from 'yjs';

export const ARTIFACT_FIELD = 'artifact';
export const ARTIFACT_PREFIX = 'ar_';
export const isArtifactId = (id: string): boolean => id.startsWith(ARTIFACT_PREFIX);

export function artifactIdFrom(boardLikeId: string): string {
  return `${ARTIFACT_PREFIX}${boardLikeId}`.slice(0, 64);
}

export type ArtifactKind = 'html' | 'svg' | 'mermaid' | 'code';

export const ARTIFACT_KINDS: readonly {
  kind: ArtifactKind;
  name: string;
  ext: string;
  mime: string;
}[] = [
  { kind: 'html', name: 'HTML-страница', ext: 'html', mime: 'text/html' },
  { kind: 'svg', name: 'Рисунок SVG', ext: 'svg', mime: 'image/svg+xml' },
  { kind: 'mermaid', name: 'Схема Mermaid', ext: 'mmd', mime: 'text/plain' },
  { kind: 'code', name: 'Код', ext: 'txt', mime: 'text/plain' },
];

/** Расширения файлов для частых языков кода; иначе — сам язык, если он похож на расширение. */
const LANG_EXT: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  kotlin: 'kt',
  markdown: 'md',
  shell: 'sh',
  bash: 'sh',
  yaml: 'yml',
  csharp: 'cs',
  'c#': 'cs',
  'c++': 'cpp',
};

/** Расширение файла исходника: у кода — по языку. */
export function artifactExt(a: Pick<Artifact, 'kind' | 'lang'>): string {
  if (a.kind === 'code' && a.lang) {
    const l = a.lang.toLowerCase();
    if (LANG_EXT[l]) return LANG_EXT[l];
    if (/^[a-z0-9]{1,8}$/.test(l)) return l;
  }
  return ARTIFACT_KINDS.find((k) => k.kind === a.kind)?.ext ?? 'txt';
}

export interface Artifact {
  kind: ArtifactKind;
  /** Язык кода (для kind «code»): python, ts, json… */
  lang?: string;
  source: string;
}

export function readArtifact(doc: Y.Doc): Artifact | null {
  const m = doc.getMap(ARTIFACT_FIELD);
  const kind = m.get('kind') as ArtifactKind | undefined;
  if (!kind) return null;
  const text = m.get('source');
  const lang = m.get('lang') as string | undefined;
  return {
    kind,
    ...(lang ? { lang } : {}),
    source: text instanceof Y.Text ? text.toString() : String(text ?? ''),
  };
}

/** Записать артефакт: исходник заменяется целиком (история версий — у документа). */
export function writeArtifact(doc: Y.Doc, a: Artifact, origin?: unknown): void {
  doc.transact(() => {
    const m = doc.getMap(ARTIFACT_FIELD);
    m.set('kind', a.kind);
    if (a.lang) m.set('lang', a.lang);
    else m.delete('lang');
    let text = m.get('source');
    if (!(text instanceof Y.Text)) {
      text = new Y.Text();
      m.set('source', text);
    }
    const t = text as Y.Text;
    if (t.toString() === a.source) return;
    t.delete(0, t.length);
    t.insert(0, a.source);
  }, origin);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
};

/** Видимый текст HTML: без скриптов, стилей и тегов — для поиска и карточки. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Текст артефакта для поиска: видимый текст страницы или исходник. */
export function artifactText(a: Artifact): string {
  if (a.kind === 'html') return htmlText(a.source);
  if (a.kind === 'svg') return htmlText(a.source.replace(/<\/?(text|tspan|title)[^>]*>/gi, ' '));
  return a.source;
}

export function artifactExcerpt(a: Artifact | null, maxChars = 200): string {
  if (!a) return 'Пустой артефакт';
  const kind = ARTIFACT_KINDS.find((k) => k.kind === a.kind)?.name ?? 'Артефакт';
  const text = artifactText(a)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  const head = a.kind === 'code' && a.lang ? `${kind} · ${a.lang}` : kind;
  const s = text ? `${head}\n${text}` : head;
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

const escHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/**
 * Страница для просмотра артефакта в изолированном окне: HTML — как есть, SVG — по центру,
 * Mermaid — со скриптом Mermaid, код — моноширинным текстом.
 */
export function artifactHtml(a: Artifact): string {
  const shell = (body: string, head = ''): string =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>html,body{margin:0;background:#fff;color:#1c1f26;font:15px system-ui,sans-serif}</style>${head}</head><body>${body}</body></html>`;
  switch (a.kind) {
    case 'html':
      return /<html[\s>]|<!doctype/i.test(a.source) ? a.source : shell(a.source);
    case 'svg':
      return shell(
        `<div style="display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box">${a.source.replace(/<svg\b/, '<svg style="max-width:100%;height:auto"')}</div>`,
      );
    case 'mermaid':
      return shell(
        `<pre class="mermaid" style="margin:24px">${escHtml(a.source)}</pre>`,
        '<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:true});</script>',
      );
    default:
      return shell(
        `<pre style="margin:0;padding:20px;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere">${escHtml(a.source)}</pre>`,
      );
  }
}
