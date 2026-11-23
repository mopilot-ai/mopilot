// The scripted Codex fixture answers config/read as a real app-server does for its home (#2139): Codex's defaults with the
// home's `[features]` over them. MoMo's own app-server runs on MoMo's home, so it reports Codex's shell off, which the app
// confirms before each MoMo run (CodexIsolation.shellOff, fail closed); the user's home reports it on. The e2e specs that
// run a MoMo chat on Codex go through this fixture, and every one of them was refused until it said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DEFAULT_FEATURES, configOf, effectiveFeatures } from './e2e/fixtures/fake-codex-config.mjs';

const require = createRequire(import.meta.url);
const { prepareMomoHome } = require('../electron/harness/codexMomoHome.cjs');
const { CodexIsolation, HOME_FEATURES_OFF, SHELL_FEATURES } = require('../electron/harness/codexIsolation.cjs');

const FAKE = path.join(process.cwd(), 'tests/e2e/fixtures/fake-codex.mjs');

/** The real fixture as an app-server on `home`: asks it a request and answers with its result. */
function appServer(home: string) {
  const child = spawn(process.execPath, [FAKE, 'app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map<number, (m: any) => void>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const call = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
    });
  return { call, stop: () => child.kill() };
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-config-'));

test('config/read honors a saved CLI model independently of the recommended catalog model', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(configOf(root, 'recommended', {}).model, 'recommended');
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = "older-version"\n');
  assert.equal(configOf(root, 'recommended', {}).model, 'older-version');
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = 42\n');
  assert.equal(configOf(root, 'recommended', {}).model, 'recommended');
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = ');
  assert.equal(configOf(root, 'recommended', {}).model, 'recommended');
});

test('a home reports the defaults with its own [features] over them; no config or an unreadable one has the defaults', () => {
  const root = scratch();
  assert.deepEqual(effectiveFeatures(path.join(root, 'none')), DEFAULT_FEATURES);
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'config.toml'), 'features = ');
  assert.deepEqual(effectiveFeatures(path.join(root, 'broken')), DEFAULT_FEATURES);
  fs.mkdirSync(path.join(root, 'own'));
  fs.writeFileSync(path.join(root, 'own', 'config.toml'), '[features]\nshell_tool = false\nmulti_agent = "no"\nextra_flag = true\n');
  assert.deepEqual(effectiveFeatures(path.join(root, 'own')), { ...DEFAULT_FEATURES, shell_tool: false, extra_flag: true });
  // config/read's config: the settings it always had, and the home's features
  assert.deepEqual(configOf(path.join(root, 'own'), 'm1', { x: {} }), {
    model: 'm1',
    model_reasoning_effort: 'medium',
    mcp_servers: { x: {} },
    features: { ...DEFAULT_FEATURES, shell_tool: false, extra_flag: true },
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('#2139 repro: the fixture on MoMo’s home reports its shell off, so a MoMo run passes the app’s check; on the user’s home it reports it on', async () => {
  const root = scratch();
  const momoHome = path.join(root, 'momo', 'codex-home');
  prepareMomoHome({ home: momoHome, userHome: path.join(root, 'user') });
  fs.mkdirSync(path.join(root, 'user'));
  const check = (home: string) => {
    const server = appServer(home);
    // the app asks the same way: the effective config, no layers
    const iso = new CodexIsolation({
      isolated: () => true,
      chatOf: (t: string) => t,
      call: (method: string, params: any) => server.call(method, { includeLayers: false, ...params }),
    });
    return { server, shellOff: () => iso.shellOff() };
  };
  const momo = check(momoHome);
  const read = await momo.server.call('config/read', { includeLayers: false });
  for (const k of SHELL_FEATURES) assert.equal(read.config.features[k], false, k);
  for (const [k, v] of Object.entries(HOME_FEATURES_OFF)) assert.equal(read.config.features[k], v, k);
  // what the home leaves alone stays as Codex has it
  assert.equal(read.config.features.code_mode_host, true);
  await momo.shellOff();
  momo.server.stop();
  // the user's home: nothing off, and the check says which switches
  const user = check(path.join(root, 'user'));
  await assert.rejects(user.shellOff(), /isn't confirmed off for this chat \(shell_tool, unified_exec, view_image\)/);
  user.server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
