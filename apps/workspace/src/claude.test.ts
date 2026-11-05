import { describe, expect, it } from 'vitest';
import { claudePrompt, claudeUrl } from './claude';

describe('«В Claude»', () => {
  it('просьба забрать с доски нужным инструментом', () => {
    expect(claudePrompt('ar_calc', 'Калькулятор')).toContain(
      'артефакт «Калькулятор» (ar_calc) — read_artifact',
    );
    expect(claudePrompt('tb_x', null)).toContain('таблицу (tb_x) — read_table');
    expect(claudePrompt('pg_x', ' ')).toContain('документ (pg_x) — read_page');
  });
  it('ссылка на новый чат с текстом', () => {
    expect(claudeUrl('а & б')).toBe('https://claude.ai/new?q=%D0%B0%20%26%20%D0%B1');
  });
});
