import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/update.sh — автообновление хаба на сервере (решение 0014). Проверяем логику без сети и Docker:
 * curl, git и docker подменены заглушками, которые пишут свои вызовы в журнал.
 */
const SCRIPT = fileURLToPath(new URL('../../../deploy/update.sh', import.meta.url));

let root: string;
let dir: string;
let calls: string;

function stub(name: string, body: string): void {
  const p = join(root, 'bin', name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(env: { tag: string; healthy: boolean; dockerFails?: boolean }) {
  writeFileSync(join(root, 'healthy'), env.healthy ? '1' : '0');
  return spawnSync('bash', [join(dir, 'deploy', 'update.sh')], {
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      DIR: dir,
      API: 'https://api.example/releases/latest',
      INSTALL_TO: join(root, 'installed-update'),
      HEALTH_TRIES: '2',
      HEALTH_SLEEP: '0',
      FAKE_TAG: env.tag,
      DOCKER_RC: env.dockerFails ? '1' : '0',
    },
  });
}

const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
const state = (f: string) =>
  existsSync(join(dir, 'deploy', f)) ? readFileSync(join(dir, 'deploy', f), 'utf8').trim() : null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kayospace-update-'));
  dir = join(root, 'kayospace');
  calls = join(root, 'calls.log');
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'deploy', 'update.sh'));
  writeFileSync(
    join(dir, 'deploy', '.env'),
    'HUB_DOMAIN=hub.example\nHTTPS_PORT=443\nHUB_TOKEN=x\n',
  );
  stub(
    'curl',
    `case "$*" in
  *api.example*) printf '{"url":"x","tag_name": "%s","name":"r"}' "$FAKE_TAG" ;;
  *health*) [ "$(cat "${root}/healthy")" = 1 ] && echo '{"ok":true,"version":"0.5.0"}' || exit 22 ;;
esac`,
  );
  stub('git', `[ "$3" = rev-parse ] && echo prevsha; exit 0`);
  stub('docker', 'exit "$DOCKER_RC"');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('автообновление хаба (deploy/update.sh)', () => {
  it('новый релиз: код релиза, пересборка, проверка, запомнить; второй запуск ничего не делает', () => {
    const r = run({ tag: 'v0.11.1', healthy: true });
    expect(r.status).toBe(0);
    expect(log()).toContain('git -C');
    expect(log()).toContain('fetch --depth 1 origin refs/tags/v0.11.1:refs/tags/v0.11.1');
    expect(log()).toContain('reset --hard v0.11.1');
    expect(log()).toContain('docker compose up -d --build --remove-orphans');
    expect(log()).toContain('curl -fsS --max-time 5 https://hub.example/health');
    expect(state('.deployed')).toBe('v0.11.1');
    expect(existsSync(join(root, 'installed-update'))).toBe(true);

    writeFileSync(calls, '');
    expect(run({ tag: 'v0.11.1', healthy: true }).status).toBe(0);
    expect(log()).not.toContain('docker');
  });

  it('не поднялся — откат на прежний код, неудачный релиз не пересобирается каждые 10 минут', () => {
    writeFileSync(join(dir, 'deploy', '.deployed'), 'v0.11.0');
    const r = run({ tag: 'v0.11.1', healthy: false });
    expect(r.status).toBe(1);
    expect(log()).toContain('reset --hard prevsha');
    expect(state('.deployed')).toBe('v0.11.0');
    expect(state('.failed')).toBe('v0.11.1');

    writeFileSync(calls, '');
    expect(run({ tag: 'v0.11.1', healthy: true }).status).toBe(0);
    expect(log()).not.toContain('docker');
    // Следующий релиз — снова пробуем.
    expect(run({ tag: 'v0.11.2', healthy: true }).status).toBe(0);
    expect(state('.deployed')).toBe('v0.11.2');
    expect(state('.failed')).toBeNull();
  });

  it('нет сети или странный ответ — ничего не трогаем', () => {
    expect(run({ tag: '', healthy: true }).status).toBe(0);
    expect(run({ tag: 'latest; rm -rf /', healthy: true }).status).toBe(0);
    expect(log()).not.toContain('git -C');
  });

  it('свой порт HTTPS — в адресе проверки', () => {
    writeFileSync(join(dir, 'deploy', '.env'), 'HUB_DOMAIN=hub.example\nHTTPS_PORT=8443\n');
    run({ tag: 'v0.12.0', healthy: true });
    expect(log()).toContain('https://hub.example:8443/health');
  });
});
