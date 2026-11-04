/**
 * ИИ внутри Kayospace (решение 0007): очередь задач на хабе и черновики.
 *
 * Устройство создаёт задачу (действие над выделением или свой запрос). Исполнитель — официальный
 * Claude Code на сервере или на компьютере владельца — забирает её длинным опросом и работает
 * с доской через MCP по адресу /mcp/draft/<задача>: там та же доска, но копия. Всё, что ИИ
 * добавил, изменил или удалил, остаётся в черновике; устройство показывает его как предпросмотр
 * и по кнопке «Вставить» само переносит в доску (своей правкой — её можно отменить).
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Y from 'yjs';
import { elementToWire, getElement, observeElements, type WireElement } from '@kayospace/board';
import type { BoardInfo, BoardStore } from './store';

export const AI_ACTIONS = [
  'recognize',
  'group',
  'summarize',
  'diagram',
  'brainstorm',
  'fix',
  'shorten',
  'translate',
  'prompt',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface Area {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AiTask {
  id: string;
  board: string;
  action: AiAction;
  prompt: string;
  selection: string[];
  area: Area | null;
  image: Buffer | null;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  worker?: string;
  message?: string;
  error?: string;
  /** Копия доски, в которую пишет ИИ. */
  draft: Y.Doc;
  /** Что ИИ тронул в черновике. */
  touched: Set<string>;
  stopObserving: () => void;
}

/** Сколько задача может ждать исполнителя и сколько — выполняться. */
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const RUN_TIMEOUT_MS = 4 * 60 * 1000;
/** Готовые задачи живут столько, потом черновик выбрасывается. */
const KEEP_MS = 30 * 60 * 1000;
/** Длинный опрос исполнителя. */
const POLL_MS = 25_000;
/** Исполнитель считается на связи, если опрашивал хаб не позже этого. */
const WORKER_ALIVE_MS = 60_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class AiQueue {
  readonly tasks = new Map<string, AiTask>();
  private readonly waiting: { name: string; resolve: (t: AiTask | null) => void }[] = [];
  private readonly workers = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly store: BoardStore) {
    this.timer = setInterval(() => this.sweep(), 5000);
    this.timer.unref?.();
  }

  close(): void {
    clearInterval(this.timer);
    for (const w of this.waiting.splice(0)) w.resolve(null);
    for (const t of this.tasks.values()) this.drop(t);
  }

  status() {
    const now = Date.now();
    const workers = [...this.workers.entries()]
      .filter(([, seen]) => now - seen < WORKER_ALIVE_MS)
      .map(([name, seen]) => ({ name, lastSeen: seen }));
    const tasks = [...this.tasks.values()];
    return {
      workers,
      queued: tasks.filter((t) => t.status === 'queued').length,
      running: tasks.filter((t) => t.status === 'running').length,
    };
  }

  async create(input: {
    board: string;
    action: AiAction;
    prompt?: string;
    selection?: string[];
    area?: Area | null;
    image?: Buffer | null;
  }): Promise<AiTask> {
    const doc = await this.store.get(input.board);
    const draft = new Y.Doc();
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
    const touched = new Set<string>();
    const stopObserving = observeElements(draft, (c) => {
      for (const id of [...c.added, ...c.updated, ...c.deleted]) touched.add(id);
    });
    const task: AiTask = {
      id: randomBytes(12).toString('base64url'),
      board: input.board,
      action: input.action,
      prompt: (input.prompt ?? '').slice(0, 4000),
      selection: (input.selection ?? []).slice(0, 500),
      area: input.area ?? null,
      image: input.image ?? null,
      status: 'queued',
      createdAt: Date.now(),
      draft,
      touched,
      stopObserving,
    };
    this.tasks.set(task.id, task);
    console.log(`[hub] ИИ: задача ${task.id} (${task.action}, доска ${task.board})`);
    this.dispatch();
    return task;
  }

  /**
   * Исполнитель просит работу: сразу, если есть, иначе ждём до waitMs.
   * signal — запрос исполнителя оборвался (перезапуск, сеть): ждать за него больше не нужно.
   */
  next(name: string, waitMs = POLL_MS, signal?: AbortSignal): Promise<AiTask | null> {
    this.workers.set(name, Date.now());
    // Исполнитель берёт задачи по одной: раз он просит новую, «его» незаконченная задача
    // осталась от прошлого запуска (перезапуск, обрыв) — возвращаем её в очередь.
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.worker === name) this.requeue(t);
    }
    const ready = this.takeQueued(name);
    if (ready) return Promise.resolve(ready);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (t: AiTask | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(t);
      };
      const entry = { name, resolve: done };
      const onAbort = (): void => done(null);
      const timer = setTimeout(() => done(null), waitMs);
      signal?.addEventListener('abort', onAbort);
      this.waiting.push(entry);
    });
  }

  finish(id: string, result: { message?: string; error?: string }): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return false;
    if (result.error) {
      t.status = 'error';
      t.error = result.error.slice(0, 2000);
    } else {
      t.status = 'done';
      t.message = (result.message ?? '').slice(0, 4000);
    }
    return true;
  }

  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === 'queued' || t.status === 'running') t.status = 'cancelled';
    this.drop(t);
    this.tasks.delete(id);
    return true;
  }

  /** Что ИИ сделал: изменённые и новые элементы черновика и удалённые id. */
  diff(t: AiTask): { elements: WireElement[]; deleted: string[] } {
    const elements: WireElement[] = [];
    const deleted: string[] = [];
    for (const id of t.touched) {
      const el = getElement(t.draft, id);
      if (el) elements.push(elementToWire(el));
      else deleted.push(id);
    }
    return { elements, deleted };
  }

  /** Источник досок для MCP черновика: своя доска — черновик, остальные — только чтение. */
  draftSource(t: AiTask) {
    const store = this.store;
    return {
      get: async (board: string): Promise<Y.Doc> => {
        if (board === t.board) return t.draft;
        // Чужую доску ИИ может только читать: отдаём копию, правки в неё никуда не попадут.
        const copy = new Y.Doc();
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(await store.get(board)));
        return copy;
      },
      has: (board: string) => (board === t.board ? Promise.resolve(true) : store.has(board)),
      list: (): Promise<BoardInfo[]> => store.list(),
    };
  }

  private takeQueued(name: string): AiTask | null {
    // Строго по одной задаче на исполнителя — память сервера под контролем.
    if ([...this.tasks.values()].some((t) => t.status === 'running' && t.worker === name))
      return null;
    const t = [...this.tasks.values()]
      .filter((x) => x.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!t) return null;
    t.status = 'running';
    t.worker = name;
    t.startedAt = Date.now();
    return t;
  }

  /** Вернуть задачу в очередь (исполнитель пропал) и отдать свободному. */
  requeue(t: AiTask): void {
    if (t.status !== 'running') return;
    t.status = 'queued';
    delete t.worker;
    delete t.startedAt;
    this.dispatch();
  }

  private dispatch(): void {
    // Ждущие — по порядку; занятый исполнитель задачу не получает, следующий — может.
    for (const w of [...this.waiting]) {
      const t = this.takeQueued(w.name);
      if (t) w.resolve(t); // сам убирает себя из очереди ожидания
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const t of this.tasks.values()) {
      if (t.status === 'queued' && now - t.createdAt > QUEUE_TIMEOUT_MS) {
        t.status = 'error';
        t.error = 'Нет свободного исполнителя ИИ. Запущен ли он на сервере или на компьютере?';
      } else if (t.status === 'running' && now - (t.startedAt ?? now) > RUN_TIMEOUT_MS) {
        t.status = 'error';
        t.error = 'ИИ не уложился в 4 минуты. Попробуйте задачу поменьше.';
      } else if (now - t.createdAt > KEEP_MS) {
        this.drop(t);
        this.tasks.delete(t.id);
      }
    }
  }

  private drop(t: AiTask): void {
    t.stopObserving();
    t.draft.destroy();
  }
}

