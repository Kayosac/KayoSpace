import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthServer, redirectMatches } from './oauth';

describe('вход по OAuth для коннекторов', () => {
  it('регистрация, вход по токену хаба, PKCE, обновление с ротацией, сохранение на диск', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-'));
    const oauth = new OAuthServer(join(dir, 'oauth.json'), 'hub-secret');
    await oauth.init();
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (!(await oauth.handle(req, res, url))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.registration_endpoint).toBe(`${base}/oauth/register`);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(`${base}/mcp`);
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'],
        client_name: 'Claude',
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'http://localhost:5555/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const pageRes = await fetch(`${base}/oauth/authorize?${q}`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('Разрешить');
    const bad = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      body: new URLSearchParams({ ...Object.fromEntries(q), hub_token: 'nope', decision: 'allow' }),
      redirect: 'manual',
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      body: new URLSearchParams({
        ...Object.fromEntries(q),
        hub_token: 'hub-secret',
        decision: 'allow',
      }),
      redirect: 'manual',
    });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;
    const wrongVerifier = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id,
        redirect_uri: 'http://localhost:5555/callback',
        code_verifier: 'x'.repeat(43),
      }),
    });
    expect(wrongVerifier.status).toBe(400);
    // код одноразовый: после неудачной попытки он сгорел — получаем новый
    const ok2 = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      body: new URLSearchParams({
        ...Object.fromEntries(q),
        hub_token: 'hub-secret',
        decision: 'allow',
      }),
      redirect: 'manual',
    });
    const code2 = new URL(ok2.headers.get('location')!).searchParams.get('code')!;
    const tok = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        client_id,
        redirect_uri: 'http://localhost:5555/callback',
        code_verifier: verifier,
      }),
    });
    expect(tok.status).toBe(200);
    const t = await tok.json();
    expect(oauth.validAccessToken(t.access_token)).toBe(true);
    expect(oauth.validAccessToken('nope')).toBe(false);
    const ref = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id,
      }),
    });
    expect(ref.status).toBe(200);
    const again = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id,
      }),
    });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('invalid_grant');
    await oauth.flush();
    const reloaded = new OAuthServer(join(dir, 'oauth.json'), 'hub-secret');
    await reloaded.init();
    expect(reloaded.validAccessToken(t.access_token)).toBe(true);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:9999/callback')).toBe(
      true,
    );
    expect(
      redirectMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://evil.ai/api/mcp/auth_callback',
      ),
    ).toBe(false);
    srv.close();
  });
});
