/**
 * Вход по OAuth 2.1 для MCP — чтобы подключать Kayospace коннектором в приложении Claude
 * (claude.ai, телефон, компьютер) и в Claude Code без токена в команде.
 *
 * Как это устроено (требования Claude к коннекторам):
 *   - /mcp без токена отвечает 401 с указателем на метаданные ресурса;
 *   - /.well-known/oauth-protected-resource и /.well-known/oauth-authorization-server — описание;
 *   - /oauth/register — динамическая регистрация клиента (RFC 7591), клиенты публичные;
 *   - /oauth/authorize — страница «Разрешить доступ»: человек один раз вводит токен хаба;
 *   - /oauth/token — обмен кода (PKCE S256 обязателен) и обновление с ротацией refresh-токена.
 * Токены хранятся только в виде SHA-256, на диске — data/oauth.json.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenMatches } from './auth';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_SCOPE = 'kayospace';

interface Client {
  redirectUris: string[];
  name: string;
  createdAt: number;
}

interface Grant {
  clientId: string;
  /** Unix-время окончания, мс. */
  exp: number;
}

interface PendingCode extends Grant {
  redirectUri: string;
  challenge: string;
  resource: string | null;
}

interface Persisted {
  clients: Record<string, Client>;
  access: Record<string, Grant>;
  refresh: Record<string, Grant>;
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const random = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Адрес возврата: https или локальный (Claude Code открывает порт на своём компьютере). */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Совпадение адреса возврата; у localhost/127.0.0.1 порт не учитывается (RFC 8252). */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    const loop = (h: string) => h === 'localhost' || h === '127.0.0.1';
    return (
      a.protocol === 'http:' &&
      b.protocol === 'http:' &&
      loop(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

/** Базовый адрес хаба, как его видит клиент (за Caddy — https и порт из Host). */
export function publicBase(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  return `${proto || 'http'}://${req.headers.host ?? 'localhost'}`;
}

export class OAuthServer {
  private data: Persisted = { clients: {}, access: {}, refresh: {} };
  private readonly codes = new Map<string, PendingCode>();
  /** Неверные токены на странице входа: защита от перебора. */
  private readonly failures = new Map<string, number[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string,
    private readonly hubToken: string,
  ) {}

  async init(): Promise<void> {
    try {
      this.data = {
        clients: {},
        access: {},
        refresh: {},
        ...JSON.parse(await readFile(this.file, 'utf8')),
      };
    } catch {
      /* файла ещё нет */
    }
    this.prune();
  }

  /** Действующий ли OAuth-токен доступа. */
  validAccessToken(token: string | undefined): boolean {
    if (!token) return false;
    const g = this.data.access[hash(token)];
    return Boolean(g && g.exp > Date.now() && this.data.clients[g.clientId]);
  }

  /** Обработать запрос, если он относится к OAuth. false — не наш адрес. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const base = publicBase(req);
    const p = url.pathname;
    if (
      p === '/.well-known/oauth-protected-resource' ||
      p === '/.well-known/oauth-protected-resource/mcp'
    ) {
      json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: [OAUTH_SCOPE],
        bearer_methods_supported: ['header'],
        resource_name: 'Kayospace',
      });
      return true;
    }
    if (
      p === '/.well-known/oauth-authorization-server' ||
      p === '/.well-known/openid-configuration'
    ) {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [OAUTH_SCOPE],
      });
      return true;
    }
    if (p === '/oauth/register' && req.method === 'POST') {
      await this.register(req, res);
      return true;
    }
    if (p === '/oauth/authorize') {
      if (req.method === 'GET') this.authorizePage(res, url.searchParams);
      else if (req.method === 'POST') await this.authorizeSubmit(req, res);
      else json(res, 405, { error: 'invalid_request' });
      return true;
    }
    if (p === '/oauth/token' && req.method === 'POST') {
      await this.token(req, res);
      return true;
    }
    return false;
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = JSON.parse((await readText(req, 64 * 1024)) || '{}');
    } catch {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Нужен JSON' });
    }
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u) => typeof u === 'string')
      : [];
    if (uris.length === 0 || !uris.every(redirectAllowed)) {
      return json(res, 400, {
        error: 'invalid_redirect_uri',
        error_description: 'Адреса возврата — https или localhost',
      });
    }
    if (Object.keys(this.data.clients).length > 500) this.dropOldestClients();
    const id = `kc_${random(18)}`;
    const name =
      typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Клиент MCP';
    this.data.clients[id] = { redirectUris: uris as string[], name, createdAt: Date.now() };
    this.save();
    json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  /** Проверить параметры запроса на вход; строка — описание ошибки. */
  private checkAuthorize(q: URLSearchParams): { client: Client; clientId: string } | string {
    const clientId = q.get('client_id') ?? '';
    const client = this.data.clients[clientId];
    if (!client) return 'Неизвестный клиент. Добавьте коннектор заново.';
    const redirect = q.get('redirect_uri') ?? '';
    if (!client.redirectUris.some((r) => redirectMatches(r, redirect)))
      return 'Неверный адрес возврата.';
    if (q.get('response_type') !== 'code') return 'Поддерживается только response_type=code.';
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      return 'Нужен PKCE (S256).';
    }
    return { client, clientId };
  }

  private authorizePage(res: ServerResponse, q: URLSearchParams, error?: string): void {
    const check = this.checkAuthorize(q);
    if (typeof check === 'string')
      return html(res, 400, page('Не получилось', `<p class="bad">${esc(check)}</p>`));
    const redirectHost = new URL(q.get('redirect_uri')!).host;
    const hidden = [...q.entries()]
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    html(
      res,
      error ? 401 : 200,
      page(
        'Доступ к Kayospace',
        `<p><b>${esc(check.client.name)}</b> просит доступ к вашим доскам: читать, добавлять и менять элементы.</p>
<p class="muted">После входа вас вернут на <b>${esc(redirectHost)}</b>.</p>
<form method="post" action="/oauth/authorize">${hidden}
<label>Токен хаба<input name="hub_token" type="password" autocomplete="current-password" required autofocus></label>
${error ? `<p class="bad">${esc(error)}</p>` : ''}
<p class="muted">Токен — строка HUB_TOKEN из deploy/.env на сервере. Вводится один раз, дальше Claude входит сам.</p>
<div class="row"><button name="decision" value="allow" class="primary">Разрешить</button>
<button name="decision" value="deny" formnovalidate>Отказать</button></div></form>`,
      ),
    );
  }

  private async authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readText(req, 16 * 1024));
    const check = this.checkAuthorize(form);
    if (typeof check === 'string')
      return html(res, 400, page('Не получилось', `<p class="bad">${esc(check)}</p>`));
    const redirect = new URL(form.get('redirect_uri')!);
    const state = form.get('state');
    if (state) redirect.searchParams.set('state', state);
    if (form.get('decision') !== 'allow') {
      redirect.searchParams.set('error', 'access_denied');
      return redirectTo(res, redirect.toString());
    }
    const ip = req.socket.remoteAddress ?? '?';
    if (this.tooManyFailures(ip)) {
      return this.authorizePage(res, form, 'Слишком много неверных попыток. Подождите минуту.');
    }
    if (!tokenMatches(form.get('hub_token'), this.hubToken)) {
      this.failures.set(ip, [...(this.failures.get(ip) ?? []), Date.now()]);
      return this.authorizePage(res, form, 'Токен не подошёл.');
    }
    const code = random();
    this.codes.set(hash(code), {
      clientId: check.clientId,
      redirectUri: form.get('redirect_uri')!,
      challenge: form.get('code_challenge')!,
      resource: form.get('resource'),
      exp: Date.now() + CODE_TTL_MS,
    });
    redirect.searchParams.set('code', code);
    redirectTo(res, redirect.toString());
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readText(req, 16 * 1024));
    const grant = form.get('grant_type');
    const clientId = form.get('client_id') ?? '';
    if (grant === 'authorization_code') {
      const key = hash(form.get('code') ?? '');
      const pending = this.codes.get(key);
      this.codes.delete(key); // код одноразовый
      if (
        !pending ||
        pending.exp < Date.now() ||
        pending.clientId !== clientId ||
        pending.redirectUri !== form.get('redirect_uri') ||
        !pkceMatches(form.get('code_verifier') ?? '', pending.challenge)
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      return json(res, 200, this.issue(clientId));
    }
    if (grant === 'refresh_token') {
      const key = hash(form.get('refresh_token') ?? '');
      const g = this.data.refresh[key];
      if (!g || g.exp < Date.now() || g.clientId !== clientId || !this.data.clients[clientId]) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      delete this.data.refresh[key]; // ротация: старый refresh-токен больше не действует
      return json(res, 200, this.issue(clientId));
    }
    json(res, 400, { error: 'unsupported_grant_type' });
  }

