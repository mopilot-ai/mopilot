// Whole-repository rule (#2308): no user-level or project instructions reach a MoMo chat on Codex. Codex reads the global
// AGENTS.md, skills, hooks and memories from CODEX_HOME for the whole process (codex-cli 0.162.1), so the app's Codex
// server must run MoMo's threads on a second app-server whose CODEX_HOME is MoMo's own folder, made ready with none of
// them, and an isolated thread's config must turn off what Codex reads from elsewhere (~/.agents/skills, the folder's
// AGENTS.md). MoMo's chats start isolated (tests/momoBuiltinsOff.test.ts); tests/momoHarnessConfinement.test.ts (#2303)
// lists every family MoMo runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { createCodexServer } = require('../electron/app/codexServer.cjs');
const { IsolatedServer } = require('../electron/harness/codexIsolatedServer.cjs');
const {
  isolateConfig,
  ISOLATED_THREAD,
  FEATURES_OFF,
  HOME_FEATURES_OFF,
  INSTRUCTIONS_OFF,
} = require('../electron/harness/codexIsolation.cjs');

test('the app’s Codex server runs MoMo’s threads on an app-server whose CODEX_HOME is MoMo’s, holding no instructions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-confined-'));
  const user = path.join(root, 'user-codex');
  fs.mkdirSync(path.join(user, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(user, 'AGENTS.md'), 'coding-side instructions');
  fs.writeFileSync(path.join(user, 'config.toml'), 'model = "gpt-5.6"\ndeveloper_instructions = "coding side"\n');
  const live: any = { codex: { isolation: { applies: ({ threadId }: any) => threadId === 'momo-th' } } };
  const made = createCodexServer({
    app: { getPath: () => root, getVersion: () => '0.0.0' },
    APP_NAME: 'MoPilot',
    isWin: false,
    shellEnv: { childEnv: () => ({ CODEX_HOME: user, PATH: '/bin' }) },
    readState: () => ({}),
    live,
  });
  const iso = made.isolated;
  assert.ok(iso instanceof IsolatedServer);
  assert.equal(made.server.isolated, iso);
  const home = path.join(root, 'momo', 'codex-home');
  // its own home, the user's environment otherwise
  const env = iso.server.env();
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.PATH, '/bin');
  assert.equal(made.server.env().CODEX_HOME, user);
  // an isolated chat's threads are its, by the adapter's rule; a new isolated thread too
  assert.equal(iso.holds('momo-th'), true);
  assert.equal(iso.holds('coding-th'), false);
  assert.equal(iso.mine({ params: { [ISOLATED_THREAD]: true } }), true);
  live.codex = null;
  assert.equal(iso.holds('momo-th'), false);
  // its home is made ready from the user's settings, with none of their instructions
  iso.prepare();
  assert.deepEqual(fs.readdirSync(home), ['config.toml']);
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /^model = "gpt-5.6"\n/);
  // signed out until the accounts open; then to the account in use's tokens
  assert.equal(await iso.login(), null);
  live.accounts = {
    active: () => ({ id: 'a', planType: 'plus' }),
    home: () => path.join(root, 'no-auth'),
    tokens: async () => ({ accessToken: 'at', chatgptAccountId: 'acc' }),
  };
  assert.equal((await iso.login()).accessToken, 'at');
  // its crash is reported as MoMo's
  const reports: any[] = [];
  live.telemetry = { error: (e: any) => reports.push(e) };
  iso.server.onCrashReport(1, null, 'boom');
  assert.match(reports[0].message, /MoMo's codex app-server exited \(1\)/);
  iso.server.onCrashReport(null, 'SIGKILL', '');
  assert.match(reports[1].message, /\(SIGKILL\)/);
  live.telemetry = null;
  iso.server.onCrashReport(null, 'SIGKILL', '');
  // a user with no CODEX_HOME of their own: their settings are read from ~/.codex
  const bare = createCodexServer({
    app: { getPath: () => root, getVersion: () => '0.0.0' },
    APP_NAME: 'MoPilot',
    isWin: false,
    shellEnv: { childEnv: () => ({}) },
    readState: () => ({}),
    live: {},
  });
  const savedHome = process.env.HOME;
  process.env.HOME = path.join(root, 'fake-home');
  fs.mkdirSync(path.join(root, 'fake-home', '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fake-home', '.codex', 'config.toml'), 'model = "from-home"\n');
  try {
    bare.isolated.prepare();
    // and an earlier thread is looked for there too (no thread by this id: nothing copied)
    assert.equal(await bare.isolated.adopt('01a15d82-0000-78e2-ac6d-f08238fd0000'), false);
  } finally {
    process.env.HOME = savedHome;
  }
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /^model = "from-home"\n/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('#2326 MoMo’s Codex home is under the userData folder as it is when the server is used, not as it was when main loaded', async () => {
  const early = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-early-'));
  const late = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-late-'));
  let userData = early;
  // main creates the server while the module loads; app.setPath('userData', ...) runs after (lifecycle.prepareApp)
  const made = createCodexServer({
    app: { getPath: () => userData, getVersion: () => '0.0.0' },
    APP_NAME: 'MoPilot',
    isWin: false,
    shellEnv: { childEnv: () => ({ CODEX_HOME: path.join(early, 'user') }) },
    readState: () => ({}),
    live: {},
  });
  userData = late;
  const home = path.join(late, 'momo', 'codex-home');
  assert.equal(made.isolated.server.env().CODEX_HOME, home);
  made.isolated.prepare();
  assert.ok(fs.existsSync(path.join(home, 'config.toml')));
  assert.equal(fs.existsSync(path.join(early, 'momo')), false);
  fs.rmSync(early, { recursive: true, force: true });
  fs.rmSync(late, { recursive: true, force: true });
});

test('#2326 the app’s Codex server reads a MoMo chat’s thread from MoMo’s home, and brings an earlier thread of its in from the user’s', async () => {
  const { homeOfThread, setThreadHomes } = require('../electron/harness/codexRollout.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-adopt-'));
  const user = path.join(root, 'user-codex');
  const id = '01a15d82-92f2-78e2-ac6d-f08238fd8829';
  const rel = path.join('sessions', '2026', '10', '21', `rollout-2026-10-21T01-10-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(path.join(user, rel)), { recursive: true });
  fs.writeFileSync(path.join(user, rel), '{"type":"session_meta","payload":{"id":"x"}}\n');
  const live: any = { codex: { isolation: { applies: ({ threadId }: any) => threadId === id } } };
  const made = createCodexServer({
    app: { getPath: () => root, getVersion: () => '0.0.0' },
    APP_NAME: 'MoPilot',
    isWin: false,
    shellEnv: { childEnv: () => ({ CODEX_HOME: user }) },
    readState: () => ({}),
    live,
  });
  try {
    const home = path.join(root, 'momo', 'codex-home');
    assert.equal(homeOfThread(id), home);
    assert.notEqual(homeOfThread('coding-th'), home);
    assert.equal(await made.isolated.adopt(id), true);
    assert.ok(fs.existsSync(path.join(home, rel)));
  } finally {
    setThreadHomes(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an isolated Codex thread’s config turns off what Codex reads outside its home: skills, the folder’s AGENTS.md, hooks, memory', () => {
  const off = isolateConfig({ [ISOLATED_THREAD]: true }, {});
  assert.equal(off.skills.include_instructions, false);
  for (const [k, v] of Object.entries(INSTRUCTIONS_OFF)) assert.equal(off[k], v, k);
  for (const k of ['hooks', 'skill_search', 'memories', 'external_agent_memory_import']) assert.equal(FEATURES_OFF[k], false, k);
});

test('an isolated Codex thread has no ChatGPT apps: codex_apps tools would run outside MoMo’s trust gate (#5824)', () => {
  // Codex's `apps` feature (stable, on by default on 0.162.1) adds the codex_apps MCP server, whose tools a MoMo thread's code mode
  // listed in ALL_TOOLS; MoPilot's gate never sees those calls, so the thread and MoMo's home turn the feature off
  assert.equal(isolateConfig({ [ISOLATED_THREAD]: true }, { features: { apps: true } }).features.apps, false);
  assert.equal(FEATURES_OFF.apps, false);
  assert.equal(HOME_FEATURES_OFF.apps, false);
});