// ---------- Задание для Claude ----------

const ACTION_TEXT: Record<AiAction, string> = {
  recognize:
    'Распознай рукописное на картинке selection.png (это выделенный фрагмент доски). ' +
    'Если это текст — добавь его надписью (add_text) справа от области. Если это схема или список — ' +
    'воссоздай аккуратно: стикеры (add_sticky) и стрелки (add_arrow между id стикеров). Сам рисунок не удаляй.',
  group:
    'Сгруппируй выделенные стикеры по смыслу. Перемести их (update_element x, y) колонками по темам ' +
    'с шагом 220 по горизонтали и вертикали; каждую колонку обведи фреймом с названием темы ' +
    '(add_frame, с полями 40 вокруг стикеров). Тексты стикеров не меняй.',
  summarize:
    'Прочитай выделенное и сделай короткое резюме: 2–5 главных мыслей. Добавь его одним стикером ' +
    '(add_sticky) справа от области.',
  diagram:
    'Преврати выделенный текст или список в схему: шаги — стикерами (add_sticky) в ряд или дерево ' +
    'с шагом 260, связи — стрелками (add_arrow от id к id). Ставь справа от области.',
  brainstorm:
    'Продолжи мозговой штурм: добавь 5–8 новых стикеров (add_sticky) с идеями в том же духе, ' +
    'сеткой справа от области. Не повторяй уже имеющиеся идеи.',
  fix: 'Исправь орфографию, пунктуацию и опечатки в текстах выделенных стикеров и надписей (update_element text). Смысл не меняй.',
  shorten:
    'Сократи тексты выделенных стикеров и надписей до сути (update_element text), сохранив смысл.',
  translate:
    'Переведи тексты выделенных стикеров и надписей на английский (update_element text). ' +
    'Если текст уже английский — переведи на русский.',
  prompt: 'Выполни просьбу пользователя ниже.',
};

