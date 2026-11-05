import { useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { ARTIFACT_KINDS, artifactHtml, readArtifact, type Artifact } from '@kayospace/page';
import type { BoardSession } from './session';
import { CommitInput } from './CommitInput';
import { openInClaude } from './claude';
import { notify } from './notify';

function useArtifact(doc: Y.Doc): Artifact | null {
  const [a, setA] = useState(() => readArtifact(doc));
  useEffect(() => {
    const on = (): void => setA(readArtifact(doc));
    on();
    doc.on('update', on);
    return () => doc.off('update', on);
  }, [doc]);
  return a;
}

/**
 * Артефакт (решение 0023): то, что Claude сделал в чате, — живым, в песочнице (скрипты работают,
 * но к приложению, его данным и токенам доступа нет), или исходником. Правят его в Claude:
 * «В Claude» → «обнови на доске» — и здесь новая версия.
 */
export function ArtifactView({
  session,
  name,
  onRename,
  onClose,
}: {
  session: BoardSession;
  name: string | null;
  onRename: (name: string) => void;
  /** Открыт поверх доски — кнопка «К доске». */
  onClose?: () => void;
}) {
  const a = useArtifact(session.doc);
  const [view, setView] = useState<'live' | 'source'>('live');
  const [reload, setReload] = useState(0);
  const html = useMemo(() => (a ? artifactHtml(a) : ''), [a]);
  const kind = a ? ARTIFACT_KINDS.find((k) => k.kind === a.kind) : null;
  const copy = async (): Promise<void> => {
    if (!a) return;
    try {
      await navigator.clipboard.writeText(a.source);
      notify('Исходник скопирован');
    } catch {
      notify('Не получилось скопировать');
    }
  };
  return (
    <div className="page-view artifact-view" data-testid="artifact-view">
      <div className="page-toolbar" role="toolbar" aria-label="Артефакт">
        {onClose && (
          <button className="page-tool wide" onClick={onClose} data-testid="doc-close">
            ← К доске
          </button>
        )}
        <span className="artifact-seg" role="group" aria-label="Вид">
          <button
            className="page-tool wide"
            aria-pressed={view === 'live'}
            onClick={() => setView('live')}
            data-testid="artifact-live"
          >
            Просмотр
          </button>
          <button
            className="page-tool wide"
            aria-pressed={view === 'source'}
            onClick={() => setView('source')}
            data-testid="artifact-source"
          >
            Исходник
          </button>
        </span>
        {view === 'live' && (
          <button
            className="page-tool"
            title="Перезапустить"
            aria-label="Перезапустить"
            onClick={() => setReload((r) => r + 1)}
          >
            ↻
          </button>
        )}
        <span className="page-tool-gap" />
        <button className="page-tool wide" onClick={() => void copy()} disabled={!a}>
          Копировать
        </button>
        <button
          className="page-tool wide"
          onClick={() => void openInClaude(session.board, name)}
          data-testid="to-claude"
        >
          В Claude
        </button>
      </div>
      <div className="artifact-head">
        <CommitInput
          className="page-title"
          value={name ?? ''}
          placeholder="Без названия"
          aria-label="Название артефакта"
          onCommit={(v) => v.trim() && onRename(v)}
          data-testid="page-title"
        />
        {kind && (
          <span className="muted">
            {kind.name}
            {a?.kind === 'code' && a.lang ? ` · ${a.lang}` : ''}
          </span>
        )}
      </div>
      {!a ? (
        <div className="artifact-empty muted">
          Пустой артефакт. Его наполняет Claude: попроси в чате сохранить результат «на доску».
        </div>
      ) : view === 'live' ? (
        <iframe
          key={reload}
          className="artifact-frame"
          title={name ?? 'Артефакт'}
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          srcDoc={html}
          data-testid="artifact-frame"
        />
      ) : (
        <pre className="artifact-source" data-testid="artifact-code">
          {a.source}
        </pre>
      )}
    </div>
  );
}
