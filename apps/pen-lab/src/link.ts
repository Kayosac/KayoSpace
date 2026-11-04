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
import { SyncClient, type SyncStatus } from '@kayospace/sync';

export { hubSyncUrl } from '@kayospace/sync';

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
