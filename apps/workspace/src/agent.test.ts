import { describe, expect, it } from 'vitest';
import { agentSummary, agentTitle } from './AgentBar';

describe('плашка правок агента', () => {
  it('имя агента — по имени клиента MCP', () => {
    expect(agentTitle('claude-code')).toBe('Claude Code');
    expect(agentTitle('Claude')).toBe('Claude');
    expect(agentTitle('ChatGPT')).toBe('ChatGPT');
    expect(agentTitle('openai-mcp')).toBe('ChatGPT');
    expect(agentTitle('mcp')).toBe('Агент');
    expect(agentTitle('kayospace-ai')).toBe('ИИ');
    expect(agentTitle('Мой бот')).toBe('Мой бот');
  });

  it('что сделал — коротко', () => {
    expect(agentSummary({ added: 6, updated: 2, deleted: 1 })).toBe(
      'добавил 6, изменил 2, удалил 1',
    );
    expect(agentSummary({ added: 0, updated: 1, deleted: 0 })).toBe('изменил 1');
  });
});
