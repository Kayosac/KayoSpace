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
  computeTable,
  findColumn,
  hasTable,
  initTable,
  moveColumn,
  readTable,
  removeColumn,
  removeRows,
  setCellImages,
  setColumnWidth,
  setRowHeight,
  type CellImage,
  tableToMarkdown,
  updateColumn,
  updateRow,
  type ColumnType,
} from '@kayospace/page';
import type { BoardInfo } from './store';
import { imageInfo } from './images';
import { ingestImage, type ImageAssets } from './mcp-images';

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

/** Картинка ячейки от агента: уже лежащая (asset из read_table) или новая — по ссылке, файлом, svg. */
const cellImage = z.object({
  asset: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe('оставить картинку из read_table'),
  url: z.string().url().optional(),
  data: z.string().optional().describe('base64 или data:-адрес'),
  svg: z.string().optional().describe('нарисовать самому'),
  alt: z.string().max(300).optional().describe('подпись'),
});

export function registerTableTools(
  server: McpServer,
  store: Source,
  origin: unknown,
  readOnly = false,
  images: { assets: ImageAssets; allowPrivateUrls?: boolean } | null = null,
): void {
  server.registerTool(
    'read_table',
    {
      annotations: { readOnlyHint: true },
      description:
        'Прочитать таблицу Kayospace (в list_boards — kind: "table", id начинается с «tb_»). ' +
        'markdown — читать; json — колонки с типами и строки с id (для write_table), картинки ячеек ' +
        '(images: колонка → [{asset, w, h, alt}], посмотреть — get_image с board = id таблицы) и высоту строк.',
      inputSchema: z.object({ table: tableId, format: z.enum(['markdown', 'json']).optional() }),
    },
    async ({ table, format }) => {
      if (!(await store.has(table))) return fail(`Таблицы «${table}» нет. Список — list_boards.`);
      const doc = await store.get(table);
      const name = getBoardName(doc) ?? table;
      if (format === 'json') {
        const { columns, rows, errors } = computeTable(readTable(doc));
        return text(
          JSON.stringify(
            {
              table,
              name,
              columns,
              ...(Object.keys(errors).length ? { formulaErrors: errors } : {}),
              rows: rows.map((r) => ({
                id: r.id,
                values: Object.fromEntries(
                  columns.map((c) => [c.name, r.cells[c.id] ?? null] as const),
                ),
                ...(r.images
                  ? {
                      images: Object.fromEntries(
                        columns
                          .filter((c) => r.images?.[c.id])
                          .map((c) => [c.name, r.images![c.id]] as const),
                      ),
                    }
                  : {}),
                ...(r.height ? { height: r.height } : {}),
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
        `Типы колонок: ${TYPES_HELP}. Дата — YYYY-MM-DD, флажок — true/false, выбор — один из options, ` +
        'формула — в formula (значения считаются сами, писать их в строки не нужно). ' +
        'У существующей колонки: rename — новое название, position — место слева (0 — первая), ' +
        'width — ширина в пикселях (null — по умолчанию); ' +
        'delete_columns — удалить колонки вместе со значениями. ' +
        'Картинки — в любой ячейке рядом со значением: rows[].images — колонка → список целиком ' +
        '({asset} — оставить из read_table, {url}/{data}/{svg} — новая, alt — подпись; [] — убрать все); ' +
        'картинки вписываются в высоту строки: rows[].height — 40…800 пикселей (null — по тексту). ' +
        'Новая таблица: id «tb_…» и name; без columns получит «Название» и «Готово».',
      inputSchema: z.object({
        table: tableId,
        name: z.string().min(1).max(120).optional().describe('название (для новой — обязательно)'),
        project: z.string().optional().describe('id или название проекта для новой таблицы'),
        columns: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .max(80)
                .describe('название (или id) колонки; новой — её название'),
              type: z.enum(types).optional(),
              options: z.array(z.string().max(60)).max(50).optional(),
              formula: z
                .string()
                .max(1000)
                .optional()
                .describe(
                  'для type "formula": [Колонка], + − * / ^, ЕСЛИ/IF, ОКРУГЛ/ROUND, СУММ/SUM([Колонка]), ДНИ/DAYS, СЕГОДНЯ/TODAY',
                ),
              rename: z.string().min(1).max(80).optional().describe('новое название колонки'),
              width: z
                .number()
                .min(0)
                .max(5000)
                .nullable()
                .optional()
                .describe('ширина колонки в пикселях, 60…1200 (null — по умолчанию)'),
              position: z.number().int().min(0).optional().describe('место колонки слева, с 0'),
            }),
          )
          .max(40)
          .optional(),
        rows: z
          .array(
            z.object({
              id: z.string().optional(),
              values: z.record(z.string(), cell).optional(),
              images: z.record(z.string(), z.array(cellImage).max(20)).optional(),
              height: z.number().min(0).max(2000).nullable().optional(),
            }),
          )
          .max(500)
          .optional(),
        delete_rows: z.array(z.string()).max(500).optional(),
        delete_columns: z
          .array(z.string())
          .max(40)
          .optional()
          .describe('названия (или id) колонок, которые удалить со значениями'),
      }),
    },
    async ({ table, name, project, columns, rows, delete_rows, delete_columns }) => {
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
      // Картинки — заранее (скачать и положить в хранилище), правка таблицы — одной транзакцией.
      const ready = new Map<number, Record<string, CellImage[]>>();
      const imageErrors: string[] = [];
      for (const [i, r] of (rows ?? []).entries()) {
        if (!r.images) continue;
        if (!images) return fail('Картинки в таблицу здесь класть нельзя.');
        const out: Record<string, CellImage[]> = {};
        for (const [col, list] of Object.entries(r.images)) {
          out[col] = [];
          for (const src of list) {
            if (src.asset) {
              const bytes = await images.assets.get(src.asset);
              const info = bytes && imageInfo(bytes);
              if (!info) {
                imageErrors.push(`${src.asset.slice(0, 8)}…: такой картинки нет`);
                continue;
              }
              out[col]!.push({ asset: src.asset, w: info.width, h: info.height, alt: src.alt });
              continue;
            }
            const from = src.url
              ? { url: src.url }
              : src.data
                ? { data: src.data }
                : src.svg
                  ? { svg: src.svg }
                  : null;
            if (!from) {
              imageErrors.push('картинка без asset, url, data или svg');
              continue;
            }
            const got = await ingestImage(from, images.assets, {
              allowPrivateUrls: images.allowPrivateUrls,
            });
            if (typeof got === 'string') imageErrors.push(got);
            else
              out[col]!.push({
                asset: got.id,
                w: got.info.width,
                h: got.info.height,
                alt: src.alt,
              });
          }
        }
        ready.set(i, out);
      }
      const doc = await store.get(table);
      const unknown = new Set<string>();
      let added = 0;
      let changed = 0;
      let missing = 0;
      let removed = 0;
      let removedCols = 0;
      const missingCols: string[] = [];
      doc.transact(() => {
        if (name) setBoardName(doc, name);
        if (!hasTable(doc)) {
          if (columns?.length)
            initTable(
              doc,
              columns.map((c) => ({
                name: c.rename ?? c.name,
                type: c.type ?? (c.formula ? 'formula' : 'text'),
                options: c.options,
                formula: c.formula,
                ...(c.width ? { width: c.width } : {}),
              })),
            );
          else initTable(doc);
        } else {
          for (const c of columns ?? []) {
            const have = findColumn(readTable(doc).columns, c.name);
            const id = have
              ? have.id
              : addColumn(doc, {
                  name: c.rename ?? c.name,
                  type: c.type ?? (c.formula ? 'formula' : 'text'),
                  options: c.options,
                  formula: c.formula,
                });
            if (c.width !== undefined) setColumnWidth(doc, id, c.width);
            if (have && (c.type || c.options || c.formula || c.rename))
              updateColumn(doc, have.id, {
                ...(c.type ? { type: c.type } : {}),
                ...(c.options ? { options: c.options } : {}),
                ...(c.formula ? { formula: c.formula } : {}),
                ...(c.rename ? { name: c.rename } : {}),
              });
            if (c.position !== undefined) {
              const at = readTable(doc).columns.findIndex((x) => x.id === id);
              if (at >= 0) moveColumn(doc, id, c.position - at);
            }
          }
        }
        for (const ref of delete_columns ?? []) {
          const col = findColumn(readTable(doc).columns, ref);
          if (col) {
            removeColumn(doc, col.id);
            removedCols++;
          } else missingCols.push(ref);
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
        for (const [i, r] of (rows ?? []).entries()) {
          let id: string | null = r.id ?? null;
          if (id) {
            if (updateRow(doc, id, byName(r.values ?? {}))) changed++;
            else {
              missing++;
              id = null;
            }
          } else {
            id = addRow(doc, byName(r.values ?? {}));
            added++;
          }
          if (!id) continue;
          for (const [col, list] of Object.entries(ready.get(i) ?? {})) {
            const c = findColumn(cols, col);
            if (c) setCellImages(doc, id, c.id, list);
            else unknown.add(col);
          }
          if (r.height !== undefined) setRowHeight(doc, id, r.height);
        }
        if (delete_rows?.length) removed = removeRows(doc, delete_rows);
      }, origin);
      if (pid) setBoardProject(await store.get(WORKSPACE_ID), table, pid, origin);
      const parts = [
        existed ? 'Таблица изменена' : 'Таблица создана',
        added ? `строк добавлено: ${added}` : '',
        changed ? `изменено: ${changed}` : '',
        removed ? `удалено: ${removed}` : '',
        removedCols ? `колонок удалено: ${removedCols}` : '',
        missingCols.length ? `колонок для удаления нет: ${missingCols.join(', ')}` : '',
        missing ? `строк с такими id нет: ${missing}` : '',
        unknown.size ? `колонок нет: ${[...unknown].join(', ')} (добавь их в columns)` : '',
        imageErrors.length ? `картинки не добавлены: ${imageErrors.join('; ')}` : '',
      ].filter(Boolean);
      return text(`${parts.join('; ')}. ${table}, ссылка kayospace://board/${table}`);
    },
  );
}

/** Строки таблицы текстом — для fetch. */
export function tableText(doc: Y.Doc): string {
  const { columns, rows } = computeTable(readTable(doc));
  return rows
    .map((r) => columns.map((c) => `${c.name}: ${cellText(c, r.cells[c.id])}`).join('; '))
    .join('\n');
}
