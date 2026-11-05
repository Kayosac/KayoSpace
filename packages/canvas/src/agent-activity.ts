/**
 * Правки агентов на доске (решение 0015): что агент (Claude, ChatGPT, Claude Code) только что изменил
 * через MCP — чтобы показать это человеку и дать отменить одним нажатием.
 *
 * Правки приходят по сети как чужие транзакции. Транзакция — агентская, если в ней есть свежий
 * элемент с updatedBy.kind === 'agent' (старые агентские элементы, пришедшие при загрузке доски,
 * не в счёт). Её удаления тоже относим к агенту. Подряд идущие правки одного агента (пауза меньше
 * mergeMs) — одна пачка. Для отмены запоминаем, каким каждый элемент был до пачки и стал после.
 */

import * as Y from 'yjs';
import type { CanvasElement } from '@kayospace/model';

export interface AgentActivity {
  /** Имя агента из updatedBy.name (claude-code, Claude, ChatGPT…). */
  name: string;
  added: number;
  updated: number;
  deleted: number;
  /** Элементы пачки, что сейчас есть на доске (показать и подсветить). */
  ids: string[];
  at: number;
}

interface Batch {
  name: string;
  before: Map<string, CanvasElement | null>;
  after: Map<string, CanvasElement | null>;
  last: number;
}

/** Тот ли это элемент, что оставил агент (человек его с тех пор не трогал). */
function same(a: CanvasElement | null | undefined, b: CanvasElement | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.type === b.type && a.updatedAt === b.updatedAt && a.updatedBy.name === b.updatedBy.name;
}

export class AgentTracker {
  private batch: Batch | null = null;

  constructor(
    private readonly map: Y.Map<CanvasElement>,
    private readonly onChange: (a: AgentActivity | null) => void,
    private readonly opts: {
      /** Origin своих правок: их не считаем. */
      localOrigin: unknown;
      now?: () => number;
      mergeMs?: number;
      freshMs?: number;
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Обработать событие Y.Map элементов. */
  handle(event: Y.YMapEvent<CanvasElement>): void {
    if (event.transaction.origin === this.opts.localOrigin) return;
    const now = this.now();
    const fresh = this.opts.freshMs ?? 120_000;
    let name: string | null = null;
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete') continue;
      const el = this.map.get(key);
      if (el?.updatedBy?.kind === 'agent' && Math.abs(now - el.updatedAt) < fresh) {
        name = el.updatedBy.name;
        break;
      }
    }
    if (!name) return;
    const merge = this.opts.mergeMs ?? 10_000;
    if (!this.batch || this.batch.name !== name || now - this.batch.last > merge) {
      this.batch = { name, before: new Map(), after: new Map(), last: now };
    }
    const b = this.batch;
    b.last = now;
    for (const [key, change] of event.changes.keys) {
      if (!b.before.has(key))
        b.before.set(key, (change.oldValue as CanvasElement | undefined) ?? null);
      b.after.set(key, this.map.get(key) ?? null);
    }
    this.onChange(this.current());
  }

  current(): AgentActivity | null {
    const b = this.batch;
    if (!b) return null;
    let added = 0;
    let updated = 0;
    let deleted = 0;
    const ids: string[] = [];
    for (const [id, before] of b.before) {
      const after = b.after.get(id) ?? null;
      if (!before && after) added++;
      else if (before && !after) deleted++;
      else if (before && after) updated++;
      if (after && this.map.has(id)) ids.push(id);
    }
    if (added + updated + deleted === 0) return null;
    return { name: b.name, added, updated, deleted, ids, at: b.last };
  }

  /**
   * Вернуть элементы пачки к виду до неё — одной транзакцией с origin (своей правкой: её можно
   * отменить кнопкой «Отменить»). Элементы, которые после агента правил человек, не трогаем.
   */
  revert(doc: Y.Doc, origin: unknown): { reverted: number; skipped: number } {
    const b = this.batch;
    if (!b) return { reverted: 0, skipped: 0 };
    let reverted = 0;
    let skipped = 0;
    doc.transact(() => {
      for (const [id, before] of b.before) {
        if (!same(this.map.get(id) ?? null, b.after.get(id) ?? null)) {
          skipped++;
          continue;
        }
        if (before) this.map.set(id, before);
        else this.map.delete(id);
        reverted++;
      }
    }, origin);
    this.batch = null;
    this.onChange(null);
    return { reverted, skipped };
  }

  dismiss(): void {
    if (!this.batch) return;
    this.batch = null;
    this.onChange(null);
  }
}
