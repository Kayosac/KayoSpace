import { useEffect, useRef, useState } from 'react';
import { Editor, type ChainedCommands } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Placeholder } from '@tiptap/extensions';
import { BoardEmbed, PAGE_FIELD, pageExtensions } from '@kayospace/page';
import { hubHttpUrl } from '@kayospace/sync';
import type { BoardSession } from './session';
import type { Hub } from './devices';
import { CommitInput } from './CommitInput';
import { openInClaude } from './claude';
import { finePointer } from './touch';
import { CloseIcon } from './icons';

/** Картинка фрагмента доски с хаба (с токеном — поэтому не <img src>, а blob). */
async function embedImage(hub: Hub, board: string, frame: string | null): Promise<string> {
  const base = hubHttpUrl(hub.url);
  if (!base) throw new Error('нет адреса хаба');
  const q = new URLSearchParams({ max: '1400' });
  if (frame) q.set('frame', frame);
  const res = await fetch(`${base}/api/render/${encodeURIComponent(board)}.png?${q}`, {
    headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
  });
  if (res.status === 404)
    throw new Error(frame ? 'фрейма или доски больше нет' : 'доска пустая или её нет');
  if (!res.ok) throw new Error(`хаб ответил ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/** Фрагмент доски в документе: картинка с хаба, «Открыть» и «Убрать» — касанием. */
function embedExtension(
  hub: Hub | null,
  open: (board: string, frame: string | null, title: string | null) => void,
) {
  return BoardEmbed.extend({
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'page-embed';
        dom.contentEditable = 'false';
        dom.dataset.testid = 'page-embed';
        const pic = document.createElement('button');
        pic.className = 'page-embed-pic';
        pic.type = 'button';
        pic.setAttribute('aria-label', 'Открыть доску');
        const bar = document.createElement('div');
        bar.className = 'page-embed-bar';
        const title = document.createElement('span');
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'secondary';
        openBtn.textContent = 'Открыть';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-btn';
        remove.setAttribute('aria-label', 'Убрать фрагмент');
        remove.textContent = '×';
        bar.append(title, openBtn, remove);
        dom.append(pic, bar);

        let attrs = node.attrs as { board: string; frame: string | null; title: string | null };
        let url: string | null = null;
        let loaded = '';
        const show = (): void => {
          title.textContent = attrs.title ?? attrs.board;
          const key = `${attrs.board}#${attrs.frame ?? ''}`;
          if (key === loaded) return;
          loaded = key;
          pic.textContent = hub ? 'Загружаю…' : 'Картинка — когда есть связь с хабом';
          if (!hub) return;
          void embedImage(hub, attrs.board, attrs.frame).then(
            (u) => {
              if (loaded !== key) return URL.revokeObjectURL(u);
              if (url) URL.revokeObjectURL(url);
              url = u;
              const img = document.createElement('img');
              img.src = u;
              img.alt = attrs.title ?? attrs.board;
              pic.replaceChildren(img);
            },
            (e: unknown) => {
              if (loaded === key)
                pic.textContent =
                  e instanceof Error ? `Нет картинки: ${e.message}` : 'Нет картинки';
            },
          );
        };
        const go = (): void => open(attrs.board, attrs.frame, attrs.title);
        pic.addEventListener('click', go);
        openBtn.addEventListener('click', go);
        remove.addEventListener('click', () => {
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor
            .chain()
            .deleteRange({ from: pos, to: pos + node.nodeSize })
            .run();
        });
        show();
        return {
          dom,
          update: (next) => {
            if (next.type.name !== 'boardEmbed') return false;
            attrs = next.attrs as typeof attrs;
            show();
            return true;
          },
          stopEvent: () => true,
          ignoreMutation: () => true,
          destroy: () => {
            loaded = '';
            if (url) URL.revokeObjectURL(url);
          },
        };
      };
    },
  });
}

