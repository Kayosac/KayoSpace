/**
 * «В Claude» (решение 0023): документ, таблица или артефакт с доски — в новый чат Claude.
 * Открываем claude.ai с готовой просьбой забрать его через коннектор Kayospace
 * (read_page / read_table / read_artifact) и продолжить; ту же просьбу кладём в буфер обмена —
 * если ссылка не подставит текст, его можно вставить.
 */

import { docKind } from '@kayospace/page';
import { notify } from './notify';

const TOOL = { page: 'read_page', table: 'read_table', artifact: 'read_artifact' } as const;
const WHAT = { page: 'документ', table: 'таблицу', artifact: 'артефакт' } as const;

export function claudePrompt(id: string, title: string | null): string {
  const kind = docKind(id) ?? 'page';
  const name = title?.trim() ? `«${title.trim()}» ` : '';
  return (
    `Возьми с доски Kayospace ${WHAT[kind]} ${name}(${id}) — ${TOOL[kind]} — ` +
    `и покажи его артефактом: продолжим работу здесь. ` +
    `Когда скажу «обнови на доске», сохрани новую версию туда же, с тем же id.`
  );
}

export const claudeUrl = (prompt: string): string =>
  `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

export async function openInClaude(id: string, title: string | null): Promise<void> {
  const prompt = claudePrompt(id, title);
  const url = claudeUrl(prompt);
  // В браузере — сразу, пока касание ещё «свежее»: иначе окно заблокируют.
  const opening = isTauri()
    ? import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url))
    : new Promise<void>((done) => {
        window.open(url, '_blank', 'noopener');
        done();
      });
  let copied = false;
  try {
    await navigator.clipboard.writeText(prompt);
    copied = true;
  } catch {
    // Буфер недоступен — ссылка всё равно с текстом.
  }
  try {
    await opening;
    notify(copied ? 'Открываю Claude · просьба и в буфере обмена' : 'Открываю Claude');
  } catch {
    notify(
      copied
        ? 'Не открылся Claude — просьба в буфере обмена, вставь её в чат'
        : 'Не открылся Claude',
      5000,
    );
  }
}
