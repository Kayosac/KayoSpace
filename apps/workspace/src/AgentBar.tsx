import { useEffect, useState } from 'react';
import type { AgentActivity, CanvasEngine } from '@kayospace/canvas';
import { CloseIcon, SparkleIcon } from './icons';

/** Имя агента для человека: из имени клиента MCP. */
export function agentTitle(name: string): string {
  if (/claude[- ]?code/i.test(name)) return 'Claude Code';
  if (/chatgpt|openai/i.test(name)) return 'ChatGPT';
  if (/claude/i.test(name)) return 'Claude';
  if (name === 'kayospace-ai') return 'ИИ';
  if (!name || name === 'mcp') return 'Агент';
  return name;
}

/** «добавил 6, изменил 2, удалил 1». */
export function agentSummary(a: Pick<AgentActivity, 'added' | 'updated' | 'deleted'>): string {
  const parts: string[] = [];
  if (a.added) parts.push(`добавил ${a.added}`);
  if (a.updated) parts.push(`изменил ${a.updated}`);
  if (a.deleted) parts.push(`удалил ${a.deleted}`);
  return parts.join(', ');
}

/**
 * Плашка «Claude добавил 6 · Показать · Отменить»: что агент только что сделал на открытой доске.
 * Отмена — своя правка: её, в свою очередь, отменяет «Отменить» на панели.
 */
export function AgentBar({
  engine,
  onToast,
}: {
  engine: CanvasEngine;
  onToast: (text: string) => void;
}) {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  useEffect(() => engine.onAgentActivity(setActivity), [engine]);
  if (!activity) return null;
  return (
    <div className="agent-bar" role="status" data-testid="agent-bar">
      <span className="agent-icon">
        <SparkleIcon />
      </span>
      <span className="agent-text">
        <b>{agentTitle(activity.name)}</b> {agentSummary(activity)}
      </span>
      {activity.ids.length > 0 && (
        <button className="link-btn" onClick={() => engine.showAgentActivity()}>
          Показать
        </button>
      )}
      <button
        className="secondary"
        data-testid="agent-revert"
        onClick={() => {
          const r = engine.revertAgentActivity();
          onToast(
            r.skipped
              ? `Отменено: ${r.reverted}. Не тронуто ${r.skipped} — их уже правили после агента.`
              : `Правки агента отменены (${r.reverted}). Вернуть — «Отменить» на панели.`,
          );
        }}
      >
        Отменить
      </button>
      <button
        className="icon-btn"
        aria-label="Скрыть"
        title="Скрыть"
        onClick={() => engine.dismissAgentActivity()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
