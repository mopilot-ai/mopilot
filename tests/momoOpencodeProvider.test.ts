// MoMo on opencode's free models (#2357): its free tier refuses any agent but its own, so every MoMo message would fail.
// With free models only, the quirk says so before the first turn: admission lists it for the brain menus, MoMo's service
// refuses that brain with the same line, and the ACP host starts no confined process for it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup } from './support/acp-host/fixture';
import { world } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { opencodeIsolation, NEEDS_PROVIDER } = require('../electron/harness/quirks/opencodeIsolation.cjs');
const quirks = require('../electron/harness/quirks/index.cjs');
const { assertConfinable } = require('../electron/momo/apart.cjs');
const { Admission } = require('../electron/harness/admission.cjs');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-provider-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = () => fs.mkdtempSync(path.join(tmp, 'home-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('opencode with free models only can’t run MoMo; a login, a provider in its settings or a key in the environment can', () => {
  assert.equal(NEEDS_PROVIDER, "MoMo needs an opencode provider (free models can't run MoMo)");
  const h = home();
  assert.equal(opencodeIsolation.blocked({ env: { HOME: h } }), NEEDS_PROVIDER);
  // an empty or unreadable auth.json is no login
  write(path.join(h, '.local', 'share', 'opencode', 'auth.json'), '{}');
  assert.equal(opencodeIsolation.blocked({ env: { HOME: h } }), NEEDS_PROVIDER);
  write(path.join(h, '.local', 'share', 'opencode', 'auth.json'), 'null');
  assert.equal(opencodeIsolation.blocked({ env: { HOME: h } }), NEEDS_PROVIDER);
  write(path.join(h, '.local', 'share', 'opencode', 'auth.json'), '{not json');
  assert.equal(opencodeIsolation.blocked({ env: { HOME: h } }), NEEDS_PROVIDER);
  // a login from `opencode auth login`, where XDG_DATA_HOME puts it
  write(path.join(h, 'data', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'k' } }));
  assert.equal(opencodeIsolation.blocked({ env: { HOME: h, XDG_DATA_HOME: path.join(h, 'data') } }), null);
  // a provider in the user's own settings (a local model), or a key in the environment
  const local = home();
  write(path.join(local, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: { 'mlx-local': { name: 'Local' } } }));
  assert.equal(opencodeIsolation.blocked({ env: { HOME: local } }), null);
  assert.equal(opencodeIsolation.blocked({ env: { HOME: home(), OPENROUTER_API_KEY: 'k' } }), null);
  // with no home folder in the env, the system's
  assert.equal(opencodeIsolation.blocked({ env: {} }, { read: () => JSON.stringify({ opencode: { type: 'api' } }) }), null);
});

test('quirks say why a harness can’t run MoMo now: opencode by its provider, the rest have nothing to say', () => {
  assert.equal(quirks.momoBlocked('opencode', { HOME: home() }), NEEDS_PROVIDER);
  assert.equal(quirks.momoBlocked('opencode', { HOME: home(), OPENAI_API_KEY: 'k' }), null);
  assert.equal(quirks.momoBlocked('kimi', {}), null);
  assert.equal(quirks.momoBlocked('nope', {}), null);
});

test('MoMo’s service refuses opencode with free models only, with the same line; with a provider it goes on', () => {
  assert.throws(() => assertConfinable('acp:opencode', 'opencode', { HOME: home() }), {
    code: 'needs_provider',
    message: `${NEEDS_PROVIDER}.`,
  });
  assertConfinable('acp:opencode', 'opencode', { HOME: home(), ANTHROPIC_API_KEY: 'k' });
  // first-tier harnesses read no provider
  assertConfinable('claude', 'Claude Code', {});
});

test('admission lists why MoMo can’t run on a harness now, for the brain menus', () => {
  const env = { HOME: home() };
  const a = new Admission({
    ids: ['opencode', 'kimi'],
    file: path.join(home(), 'admission.json'),
    quirks: (id: string) => quirks.quirks(id),
    resolveBin: () => null,
    env: () => env,
  });
  assert.deepEqual(
    a.list().map((h: any) => [h.id, h.isolates, h.momoBlocked]),
    [
      ['opencode', true, NEEDS_PROVIDER],
      ['kimi', false, null],
    ],
  );
  // without an env to read, the quirk is asked with an empty one
  const seen: any[] = [];
  const iso = { blocked: (ctx: any) => (seen.push(ctx.env), null) };
  const bare = new Admission({
    ids: ['x'],
    file: path.join(home(), 'a.json'),
    quirks: () => ({ label: 'X', isolation: iso }),
    resolveBin: () => null,
  });
  assert.equal(bare.list()[0].momoBlocked, null);
  assert.deepEqual(seen, [{}]);
});

test('the ACP host starts no confined process for a harness that can’t run MoMo now; a coding chat on it starts', async () => {
  const q = { label: 'Fake', args: ['acp'], isolation: { env: () => ({}), mode: { mode: 'm' }, blocked: () => NEEDS_PROVIDER } };
  const t = setup({ quirks: () => q });
  t.host.isolated = (key: string) => key === 'acp:fake:momo';
  const ws = home();
  await assert.rejects(t.host.ensure('acp:fake:momo', { cwd: ws }), new RegExp(NEEDS_PROVIDER.replace(/[()]/g, '\\$&')));
  assert.equal(t.sp.calls.length, 0);
  await t.host.ensure('acp:fake:code', { cwd: ws });
  assert.equal(t.sp.calls.length, 1);
  t.host.closeAll();
});

test('MoMo’s main chat isn’t made on opencode with free models only; it is once there is a provider', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'acp:opencode' } } } } });
  w.env = { HOME: home() };
  await assert.rejects(w.svc.ensureMainChat(), { code: 'needs_provider', message: `${NEEDS_PROVIDER}.` });
  await assert.rejects(w.svc.startBackground({ harness: 'acp:opencode' }, { momo: 'topic' }), { code: 'needs_provider' });
  w.env = { HOME: home(), ANTHROPIC_API_KEY: 'k' };
  assert.match((await w.svc.ensureMainChat()).chatId, /^acp:opencode:/);
});