const auth = (token: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

interface BoardOption {
  id: string;
  name: string | null;
}

/** Выбор фрагмента: доска, потом фрейм (или вся доска). */
function EmbedPicker({
  hub,
  boards,
  onPick,
  onClose,
}: {
  hub: Hub | null;
  boards: readonly BoardOption[];
  onPick: (board: string, frame: string | null, title: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<BoardOption[]>(boards.filter((b) => !b.id.startsWith('pg_')));
  const [board, setBoard] = useState<BoardOption | null>(null);
  const [frames, setFrames] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = hub ? hubHttpUrl(hub.url) : null;
  const token = hub?.token ?? '';

  useEffect(() => {
    if (!base) return;
    const ctrl = new AbortController();
    fetch(`${base}/api/boards`, { headers: auth(token), signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`хаб ответил ${r.status}`);
        const all = (await r.json()) as (BoardOption & { kind?: string; elements: number })[];
        const seen = new Set(all.map((b) => b.id));
        setList([
          ...all.filter((b) => b.kind !== 'page' && !b.id.startsWith('_') && b.elements > 0),
          ...boards.filter((b) => !seen.has(b.id) && !b.id.startsWith('pg_')),
        ]);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [base, token, boards]);

  useEffect(() => {
    if (!board) return;
    setFrames(null);
    setError(null);
    if (!base) return setFrames([]);
    const ctrl = new AbortController();
    fetch(`${base}/api/frames/${encodeURIComponent(board.id)}`, {
      headers: auth(token),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(r.status === 404 ? 'доски нет на хабе' : `хаб ответил ${r.status}`);
        setFrames(((await r.json()) as { frames: { id: string; name: string }[] }).frames);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'хаб недоступен');
        setFrames([]);
      });
    return () => ctrl.abort();
  }, [board, base, token]);

  const name = board ? (board.name ?? board.id) : '';
  return (
    <div
      className="page-picker"
      role="dialog"
      aria-label="Фрагмент доски"
      data-testid="embed-picker"
    >
      <div className="panel-head">
        <h2>{board ? name : 'Фрагмент доски'}</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {!board && (
        <ul className="board-list">
          {list.length === 0 && <li className="muted empty">Досок с содержимым пока нет.</li>}
          {list.map((b) => (
            <li key={b.id}>
              <button onClick={() => setBoard(b)} data-testid="embed-board">
                <span className="board-title">{b.name ?? b.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {board && (
        <ul className="board-list">
          <li>
            <button onClick={() => onPick(board.id, null, name)} data-testid="embed-whole">
              <span className="board-title">Вся доска</span>
            </button>
          </li>
          {frames === null && <li className="muted empty">Загружаю фреймы…</li>}
          {frames?.map((f) => (
            <li key={f.id}>
              <button
                onClick={() => onPick(board.id, f.id, f.name || name)}
                data-testid="embed-frame"
              >
                <span className="board-title">{f.name || 'Фрейм'}</span>
                <span className="board-meta">фрейм</span>
              </button>
            </li>
          ))}
          {error && <li className="muted empty">Фреймы недоступны: {error}</li>}
          <li>
            <button className="link-btn" onClick={() => setBoard(null)}>
              ← Другая доска
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

type Tool = {
  label: string;
  title: string;
  active?: (e: Editor) => boolean;
  run: (c: ChainedCommands) => ChainedCommands;
};

const TOOLS: Tool[] = [
  {
    label: 'H1',
    title: 'Заголовок',
    active: (e) => e.isActive('heading', { level: 1 }),
    run: (c) => c.toggleHeading({ level: 1 }),
  },
  {
    label: 'H2',
    title: 'Подзаголовок',
    active: (e) => e.isActive('heading', { level: 2 }),
    run: (c) => c.toggleHeading({ level: 2 }),
  },
  { label: 'Ж', title: 'Жирный', active: (e) => e.isActive('bold'), run: (c) => c.toggleBold() },
  {
    label: 'К',
    title: 'Курсив',
    active: (e) => e.isActive('italic'),
    run: (c) => c.toggleItalic(),
  },
  {
    label: '•',
    title: 'Список',
    active: (e) => e.isActive('bulletList'),
    run: (c) => c.toggleBulletList(),
  },
  {
    label: '1.',
    title: 'Нумерованный список',
    active: (e) => e.isActive('orderedList'),
    run: (c) => c.toggleOrderedList(),
  },
  {
    label: '☐',
    title: 'Чек-лист',
    active: (e) => e.isActive('taskList'),
    run: (c) => c.toggleTaskList(),
  },
  {
    label: '❝',
    title: 'Цитата',
    active: (e) => e.isActive('blockquote'),
    run: (c) => c.toggleBlockquote(),
  },
  {
    label: '▦',
    title: 'Таблица',
    active: (e) => e.isActive('table'),
    run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
];

/** Правка таблицы в документе (решение 0023) — кнопками, пока курсор в таблице. */
const TABLE_TOOLS: Tool[] = [
  { label: '+ строка', title: 'Добавить строку', run: (c) => c.addRowAfter() },
  { label: '+ колонка', title: 'Добавить колонку', run: (c) => c.addColumnAfter() },
  { label: '− строка', title: 'Удалить строку', run: (c) => c.deleteRow() },
  { label: '− колонка', title: 'Удалить колонку', run: (c) => c.deleteColumn() },
  { label: 'Убрать таблицу', title: 'Удалить таблицу', run: (c) => c.deleteTable() },
];

/**
 * Документ (решение 0020, «слой Coda»): страница с текстом на том же Yjs-документе, что и у доски
 * (синхронизация, хранение, история и корзина — общие). Редактор — TipTap; всё форматирование —
 * кнопками, клавиши — только ускорители. Фрагмент доски — фрейм картинкой, касание открывает доску.
 */
export function PageView({
  session,
  name,
  hub,
  boards,
  onRename,
  onOpenBoard,
  onClose,
}: {
  session: BoardSession;
  name: string | null;
  hub: Hub | null;
  /** Недавние доски — для выбора фрагмента без хаба. */
  boards: readonly BoardOption[];
  onRename: (name: string) => void;
  onOpenBoard: (board: string, frame: string | null, title: string | null) => void;
  /** Документ открыт поверх доски — кнопка «К доске». */
  onClose?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setTick] = useState(0);
  const [picker, setPicker] = useState(false);
  const openRef = useRef(onOpenBoard);
  openRef.current = onOpenBoard;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const e = new Editor({
      element: el,
      extensions: pageExtensions({
        embed: embedExtension(hub, (b, f, t) => openRef.current(b, f, t)),
        extra: [
          Collaboration.configure({ document: session.doc, field: PAGE_FIELD }),
          Placeholder.configure({ placeholder: 'Пишите здесь — заголовки, списки, чек-листы…' }),
        ],
      }),
      editorProps: {
        attributes: { class: 'page-content', 'data-testid': 'page-editor', spellcheck: 'true' },
      },
    });
    const rerender = (): void => setTick((t) => t + 1);
    e.on('transaction', rerender);
    setEditor(e);
    return () => {
      e.off('transaction', rerender);
      e.destroy();
      setEditor(null);
    };
  }, [session, hub?.url, hub?.token]);

  /** Команда кнопкой: курсор в текст ставим только при мыши, на планшете не вызываем клавиатуру. */
  const chain = (): ChainedCommands | null => {
    if (!editor) return null;
    return editor.isFocused || finePointer() ? editor.chain().focus() : editor.chain();
  };
  const keep = (e: { preventDefault(): void }): void => e.preventDefault();

  return (
    <div className="page-view" data-testid="page-view">
      <div className="page-toolbar" role="toolbar" aria-label="Оформление текста">
        {onClose && (
          <button className="page-tool wide" onClick={onClose} data-testid="doc-close">
            ← К доске
          </button>
        )}
        {TOOLS.map((t) => (
          <button
            key={t.title}
            className="page-tool"
            title={t.title}
            aria-label={t.title}
            aria-pressed={editor ? (t.active?.(editor) ?? false) : false}
            disabled={!editor}
            onMouseDown={keep}
            onClick={() => {
              const c = chain();
              if (c) t.run(c).run();
            }}
          >
            {t.label}
          </button>
        ))}
        {editor?.isActive('table') &&
          TABLE_TOOLS.map((t) => (
            <button
              key={t.title}
              className="page-tool wide"
              title={t.title}
              onMouseDown={keep}
              onClick={() => {
                const c = chain();
                if (c) t.run(c).run();
              }}
              data-testid="table-tool"
            >
              {t.label}
            </button>
          ))}
        <span className="page-tool-gap" />
        <button
          className="page-tool wide"
          onClick={() => void openInClaude(session.board, name)}
          data-testid="to-claude"
        >
          В Claude
        </button>
        <button
          className="page-tool wide"
          onMouseDown={keep}
          onClick={() => setPicker(true)}
          disabled={!editor}
          data-testid="embed-open"
        >
          Фрагмент доски
        </button>
        <button
          className="page-tool"
          title="Отменить"
          aria-label="Отменить"
          onMouseDown={keep}
          disabled={!editor?.can().undo()}
          onClick={() => editor?.commands.undo()}
        >
          ↶
        </button>
        <button
          className="page-tool"
          title="Повторить"
          aria-label="Повторить"
          onMouseDown={keep}
          disabled={!editor?.can().redo()}
          onClick={() => editor?.commands.redo()}
        >
          ↷
        </button>
      </div>
      <div className="page-scroll">
        <article className="page-sheet">
          <CommitInput
            className="page-title"
            value={name ?? ''}
            placeholder="Без названия"
            aria-label="Название документа"
            onCommit={(v) => v.trim() && onRename(v)}
            data-testid="page-title"
          />
          <div ref={host} className="page-host" />
        </article>
      </div>
      {picker && (
        <EmbedPicker
          hub={hub}
          boards={boards}
          onClose={() => setPicker(false)}
          onPick={(board, frame, title) => {
            setPicker(false);
            editor
              ?.chain()
              .insertContent([
                { type: 'boardEmbed', attrs: { board, frame, title } },
                { type: 'paragraph' },
              ])
              .run();
          }}
        />
      )}
    </div>
  );
}
