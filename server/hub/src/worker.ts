/**
 * Исполнитель ИИ: берёт задачи с хаба и выполняет их официальным Claude Code (`claude -p`),
 * вошедшим в аккаунт владельца (решение 0007). Claude работает с доской через MCP хаба —
 * в черновике задачи. Задачи — строго по одной; у каждой предел по времени.
 *
 * Запуск: pnpm ai-worker (переменные HUB_URL, HUB_TOKEN; см. main внизу и docs).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WorkerOptions {
  /** Адрес хаба, например http://hub:4000 или https://x.sslip.io:8443. */
  hubUrl: string;
  token: string;
  name: string;
  /** Команда Claude Code (по умолчанию «claude»). */
  claudeBin?: string;
  /** Модель: sonnet (по умолчанию), opus, haiku… */
  model?: string;
  /** Предел на задачу, мс. */
  timeoutMs?: number;
  /** Остановить цикл (для тестов). */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

interface Task {
  id: string;
  board: string;
  prompt: string;
  image: string | null;
  mcpPath: string;
}

/** Аргументы Claude Code для одной задачи. */
export function claudeArgs(prompt: string, mcpConfigPath: string, model: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    // Из встроенных инструментов — только чтение файлов (картинка выделения).
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    'mcp__kayospace',
    // Всё, что не разрешено явно, — отказ без вопроса: спрашивать некого.
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    '40',
    '--model',
    model,
  ];
}

/** Итог из вывода `claude -p --output-format json`. */
export function parseClaudeOutput(stdout: string): { message?: string; error?: string } {
  const text = stdout.trim();
  if (!text) return { error: 'Claude Code ничего не ответил' };
  try {
    const j = JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)) as {
      result?: string;
      is_error?: boolean;
      subtype?: string;
    };
    if (j.is_error || (j.subtype && j.subtype !== 'success')) {
      return { error: j.result || `Claude Code завершился с ошибкой (${j.subtype ?? 'error'})` };
    }
    return { message: j.result ?? '' };
  } catch {
    return { message: text.slice(-2000) };
  }
}

export async function runTask(
  task: Task,
  opts: WorkerOptions,
): Promise<{ message?: string; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kayospace-ai-'));
  try {
    if (task.image) await writeFile(join(dir, 'selection.png'), Buffer.from(task.image, 'base64'));
    const config = {
      mcpServers: {
        kayospace: {
          type: 'http',
          url: new URL(task.mcpPath, opts.hubUrl).toString(),
          headers: { Authorization: `Bearer ${opts.token}` },
        },
      },
    };
    const cfg = join(dir, 'mcp.json');
    await writeFile(cfg, JSON.stringify(config), { mode: 0o600 });
    const args = claudeArgs(task.prompt, cfg, opts.model ?? 'sonnet');
    const { code, stdout, stderr, timedOut } = await run(
      opts.claudeBin ?? 'claude',
      args,
      dir,
      opts.timeoutMs ?? 180_000,
    );
    if (timedOut) return { error: 'ИИ не уложился во время — задача остановлена' };
    if (code !== 0 && !stdout.trim()) {
      const hint = /login|auth|token|401/i.test(stderr)
        ? 'Claude Code не вошёл в аккаунт: выполните claude setup-token и задайте CLAUDE_CODE_OAUTH_TOKEN'
        : stderr.trim().slice(-500) || `Claude Code завершился с кодом ${code}`;
      return { error: hint };
    }
    return parseClaudeOutput(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `Не запускается ${cmd}: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Главный цикл: опрашивать хаб, выполнять по одной задаче. */
export async function workLoop(opts: WorkerOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[ai-worker] ${m}`));
  const headers = { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' };
  let pause = 1000;
  while (!opts.signal?.aborted) {
    let task: Task | null = null;
    try {
      const res = await fetch(new URL('/api/ai/worker/next', opts.hubUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: opts.name }),
        signal: opts.signal,
      });
      if (res.status === 401) throw new Error('хаб не принял токен (HUB_TOKEN)');
      if (res.status === 200) task = (await res.json()) as Task;
      pause = 1000;
    } catch (err) {
      if (opts.signal?.aborted) return;
      log(
        `нет связи с хабом: ${err instanceof Error ? err.message : err}; повтор через ${pause / 1000} с`,
      );
      await new Promise((r) => setTimeout(r, pause));
      pause = Math.min(pause * 2, 30_000);
      continue;
    }
    if (!task) continue;
    log(`задача ${task.id} (доска ${task.board})`);
    const started = Date.now();
    const result = await runTask(task, opts).catch((err: unknown) => ({
      error: `Исполнитель: ${err instanceof Error ? err.message : String(err)}`,
    }));
    log(
      `задача ${task.id}: ${result.error ? `ошибка — ${result.error}` : 'готово'} за ${Math.round((Date.now() - started) / 1000)} с`,
    );
    await fetch(new URL(`/api/ai/worker/tasks/${task.id}/done`, opts.hubUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(result),
    }).catch(() => log('не удалось сообщить хабу результат'));
  }
}
