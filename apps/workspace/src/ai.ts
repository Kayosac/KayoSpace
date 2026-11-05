/**
 * ИИ внутри доски (решение 0007): задача уходит на хаб, её выполняет Claude Code на сервере
 * или на компьютере владельца, результат приходит черновиком — его показываем предпросмотром.
 */

import { elementFromWire, type WireElement } from '@kayospace/board';
import { hubHttpUrl } from '@kayospace/sync';
import type { AiDraft } from '@kayospace/canvas';

export type AiAction =
  | 'recognize'
  | 'group'
  | 'summarize'
  | 'diagram'
  | 'brainstorm'
  | 'fix'
  | 'shorten'
  | 'translate'
  | 'prompt'
  | 'chat';

/** Действия меню «✦ ИИ»; needs — для какого выделения они имеют смысл. */
export const AI_MENU: { action: AiAction; name: string; needs: 'any' | 'text' | 'ink' }[] = [
  { action: 'recognize', name: 'Распознать рукописное', needs: 'ink' },
  { action: 'summarize', name: 'Резюме', needs: 'any' },
  { action: 'group', name: 'Сгруппировать по темам', needs: 'text' },
  { action: 'diagram', name: 'Сделать схему', needs: 'text' },
  { action: 'brainstorm', name: 'Ещё идей', needs: 'any' },
  { action: 'fix', name: 'Исправить ошибки', needs: 'text' },
  { action: 'shorten', name: 'Сократить', needs: 'text' },
  { action: 'translate', name: 'Перевести', needs: 'text' },
];

export const AI_ACTION_NAMES: Record<AiAction, string> = {
  ...(Object.fromEntries(AI_MENU.map((a) => [a.action, a.name])) as Record<AiAction, string>),
  prompt: 'Запрос',
  chat: 'ответ в чате',
};

export interface AiRequest {
  board: string;
  action: AiAction;
  prompt?: string;
  selection: string[];
  area: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Картинка выделенного (для распознавания рукописного). */
  image?: Blob | null;
}

export type AiState =
  | { kind: 'idle' }
  | { kind: 'running'; action: AiAction; startedAt: number; waitingWorker: boolean }
  | { kind: 'ready'; action: AiAction; message: string; changes: number; draft: AiDraft }
  | { kind: 'error'; message: string };

interface Hub {
  url: string;
  token: string;
}

/** Ответ хаба о задаче. */
interface TaskInfo {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  message: string | null;
  error: string | null;
  draft?: { elements: WireElement[]; deleted: string[] };
}

const POLL_MS = 1000;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Текущая задача ИИ: одна на окно приложения. Для useSyncExternalStore. */
export class AiController {
  private state: AiState = { kind: 'idle' };
  private readonly listeners = new Set<() => void>();
  private hub: Hub | null = null;
  private task: { id: string; base: string; hub: Hub } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run = 0;

  constructor(private readonly pollMs = POLL_MS) {}

  getState(): AiState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setHub(hub: Hub | null): void {
    this.hub = hub && hubHttpUrl(hub.url) ? hub : null;
  }

  get available(): boolean {
    return this.hub !== null;
  }

  /** Отправить задачу. Предыдущая (если ещё идёт) отменяется. */
  async start(req: AiRequest): Promise<void> {
    const hub = this.hub;
    const base = hub ? hubHttpUrl(hub.url) : null;
    if (!hub || !base) {
      this.set({
        kind: 'error',
        message: 'ИИ работает через хаб: включите синхронизацию в настройках.',
      });
      return;
    }
    this.cancel();
    const run = ++this.run;
    this.set({ kind: 'running', action: req.action, startedAt: Date.now(), waitingWorker: false });
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (hub.token) headers.Authorization = `Bearer ${hub.token}`;
      const image = req.image ? await blobToBase64(req.image) : null;
      const res = await fetch(`${base}/api/ai/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          board: req.board,
          action: req.action,
          prompt: req.prompt ?? '',
          selection: req.selection,
          area: req.area,
          image,
        }),
      });
      if (run !== this.run) return;
      if (res.status === 404) {
        throw new Error('Хаб не знает про ИИ — обновите хаб на сервере.');
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Хаб ответил ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      this.task = { id, base, hub };
      // Есть ли исполнитель на связи — чтобы честно сказать, чего ждём.
      void fetch(`${base}/api/ai/status`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { workers?: unknown[] } | null) => {
          if (run === this.run && s && Array.isArray(s.workers) && s.workers.length === 0) {
            const st = this.state;
            if (st.kind === 'running') this.set({ ...st, waitingWorker: true });
          }
        })
        .catch(() => {});
      this.poll(run);
    } catch (err) {
      if (run !== this.run) return;
      this.set({
        kind: 'error',
        message:
          err instanceof TypeError
            ? 'Нет связи с хабом.'
            : err instanceof Error
              ? err.message
              : 'Не удалось отправить задачу',
      });
    }
  }

  /** Показать ошибку, не отправляя задачу. */
  fail(message: string): void {
    this.cancel();
    this.set({ kind: 'error', message });
  }

  /** Отменить идущую задачу или убрать результат. */
  cancel(): void {
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.task;
    this.task = null;
    if (t) {
      void fetch(`${t.base}/api/ai/tasks/${t.id}`, {
        method: 'DELETE',
        headers: t.hub.token ? { Authorization: `Bearer ${t.hub.token}` } : {},
      }).catch(() => {});
    }
    if (this.state.kind !== 'idle') this.set({ kind: 'idle' });
  }

  destroy(): void {
    this.cancel();
    this.listeners.clear();
  }

  private poll(run: number): void {
    this.timer = setTimeout(async () => {
      const t = this.task;
      if (run !== this.run || !t) return;
      try {
        const res = await fetch(`${t.base}/api/ai/tasks/${t.id}`, {
          headers: t.hub.token ? { Authorization: `Bearer ${t.hub.token}` } : {},
        });
        if (run !== this.run) return;
        if (res.status === 404) throw new Error('Задача пропала с хаба (хаб перезапускался?).');
        if (!res.ok) throw new Error(`Хаб ответил ${res.status}`);
        const info = (await res.json()) as TaskInfo;
        if (run !== this.run) return;
        const st = this.state;
        if (info.status === 'done') {
          const draft: AiDraft = {
            elements: (info.draft?.elements ?? []).map(elementFromWire),
            deleted: info.draft?.deleted ?? [],
          };
          this.set({
            kind: 'ready',
            action: st.kind === 'running' ? st.action : 'prompt',
            message: info.message?.trim() || 'Готово.',
            changes: draft.elements.length + draft.deleted.length,
            draft,
          });
          return;
        }
        if (info.status === 'error' || info.status === 'cancelled') {
          this.task = null;
          this.set({ kind: 'error', message: info.error ?? 'Задача отменена' });
          return;
        }
        if (info.status === 'running' && st.kind === 'running' && st.waitingWorker) {
          this.set({ ...st, waitingWorker: false });
        }
      } catch (err) {
        if (run !== this.run) return;
        if (err instanceof TypeError) {
          // Сеть моргнула — пробуем дальше, хаб сам снимет задачу по таймауту.
        } else {
          this.task = null;
          this.set({ kind: 'error', message: err instanceof Error ? err.message : 'Ошибка' });
          return;
        }
      }
      this.poll(run);
    }, this.pollMs);
  }

  private set(s: AiState): void {
    this.state = s;
    for (const cb of [...this.listeners]) cb();
  }
}
