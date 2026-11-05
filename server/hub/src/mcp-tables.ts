/**
 * Таблицы для агентов (решение 0021, фаза 5.4): read_table и write_table. Колонки — по названию
 * (или id), значения приводятся к типу колонки; строки — по id из read_table.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  WORKSPACE_ID,
  getBoardName,
  listProjects,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import {
  COLUMN_TYPES,
  addColumn,
  addRow,
  cellText,
  findColumn,
  hasTable,
  initTable,
  readTable,
  removeRows,
  tableToMarkdown,
  updateColumn,
  updateRow,
  type ColumnType,
} from '@kayospace/page';
import type { BoardInfo } from './store';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
  list(): Promise<BoardInfo[]>;
}

const tableId = z
  .string()
  .regex(/^tb_[A-Za-z0-9_-]{1,61}$/)
  .describe('id таблицы: «tb_» и латиница, цифры, «-», «_»');

const types = COLUMN_TYPES.map((t) => t.type) as [ColumnType, ...ColumnType[]];
const TYPES_HELP = COLUMN_TYPES.map((t) => `${t.type} — ${t.name.toLowerCase()}`).join(', ');

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function registerTableTools(
  server: McpServer,
  store: Source,
  origin: unknown,
  readOnly = false,
): void {
  server.registerTool(
    'read_table',
    {
      annotations: { readOnlyHint: true },
      description:
        'Прочитать таблицу Kayospace (в list_boards — kind: "table", id начинается с «tb_»). ' +
        'markdown — читать; json — колонки с типами и строки с id (для write_table).',
      inputSchema: z.object({ table: tableId, format: z.enum(['markdown', 'json']).optional() }),
    },
    async ({ table, format }) => {
      if (!(await store.has(table))) return fail(`Таблицы «${table}» нет. Список — list_boards.`);
      const doc = await store.get(table);
      const name = getBoardName(doc) ?? table;
      if (format === 'json') {
        const { columns, rows } = readTable(doc);
        return text(
          JSON.stringify(
            {
              table,
              name,
              columns,
              rows: rows.map((r) => ({
                id: r.id,
                values: Object.fromEntries(
                  columns.map((c) => [c.name, r.cells[c.id] ?? null] as const),
                ),
              })),
            },
            null,
            2,
          ),
        );
      }
      return text(
        `# ${name}\n\n(таблица ${table}, ссылка kayospace://board/${table})\n\n${tableToMarkdown(doc)}`,
      );
    },
  );

  if (readOnly) return;
  server.registerTool(
    'write_table',
    {
      description:
        'Создать или изменить таблицу: колонки (новые по названию; у существующих можно сменить тип и варианты), ' +
        'строки (с id — изменить, без id — добавить; значения по названию колонки), удалить строки. ' +
        `Типы колонок: ${TYPES_HELP}. Дата — YYYY-MM-DD, флажок — true/false, выбор — один из options. ` +
        'Новая таблица: id «tb_…» и name; без columns получит «Название» и «Готово».',
      inputSchema: z.object({
        table: tableId,
        name: z.string().min(1).max(120).optional().describe('название (для новой — обязательно)'),
        project: z.string().optional().describe('id или название проекта для новой таблицы'),
        columns: z
          .array(
            z.object({
              name: z.string().min(1).max(80),
              type: z.enum(types).optional(),
              options: z.array(z.string().max(60)).max(50).optional(),
            }),
          )
          .max(40)
          .optional(),
        rows: z
          .array(z.object({ id: z.string().optional(), values: z.record(z.string(), cell) }))
          .max(500)
          .optional(),
        delete_rows: z.array(z.string()).max(500).optional(),
      }),
    },
    async ({ table, name, project, columns, rows, delete_rows }) => {
      const existed = await store.has(table);
      if (!existed && !name) return fail('Новой таблице нужно название (name).');
      let pid: string | undefined;
      if (project && !existed) {
        const ws = await store.get(WORKSPACE_ID);
        pid = listProjects(ws).find(
          (p) => p.id === project || p.name.toLowerCase() === project.toLowerCase(),
        )?.id;
        if (!pid) return fail(`Проекта «${project}» нет. Список — list_projects.`);
      }
      const doc = await store.get(table);
      const unknown = new Set<string>();
      let added = 0;
      let changed = 0;
      let missing = 0;
      let removed = 0;
      doc.transact(() => {
        if (name) setBoardName(doc, name);
        if (!hasTable(doc)) {
          if (columns?.length)
            initTable(
              doc,
              columns.map((c) => ({ name: c.name, type: c.type ?? 'text', options: c.options })),
            );
          else initTable(doc);
        } else {
          for (const c of columns ?? []) {
            const have = findColumn(readTable(doc).columns, c.name);
            if (!have) addColumn(doc, { name: c.name, type: c.type ?? 'text', options: c.options });
            else if (c.type || c.options)
              updateColumn(doc, have.id, {
                ...(c.type ? { type: c.type } : {}),
                ...(c.options ? { options: c.options } : {}),
              });
          }
        }
        const cols = readTable(doc).columns;
        const byName = (values: Record<string, unknown>): Record<string, unknown> => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(values)) {
            const col = findColumn(cols, k);
            if (col) out[col.id] = v;
            else unknown.add(k);
          }
          return out;
        };
        for (const r of rows ?? []) {
          if (r.id) {
            if (updateRow(doc, r.id, byName(r.values))) changed++;
            else missing++;
          } else {
            addRow(doc, byName(r.values));
            added++;
          }
        }
        if (delete_rows?.length) removed = removeRows(doc, delete_rows);
      }, origin);
      if (pid) setBoardProject(await store.get(WORKSPACE_ID), table, pid, origin);
      const parts = [
        existed ? 'Таблица изменена' : 'Таблица создана',
        added ? `строк добавлено: ${added}` : '',
        changed ? `изменено: ${changed}` : '',
        removed ? `удалено: ${removed}` : '',
        missing ? `строк с такими id нет: ${missing}` : '',
        unknown.size ? `колонок нет: ${[...unknown].join(', ')} (добавь их в columns)` : '',
      ].filter(Boolean);
      return text(`${parts.join('; ')}. ${table}, ссылка kayospace://board/${table}`);
    },
  );
}

/** Строки таблицы текстом — для fetch. */
export function tableText(doc: Y.Doc): string {
  const { columns, rows } = readTable(doc);
  return rows
    .map((r) => columns.map((c) => `${c.name}: ${cellText(c, r.cells[c.id])}`).join('; '))
    .join('\n');
}
