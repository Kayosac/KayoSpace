/**
 * Чат с ИИ на доске (решение 0019): переписка хранится на хабе (`chats/<доска>.json`), поэтому
 * разговор продолжается с любого устройства. Каждое сообщение — обычная задача ИИ (черновик,
 * предпросмотр, «Вставить»), а в задание для Claude попадают последние реплики разговора.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /** Сколько правок предложил ИИ (их видно предпросмотром до «Вставить»). */
  changes?: number;
  error?: boolean;
}

/** Хранить не больше стольких сообщений на доску и не дольше двух недель. */
const MAX_MESSAGES = 100;
const KEEP_MS = 14 * 24 * 3_600_000;
/** Сколько последних реплик ИИ видит в задании. */
export const CONTEXT_MESSAGES = 12;

export class ChatStore {
  private readonly dir: string;
  private readonly cache = new Map<string, Promise<ChatMessage[]>>();
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(dataDir, 'chats');
  }

  private file(board: string): string {
    return join(this.dir, `${board}.json`);
  }

  list(board: string): Promise<ChatMessage[]> {
    let p = this.cache.get(board);
    if (!p) {
      p = readFile(this.file(board), 'utf8')
        .then((s) => JSON.parse(s) as ChatMessage[])
        .catch(() => []);
      this.cache.set(board, p);
    }
    return p.then((m) => m.filter((x) => this.now() - x.at < KEEP_MS));
  }

  add(board: string, msg: Omit<ChatMessage, 'at'>): Promise<ChatMessage[]> {
    const run = async (): Promise<ChatMessage[]> => {
      const next = [...(await this.list(board)), { ...msg, at: this.now() }].slice(-MAX_MESSAGES);
      this.cache.set(board, Promise.resolve(next));
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${this.file(board)}.tmp`, JSON.stringify(next));
      await rename(`${this.file(board)}.tmp`, this.file(board));
      return next;
    };
    const p = (this.busy.get(board) ?? Promise.resolve()).catch(() => {}).then(run);
    this.busy.set(board, p);
    return p;
  }

  /** «Новый разговор». */
  async clear(board: string): Promise<void> {
    await this.busy.get(board)?.catch(() => {});
    this.cache.set(board, Promise.resolve([]));
    await rm(this.file(board), { force: true });
  }
}

/** Последние реплики разговора — для задания Claude. */
export function chatContext(messages: readonly ChatMessage[]): string {
  const recent = messages.filter((m) => !m.error).slice(-CONTEXT_MESSAGES);
  if (recent.length === 0) return '';
  return [
    'Разговор до этого (старое — выше):',
    ...recent.map(
      (m) =>
        `${m.role === 'user' ? 'Человек' : 'Ты'}: ${m.text.replace(/\s+/g, ' ').slice(0, 1500)}` +
        (m.changes ? ` [предложено правок: ${m.changes}]` : ''),
    ),
  ].join('\n');
}
