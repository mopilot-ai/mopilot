// Claude Code's "Your own provider" mode (electron/harness/claude/auth.cjs 'routed', wired by app/ipc/routing.cjs): chosen with a
// saved model config where this process has the model router; the CLI gets only the router's base and token, never a provider key;
// its billing signature changes with the config, so idle CLIs restart (I2); it is billed per use as the user's own provider, never
// as a subscription; and the CLI's model list gains the config's models. Electron, the SDK and fs are fakes (tests/support/electron-claude.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { load, fakes, fakeBin } from './support/electron-claude.ts';

const require = createRequire(import.meta.url);
const { billingKind, createAuth } = require('../electron/harness/claude/auth.cjs');
const { withRoutedModels } = require('../electron/harness/claude/queries.cjs');
const { claudeInstances } = require('../electron/identity/drivers/claude.cjs');
const { claudeBilling, rejectedCredential } = require('../electron/identity/contract/claudeBilling.cjs');
const { claudeLedgerAccount } = require('../electron/ledger/accounts.cjs');
const { ledgerLine } = require('../electron/ledger/line.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const config = (o: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Work',
  provider: 'openai',
  model: 'gpt-x',
  tierModels: { haiku: 'gpt-mini' },
  fallbacks: [],
  ...o,
});

/** A router as main gives it: its configs, a base once listening, its token, and the listener a config change calls. */
function routing(configs: Record<string, any> = { c1: config() }) {
  let listening = true;
  const heard: (() => void)[] = [];
  return {
    configs,
    stop: () => void (listening = false),
    start: () => void (listening = true),
    change: () => heard.forEach((f) => f()),
    r: {
      configOf: (id: string) => configs[id] ?? null,
      baseFor: (id: string) => (listening ? `http://127.0.0.1:4321/secret/c/${id}` : null),
      token: 'router-token-0000',
      onChange: (fn: () => void) => void heard.push(fn),
    },
  };
}

test('routed mode is chosen with a saved config where the router runs; the CLI gets the router’s base and token only', async () => {
  const t = load();
  await assert.rejects(t.call('claude:setAuthMode', 'routed', 'c1'), /Your own provider works only in the MoPilot app/);
  const w = routing();
  t.claude.setRouting(w.r);
  await assert.rejects(t.call('claude:setAuthMode', 'routed'), /Choose a saved model config first/);
  await assert.rejects(t.call('claude:setAuthMode', 'routed', 'gone'), /Choose a saved model config first/);
  await assert.rejects(t.call('claude:setAuthMode', 'nope'), /Unknown mode/);
  const info = await t.call('claude:setAuthMode', 'routed', 'c1');
  assert.equal(info.mode, 'routed');
  assert.deepEqual(info.routed, { available: true, configId: 'c1', name: 'Work' });
  assert.equal(fs.readFileSync(path.join(t.userData, 'claude-auth-mode'), 'utf8'), 'routed');
  assert.equal(fs.readFileSync(path.join(t.userData, 'claude-routed-config'), 'utf8'), 'c1');
  const env = t.claude.cleanEnv();
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321/secret/c/c1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'router-token-0000');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/, 'the router is reached directly, never through a proxy');
  assert.match(env.CLAUDE_CONFIG_DIR, /key-routed$/, 'a config folder of its own');
  assert.equal(t.claude.turnApi.metered(), true, 'paid per use');
  // a router that isn't listening: an address nothing answers on, never the CLI's own login (a version or catalog read still works)
  w.stop();
  assert.equal(t.claude.cleanEnv().ANTHROPIC_BASE_URL, 'http://127.0.0.1:0/mopilot-router-not-running');
});

