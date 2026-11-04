/**
 * Связь Pen Lab с хабом: штрихи уходят в доску, штрихи с других устройств приходят обратно.
 */

import {
  addElement,
  createBoardDoc,
  deleteElements,
  getElement,
  makeStroke as makeStrokeElement,
  observeElements,
} from '@kayospace/board';
import { decodeStroke, type Actor, type StrokeElement, type StrokePoint } from '@kayospace/model';
import { SyncClient, isValidBoardId, type SyncStatus } from '@kayospace/sync';

/** Метка своих правок: их не нужно рисовать повторно. */
export const LOCAL_ORIGIN = 'pen-lab';

export interface RemoteStroke {
  id: string;
  /** Точки в координатах холста. */
  points: StrokePoint[];
  size: number;
  hasPressure: boolean;
}

export interface LinkHandlers {
  onStroke(s: RemoteStroke): void;
  onDelete(id: string): void;
  onStatus(s: SyncStatus): void;
}

/**
 * Адрес хаба из того, что ввёл человек: «192.168.1.10:4000», «ws://host:4000», «http://host:4000».
 * null — если адрес или имя доски не подходят.
 */
export function hubSyncUrl(input: string, board: string): string | null {
  const raw = input.trim();
  if (!raw || !isValidBoardId(board)) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.port && url.protocol === 'ws:') url.port = '4000';
  return `${url.protocol}//${url.host}/sync/${board}`;
}

export class BoardLink {
  readonly doc = createBoardDoc();
  readonly client: SyncClient;
  private readonly stopObserving: () => void;

  constructor(
    readonly url: string,
    private readonly actor: Actor,
    handlers: LinkHandlers,
  ) {
    this.stopObserving = observeElements(this.doc, (c) => {
      if (c.origin === LOCAL_ORIGIN) return;
      for (const id of [...c.added, ...c.updated]) {
        const el = getElement(this.doc, id);
        if (el?.type === 'stroke') handlers.onStroke(toRemote(el));
      }
      for (const id of c.deleted) handlers.onDelete(id);
    });
    this.client = new SyncClient(this.doc, { url, minDelayMs: 500, maxDelayMs: 5000 });
    this.client.onStatus(handlers.onStatus);
    handlers.onStatus(this.client.status);
  }

  /** Отправить законченный штрих. Возвращает id элемента на доске. */
  publish(points: readonly StrokePoint[], size: number, hasPressure: boolean): string {
    const el = makeStrokeElement(points, { hasPressure, style: { size }, actor: this.actor });
    addElement(this.doc, el, LOCAL_ORIGIN);
    return el.id;
  }

  remove(ids: string[]): void {
    if (ids.length > 0) deleteElements(this.doc, ids, LOCAL_ORIGIN);
  }

  destroy(): void {
    this.stopObserving();
    this.client.destroy();
    this.doc.destroy();
  }
}

function toRemote(el: StrokeElement): RemoteStroke {
  return {
    id: el.id,
    points: decodeStroke(el.props.points).map((p) => ({ ...p, x: p.x + el.x, y: p.y + el.y })),
    size: el.style.size ?? 4,
    hasPressure: el.props.hasPressure,
  };
}
