/**
 * Хранилище досок: один файл на доску (`<id>.ydoc`) с полным состоянием Yjs.
 * Документы держатся в памяти, на диск пишутся с задержкой после изменений (и при остановке).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  WORKSPACE_ID,
  boardProjects,
  deletedBoards,
  getBoardName,
  isBoardDeleted,
  isServiceDoc,
  listElements,
  listProjects,
} from '@kayospace/board';
import { isValidBoardId } from '@kayospace/sync';

export interface BoardInfo {
  id: string;
  name: string | null;
  elements: number;
  /** Проект доски (id и название); null — без проекта. */
  project: { id: string; name: string } | null;
}

export class BoardStore {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly loading = new Map<string, Promise<Y.Doc>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly saving = new Map<string, Promise<void>>();

  constructor(
    readonly dir: string,
    private readonly saveDelayMs = 500,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return join(this.dir, `${id}.ydoc`);
  }

  private assertId(id: string): void {
    if (!isValidBoardId(id)) throw new Error(`Недопустимый id доски: ${id}`);
  }

  /** Есть ли доска (в памяти или на диске). */
  async has(id: string): Promise<boolean> {
    if (!isValidBoardId(id)) return false;
    if (this.docs.has(id)) return true;
    try {
      await access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Документ доски; если её нет — создаётся пустой. */
  get(id: string): Promise<Y.Doc> {
    this.assertId(id);
    const ready = this.docs.get(id);
    if (ready) return Promise.resolve(ready);
    const pending = this.loading.get(id);
    if (pending) return pending;
    const p = this.load(id);
    this.loading.set(id, p);
    return p.finally(() => this.loading.delete(id));
  }

  private async load(id: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    try {
      const bytes = await readFile(this.file(id));
      Y.applyUpdate(doc, new Uint8Array(bytes));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    doc.on('update', () => this.scheduleSave(id));
    this.docs.set(id, doc);
    for (const cb of this.loadListeners) cb(id, doc);
    return doc;
  }

  private readonly loadListeners: ((id: string, doc: Y.Doc) => void)[] = [];

  /** Вызывается для каждого документа, когда он загружен в память (корзина следит за удалениями). */
  onLoad(cb: (id: string, doc: Y.Doc) => void): void {
    this.loadListeners.push(cb);
    for (const [id, doc] of this.docs) cb(id, doc);
  }

  async list(): Promise<BoardInfo[]> {
    const ids = new Set(this.docs.keys());
    for (const name of await readdir(this.dir)) {
      if (name.endsWith('.ydoc')) {
        const id = name.slice(0, -'.ydoc'.length);
        if (isValidBoardId(id)) ids.add(id);
      }
    }
    // Проекты — из служебного документа воркспейса (его самого в списке досок нет).
    const ws = await this.get(WORKSPACE_ID);
    const names = new Map(listProjects(ws).map((p) => [p.id, p.name]));
    const membership = boardProjects(ws);
    const out: BoardInfo[] = [];
    for (const id of [...ids].sort()) {
      if (isServiceDoc(id) || isBoardDeleted(ws, id)) continue;
      const doc = await this.get(id);
      const pid = membership.get(id);
      out.push({
        id,
        name: getBoardName(doc) ?? null,
        elements: listElements(doc).length,
        project: pid ? { id: pid, name: names.get(pid) ?? '' } : null,
      });
    }
    return out;
  }

  /** Удалена ли доска (отметка в воркспейсе, решение 0016). */
  async isDeleted(id: string): Promise<boolean> {
    if (isServiceDoc(id) || !isValidBoardId(id)) return false;
    return isBoardDeleted(await this.get(WORKSPACE_ID), id);
  }

  /** Стёрта ли доска насовсем (удалена больше 7 дней назад). */
  async isPurged(id: string): Promise<boolean> {
    if (isServiceDoc(id) || !isValidBoardId(id)) return false;
    return deletedBoards(await this.get(WORKSPACE_ID)).get(id)?.purged === true;
  }

  /**
   * Хранилище для агентов: удалённых досок для них нет — has() их не видит, а get() отказывает,
   * чтобы агент не писал в доску, которую человек убрал.
   */
  live(): Pick<BoardStore, 'get' | 'has' | 'list'> {
    return {
      has: async (id) => !(await this.isDeleted(id)) && (await this.has(id)),
      get: async (id) => {
        if (await this.isDeleted(id))
          throw new Error(`Доска «${id}» удалена. Вернуть — restore_board.`);
        return this.get(id);
      },
      list: () => this.list(),
    };
  }

  /** Стереть доску насовсем: из памяти и с диска. */
  async purge(id: string): Promise<void> {
    this.assertId(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.saving.get(id)?.catch(() => {});
    await this.loading.get(id)?.catch(() => {});
    const doc = this.docs.get(id);
    this.docs.delete(id);
    doc?.destroy();
    await rm(this.file(id), { force: true });
  }

  private scheduleSave(id: string): void {
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.save(id).catch((err) => console.error(`[hub] не сохранилась доска ${id}`, err));
      }, this.saveDelayMs),
    );
  }

  /**
   * Сохранить доску. Записи одной доски идут строго по очереди: иначе две записи во временный
   * файл одновременно, и вторая переименовывает уже переименованный файл (ENOENT).
   */
  save(id: string): Promise<void> {
    const prev = this.saving.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.write(id))
      .finally(() => {
        if (this.saving.get(id) === next) this.saving.delete(id);
      });
    this.saving.set(id, next);
    return next;
  }

  private async write(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc) return;
    const tmp = `${this.file(id)}.tmp`;
    await writeFile(tmp, Y.encodeStateAsUpdate(doc));
    await rename(tmp, this.file(id));
  }

  /** Записать на диск всё, что ждёт сохранения, и дождаться уже идущих записей. */
  async flush(): Promise<void> {
    const ids = [...this.timers.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    await Promise.all([...ids.map((id) => this.save(id)), ...this.saving.values()]);
  }

  async close(): Promise<void> {
    await this.flush();
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }
}