test('a chat refuses to start while the router isn’t listening, and starts once it is', () => {
  const t = load();
  const w = routing();
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'routed');
  fs.writeFileSync(path.join(t.userData, 'claude-routed-config'), 'c1');
  const state = {
    routing: () => w.r,
    gatewayKey: () => null,
    sessions: new Map(),
    accts: null,
    activeAccount: () => 'default',
    sageTools: null,
  };
  const auth = createAuth(state, { restartIdle: () => {} });
  w.stop();
  assert.throws(() => auth.sessionEnv(undefined, {}), /MoPilot's model router isn't running\. Quit and reopen MoPilot/);
  w.start();
  const started: any = {};
  assert.equal(auth.sessionEnv(undefined, started).ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321/secret/c/c1');
  assert.equal(typeof started.artifactsAt, 'boolean');
});

test('I2: the billing signature changes with the config and the router, never carries the token, and a change is handed to the restart', async () => {
  const t = load();
  const w = routing({ c1: config(), c2: config({ id: 'c2', name: 'Home' }) });
  t.claude.setRouting(w.r);
  await t.call('claude:setAuthMode', 'routed', 'c1');
  const first = t.claude.billingSig();
  assert.match(first, /^routed:[0-9a-f]{32}$/);
  assert.doesNotMatch(first, /router-token|secret/, 'hashed: neither the token nor the path is in the clear');
  assert.equal(billingKind(first), 'routed');
  assert.equal(t.claude.billingSig(), first, 'stable while nothing changes');
  w.configs.c1 = config({ model: 'gpt-y' });
  const edited = t.claude.billingSig();
  assert.notEqual(edited, first, 'an edited config is another billing');
  // the change reaches the CLIs' restart (sessions.cjs restartIdle retires the idle ones whose signature this changed)
  w.change();
  w.stop();
  assert.notEqual(t.claude.billingSig(), edited, 'a router that stopped is another billing');
  w.start();
  await t.call('claude:setAuthMode', 'routed', 'c2');
  assert.notEqual(t.claude.billingSig(), edited, 'another config');
  assert.equal(fs.readFileSync(path.join(t.userData, 'claude-routed-config'), 'utf8'), 'c2');
  const again = await t.call('claude:setAuthMode', 'routed', 'c2');
  assert.equal(again.routed.configId, 'c2');
  // back to the subscription keeps the config for next time
  const sub = await t.call('claude:setAuthMode', 'subscription');
  assert.equal(sub.mode, 'subscription');
  assert.equal(sub.routed.configId, 'c2');
  assert.equal(t.claude.billingSig(), 'subscription');
});

test('a removed config stays chosen and says so; a process without the router (a Host) never runs routed', async () => {
  const t = load();
  const w = routing();
  t.claude.setRouting(w.r);
  await t.call('claude:setAuthMode', 'routed', 'c1');
  delete w.configs.c1;
  assert.equal(t.claude.authMode(), 'routed', 'never another way to pay unasked');
  assert.deepEqual((await t.call('claude:apiKey')).routed, { available: true, configId: 'c1', name: null });
  assert.match(t.claude.billingSig(), /^routed:/);
  const host = load();
  fs.writeFileSync(path.join(host.userData, 'claude-auth-mode'), 'routed');
  fs.writeFileSync(path.join(host.userData, 'claude-routed-config'), 'c1');
  assert.equal(host.claude.authMode(), 'subscription');
  // a mode file naming routed without a config is the subscription too
  const bare = load();
  bare.claude.setRouting(routing().r);
  fs.writeFileSync(path.join(bare.userData, 'claude-auth-mode'), 'routed');
  assert.equal(bare.claude.authMode(), 'subscription');
});