  private issue(clientId: string) {
    const access = random();
    const refresh = random();
    const now = Date.now();
    this.data.access[hash(access)] = { clientId, exp: now + ACCESS_TTL_S * 1000 };
    this.data.refresh[hash(refresh)] = { clientId, exp: now + REFRESH_TTL_S * 1000 };
    this.prune();
    this.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: OAUTH_SCOPE,
    };
  }

  private tooManyFailures(ip: string): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => Date.now() - t < 60_000);
    this.failures.set(ip, recent);
    return recent.length >= 5;
  }

  private prune(): void {
    const now = Date.now();
    for (const store of [this.data.access, this.data.refresh]) {
      for (const [k, g] of Object.entries(store)) if (g.exp < now) delete store[k];
    }
    for (const [k, c] of this.codes) if (c.exp < now) this.codes.delete(k);
  }

  private dropOldestClients(): void {
    const used = new Set(
      [...Object.values(this.data.refresh), ...Object.values(this.data.access)].map(
        (g) => g.clientId,
      ),
    );
    const idle = Object.entries(this.data.clients)
      .filter(([id]) => !used.has(id))
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of idle.slice(0, 100)) delete this.data.clients[id];
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error('[hub] не удалось сохранить OAuth', err));
    }, 200);
  }

  /** Записи на диск — строго по очереди: две одновременные делили бы один временный файл. */
  private writing: Promise<void> = Promise.resolve();

  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const run = async (): Promise<void> => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(tmp, this.file);
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }
}

function readText(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? '' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Страницу входа нельзя встроить в чужой сайт (защита от подмены кликов).
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
  });
  res.end(body);
}

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>
:root{--bg:#f6f5f1;--card:#fff;--text:#1c1f26;--muted:#6c7080;--line:rgba(28,31,38,.12);--accent:#3e63dd;--on:#fff;--bad:#d93d42}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--card:#20232a;--text:#e9e7e2;--muted:#9a9eaa;--line:rgba(233,231,226,.12);--accent:#7c9bff;--on:#10131a;--bad:#ff6b6f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px}
main{width:min(420px,100%);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 12px}.muted{color:var(--muted);font-size:13px}.bad{color:var(--bad)}
label{display:grid;gap:6px;margin:16px 0 8px;font-size:13px;color:var(--muted)}
input[type=password]{height:42px;padding:0 12px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px}
.row{display:flex;gap:8px;margin-top:16px}button{height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:none;color:var(--text);font:inherit;cursor:pointer}
.primary{background:var(--accent);color:var(--on);border-color:transparent;font-weight:600}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
