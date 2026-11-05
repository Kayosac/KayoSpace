/**
 * Артефакты для агентов (решение 0023): Claude сохраняет то, что сделал в чате артефактом
 * (HTML, SVG, Mermaid, код), — на доску карточкой; и забирает обратно, чтобы продолжить.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type * as Y from 'yjs';
import {
  WORKSPACE_ID,
  addElement,
  elementsMap,
  freeSpot,
  getBoardName,
  listProjects,
  makeDocCard,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import {
  ARTIFACT_KINDS,
  artifactExcerpt,
  isDocId,
  readArtifact,
  writeArtifact,
  type ArtifactKind,
} from '@kayospace/page';
import type { BoardInfo } from './store';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

interface Source {
  get(board: string): Promise<Y.Doc>;
  has(board: string): Promise<boolean>;
  list(): Promise<BoardInfo[]>;
}

const artifactId = z
  .string()
  .regex(/^ar_[A-Za-z0-9_-]{1,61}$/)
  .describe('id артефакта: «ar_» и латиница, цифры, «-», «_»');

/** Доска «Входящие» (id inbox) — туда кладём, когда доска не названа; у новой — сразу имя. */
export function nameInbox(board: string, doc: Y.Doc, origin: unknown): void {
  if (board === 'inbox' && !getBoardName(doc)) setBoardName(doc, 'Входящие', origin);
}

const kinds = ARTIFACT_KINDS.map((k) => k.kind) as [ArtifactKind, ...ArtifactKind[]];

export function registerArtifactTools(
  server: McpServer,
  store: Source,
  origin: unknown,
  agentOf: () => Actor,
  readOnly = false,
): void {
  server.registerTool(
    'read_artifact',
    {
      annotations: { readOnlyHint: true },
      description:
        'Прочитать артефакт с доски (в list_boards — kind: "artifact", id «ar_…»): вид (html, svg, mermaid, code), ' +
        'язык и исходник целиком — чтобы показать его артефактом в чате и продолжить работу.',
      inputSchema: z.object({ artifact: artifactId }),
    },
    async ({ artifact }) => {
      if (!(await store.has(artifact)))
        return fail(`Артефакта «${artifact}» нет. Список — list_boards.`);
      const doc = await store.get(artifact);
      const a = readArtifact(doc);
      if (!a) return fail(`«${artifact}» пустой.`);
      return text(
        JSON.stringify(
          {
            artifact,
            name: getBoardName(doc) ?? artifact,
            kind: a.kind,
            ...(a.lang ? { lang: a.lang } : {}),
            link: `kayospace://board/${artifact}`,
            source: a.source,
          },
          null,
          2,
        ),
      );
    },
  );
  if (readOnly) return;

  server.registerTool(
    'save_artifact',
    {
      description:
        'Сохранить артефакт из чата в Kayospace: kind — html (страница, можно со скриптами и библиотеками с CDN), ' +
        'svg (рисунок), mermaid (схема), code (код с lang). С тем же id — новая версия на том же месте ' +
        '(«обнови на доске»): прежние видны в истории. Новый: id «ar_…» и name. board — положить карточку ' +
        'на эту доску (если её там ещё нет; «Входящие» — inbox); человек открывает артефакт касанием, живым.',
      inputSchema: z.object({
        artifact: artifactId,
        name: z.string().min(1).max(120).optional().describe('название (для нового — обязательно)'),
        kind: z.enum(kinds),
        lang: z.string().max(30).optional().describe('язык кода для kind "code"'),
        source: z.string().min(1).max(2_000_000),
        board: z
          .string()
          .regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/)
          .refine((id) => !isDocId(id), 'Карточку кладут на доску, а не в документ')
          .optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        project: z.string().optional().describe('id или название проекта для нового артефакта'),
      }),
    },
    async ({ artifact, name, kind, lang, source, board, x, y, project }) => {
      const existed = await store.has(artifact);
      if (!existed && !name) return fail('Новому артефакту нужно название (name).');
      let pid: string | undefined;
      if (project && !existed) {
        pid = listProjects(await store.get(WORKSPACE_ID)).find(
          (p) => p.id === project || p.name.toLowerCase() === project.toLowerCase(),
        )?.id;
        if (!pid) return fail(`Проекта «${project}» нет. Список — list_projects.`);
      }
      const doc = await store.get(artifact);
      doc.transact(() => {
        if (name) setBoardName(doc, name);
        writeArtifact(doc, { kind, ...(lang ? { lang } : {}), source });
      }, origin);
      if (pid) setBoardProject(await store.get(WORKSPACE_ID), artifact, pid, origin);
      let placed = '';
      if (board) {
        const target = await store.get(board);
        nameInbox(board, target, origin);
        const already = [...elementsMap(target).values()].some(
          (e) => e.type === 'doc' && e.props.doc === artifact,
        );
        if (!already) {
          const spot = x !== undefined && y !== undefined ? { x, y } : freeSpot(target);
          const card = makeDocCard(artifact, spot, {
            title: getBoardName(doc) ?? artifact,
            excerpt: artifactExcerpt(readArtifact(doc)),
            actor: agentOf(),
          });
          addElement(target, card, origin);
          placed = ` Карточка на доске ${board}: ${card.id}.`;
        } else placed = ` Карточка на доске ${board} уже есть — она покажет новую версию.`;
      }
      return text(
        `${existed ? 'Артефакт обновлён' : 'Артефакт сохранён'}: ${artifact}.${placed} Ссылка: kayospace://board/${artifact}`,
      );
    },
  );
}