test('routed bills as the user’s own provider: not a subscription, a provider of its own, its own ledger pay and instance', () => {
  assert.deepEqual(claudeBilling('routed', null, 'claude.ai'), { mode: 'routed', provider: 'routed', label: 'Your own provider' });
  assert.match(rejectedCredential('routed') ?? '', /Your own provider refused the key for this model config/);
  const key = { set: false, mode: 'routed', baseUrl: null, routed: { name: 'Work' } };
  const routed = claudeInstances({ active: 'default', accounts: [] }, key, false).find((i: any) => i.account === 'routed');
  assert.equal(routed.label, 'Your own provider · Work');
  assert.equal(routed.active, true);
  assert.equal(routed.provider.firstParty, false);
  const unnamed = claudeInstances({ active: 'default', accounts: [] }, { ...key, routed: { name: null } }, false).find(
    (i: any) => i.account === 'routed',
  );
  assert.equal(unnamed.label, 'Your own provider');
  assert.equal(
    claudeInstances({ active: 'default', accounts: [] }, { ...key, mode: 'subscription' }, false).some((i: any) => i.account === 'routed'),
    false,
  );
  // a session started routed keeps its pay after the setting changes; one named by the mode alone pays the same
  const o = { view: () => null, authMode: () => 'routed', cloud: () => false, billingOf: () => 'routed' };
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:s1' }, o), { id: 'routed', pay: 'routed' });
  assert.deepEqual(claudeLedgerAccount({ key: 'claude:s1' }, { ...o, billingOf: () => 'unknown' }), { id: 'routed', pay: 'routed' });
  assert.deepEqual(claudeLedgerAccount({}, { ...o, authMode: () => 'other' }), { id: 'other', pay: 'unknown' });
  const line = JSON.parse(
    ledgerLine({ pay: 'routed', harness: 'claude', req: 'claude-sonnet-4-5', served: 'gpt-4o-mini', outcome: 'ok' }, 0),
  );
  assert.deepEqual([line.pay, line.served], ['routed', 'gpt-4o-mini']);
});

test('the CLI’s model list gains the config’s models first, once each; Claude’s own aliases stay', () => {
  const cli = [{ value: 'default' }, { value: 'gpt-mini' }];
  const out = withRoutedModels(cli, config({ tierModels: { haiku: 'gpt-mini', opus: 'gpt-x' } }));
  assert.deepEqual(
    out.map((m: any) => m.value),
    ['gpt-x', 'default', 'gpt-mini'],
  );
  assert.equal(out[0].description, 'Served by Work');
  assert.equal(out[0].supportsFastMode, false);
  assert.equal(withRoutedModels(cli, null), cli);
  assert.equal(withRoutedModels(cli, config({ model: 'default', tierModels: {} })), cli, 'nothing new');
});

test('an empty config file chooses none; a config id that can’t be saved still holds for this run, and says why', async () => {
  const t = load();
  t.claude.setRouting(routing().r);
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'routed');
  fs.writeFileSync(path.join(t.userData, 'claude-routed-config'), '  \n');
  assert.equal(t.claude.authMode(), 'subscription');
  const u = load();
  u.claude.setRouting(routing().r);
  fs.mkdirSync(path.join(u.userData, 'claude-routed-config'));
  const info = await u.call('claude:setAuthMode', 'routed', 'c1');
  assert.deepEqual([info.mode, info.routed.configId], ['routed', 'c1']);
  assert.ok(recentIgnored().some((e: any) => e.context === 'save the model config Claude Code runs on'));
  // a Host's key setting: no router, no name, whatever the files say
  const host = load();
  fs.writeFileSync(path.join(host.userData, 'claude-routed-config'), 'c1');
  assert.deepEqual((await host.call('claude:apiKey')).routed, { available: false, configId: 'c1', name: null });
});

test('the probe lists the config’s models first while routed; a removed config leaves the CLI’s list as it is', async () => {
  const t = load();
  const w = routing();
  t.claude.setRouting(w.r);
  await t.call('claude:setAuthMode', 'routed', 'c1');
  const bin = fakeBin('routed-probe/claude');
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ models: [{ value: 'opus' }] });
  };
  const out = await t.call('claude:probe', bin, null);
  assert.deepEqual(
    out.models.map((m: any) => m.value),
    ['gpt-x', 'gpt-mini', 'opus'],
  );
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({});
  };
  assert.deepEqual(
    (await t.call('claude:probe', bin, null)).models.map((m: any) => m.value),
    ['gpt-x', 'gpt-mini'],
    'a CLI that lists none: the config’s alone',
  );
  delete w.configs.c1;
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ models: [{ value: 'opus' }] });
  };
  assert.deepEqual((await t.call('claude:probe', bin, null)).models, [{ value: 'opus' }]);
});
