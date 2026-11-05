/**
 * Схема страницы-документа (решение 0020): одна и та же у редактора в приложении и у хаба
 * (агенты читают и пишут страницы markdown'ом). Блоки — заголовки, абзацы, списки, чек-листы,
 * цитаты, код, разделитель и фрагмент доски.
 */

import { Node, getSchema, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';

/** Фрагмент доски в документе: фрейм (или вся доска) картинкой; касание — открыть доску. */
export const BoardEmbed = Node.create({
  name: 'boardEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      board: { default: '' },
      frame: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-board-embed]',
        getAttrs: (el) => ({
          board: (el as HTMLElement).getAttribute('data-board') ?? '',
          frame: (el as HTMLElement).getAttribute('data-frame'),
          title: (el as HTMLElement).getAttribute('data-title'),
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-board-embed': '',
        'data-board': node.attrs.board,
        ...(node.attrs.frame ? { 'data-frame': node.attrs.frame } : {}),
        ...(node.attrs.title ? { 'data-title': node.attrs.title } : {}),
      }),
      node.attrs.title ?? node.attrs.board,
    ];
  },
});

/**
 * Расширения редактора (без своей отмены — её даёт синхронизация Yjs). embed — фрагмент доски
 * с отображением (у приложения своё, с картинкой); extra — что добавить (синхронизация, подсказка).
 */
export function pageExtensions(
  opts: { embed?: AnyExtension; extra?: AnyExtension[] } = {},
): AnyExtension[] {
  return [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Markdown без потерь (решение 0023): таблицы и картинки как в .md.
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: true }),
    opts.embed ?? BoardEmbed,
    ...(opts.extra ?? []),
  ];
}

let cached: ReturnType<typeof getSchema> | null = null;

/** Схема ProseMirror страницы — для хаба (без редактора и DOM). */
export function pageSchema(): ReturnType<typeof getSchema> {
  cached ??= getSchema(pageExtensions());
  return cached;
}