/** Полный текст задания для Claude Code. */
export function buildPrompt(
  t: Pick<AiTask, 'board' | 'action' | 'prompt' | 'selection' | 'area' | 'image'>,
): string {
  const lines = [
    'Ты — ИИ-помощник внутри Kayospace, бесконечной доски. Работай только через инструменты kayospace.',
    `Доска: ${t.board}. Сначала прочитай её: read_board с board="${t.board}" и format="json".`,
  ];
  if (t.selection.length > 0) {
    lines.push(`Выделенные элементы (id): ${t.selection.join(', ')}.`);
  }
  if (t.area) {
    const a = t.area;
    lines.push(
      `Область внимания (мировые координаты): x ${Math.round(a.minX)}…${Math.round(a.maxX)}, ` +
        `y ${Math.round(a.minY)}…${Math.round(a.maxY)}. Новые элементы ставь рядом с ней, ` +
        `по умолчанию справа — начиная с x = ${Math.round(a.maxX + 60)}, y = ${Math.round(a.minY)}; не накрывай существующие.`,
    );
  }
  if (t.image)
    lines.push(
      'Картинка выделенного фрагмента лежит в файле selection.png в текущей папке — посмотри её инструментом Read.',
    );
  lines.push('', `Задача: ${ACTION_TEXT[t.action]}`);
  if (t.prompt) lines.push(`Просьба пользователя: ${t.prompt}`);
  lines.push(
    '',
    'Правила: пиши по-русски, если пользователь не просил другой язык. Не трогай элементы, которые не относятся к задаче. ' +
      'Правки попадут в черновик — человек посмотрит и вставит. В конце ответь одним-двумя предложениями, что сделано.',
  );
  return lines.join('\n');
}

// ---------- HTTP ----------

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(new Error('слишком большой запрос'));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('нужен JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const BOARD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** /api/ai/* — доступ уже проверен (токен хаба). true — запрос обработан. */
export async function handleAi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ai: AiQueue,
): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/ai/')) return false;
  try {
    if (p === '/api/ai/status' && req.method === 'GET') {
      json(res, 200, ai.status());
      return true;
    }
    if (p === '/api/ai/tasks' && req.method === 'POST') {
      const body = (await readJson(req, MAX_IMAGE_BYTES * 1.4)) as Record<string, unknown>;
      const board = String(body.board ?? '');
      const action = String(body.action ?? '') as AiAction;
      if (!BOARD_RE.test(board)) return (json(res, 400, { error: 'Неверная доска' }), true);
      if (!AI_ACTIONS.includes(action))
        return (json(res, 400, { error: 'Неизвестное действие' }), true);
      if (action === 'prompt' && !String(body.prompt ?? '').trim()) {
        return (json(res, 400, { error: 'Пустой запрос' }), true);
      }
      const image =
        typeof body.image === 'string' && body.image ? Buffer.from(body.image, 'base64') : null;
      if (image && image.length > MAX_IMAGE_BYTES) {
        return (json(res, 413, { error: 'Картинка выделения слишком большая' }), true);
      }
      const area = body.area as Area | null | undefined;
      const task = await ai.create({
        board,
        action,
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        selection: Array.isArray(body.selection)
          ? body.selection.filter((s): s is string => typeof s === 'string')
          : [],
        area:
          area && [area.minX, area.minY, area.maxX, area.maxY].every((v) => Number.isFinite(v))
            ? area
            : null,
        image,
      });
      json(res, 201, { id: task.id, status: task.status });
      return true;
    }
    const m = /^\/api\/ai\/tasks\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m) {
      const t = ai.tasks.get(m[1]!);
      if (req.method === 'DELETE') {
        json(res, ai.cancel(m[1]!) ? 200 : 404, { ok: true });
        return true;
      }
      if (!t) return (json(res, 404, { error: 'Задачи нет (возможно, устарела)' }), true);
      json(res, 200, {
        id: t.id,
        status: t.status,
        worker: t.worker ?? null,
        message: t.message ?? null,
        error: t.error ?? null,
        ...(t.status === 'done' ? { draft: ai.diff(t) } : {}),
      });
      return true;
    }
    if (p === '/api/ai/worker/next' && req.method === 'POST') {
      const body = (await readJson(req, 4096)) as { name?: unknown; wait?: unknown };
      const name = String(body.name ?? 'исполнитель').slice(0, 60);
      const wait =
        typeof body.wait === 'number' ? Math.min(Math.max(body.wait, 0), 30_000) : POLL_MS;
      // Исполнитель оборвал запрос — не отдавать задачу в пустоту.
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) gone.abort();
      });
      const t = await ai.next(name, wait, gone.signal);
      if (gone.signal.aborted) {
        if (t) ai.requeue(t);
        return true;
      }
      if (!t) {
        res.writeHead(204);
        res.end();
        return true;
      }
      json(res, 200, {
        id: t.id,
        board: t.board,
        prompt: buildPrompt(t),
        image: t.image ? t.image.toString('base64') : null,
        mcpPath: `/mcp/draft/${t.id}`,
      });
      return true;
    }
    const done = /^\/api\/ai\/worker\/tasks\/([A-Za-z0-9_-]+)\/done$/.exec(p);
    if (done && req.method === 'POST') {
      const body = (await readJson(req, 64 * 1024)) as { message?: unknown; error?: unknown };
      const ok = ai.finish(done[1]!, {
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
      });
      json(res, ok ? 200 : 409, { ok });
      return true;
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : 'Ошибка запроса' });
  }
  return true;
}
