// MoMo's CODEX_HOME (#2308, electron/harness/codexMomoHome.cjs) keeps the user's model and provider settings and
// nothing that instructs or remembers; MoMo's Codex app-server signs in to the account in use
// (electron/identity/accounts/isolatedLogin.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareMomoHome, settingsOf } = require('../electron/harness/codexMomoHome.cjs');
const { HOME_FEATURES_OFF, FEATURES_OFF } = require('../electron/harness/codexIsolation.cjs');
const { isolatedLogin } = require('../electron/identity/accounts/isolatedLogin.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const USER_CONFIG = `
model = "gpt-5.6"
model_reasoning_effort = "low"
model_provider = "acme"
developer_instructions = "always say you are the coding agent"
experimental_instructions_file = "/Users/me/instructions.md"
profile = "fast"
notify = ["say", "done"]

[model_providers.acme]
name = "Acme"
base_url = "https://acme.test/v1"

[mcp_servers.secrets]
command = "secrets-mcp"

[projects."/Users/me/code"]
trust_level = "trusted"

[features]
memories = true

[profiles.fast]
model = "gpt-5.6-mini"
model_instructions_file = "/Users/me/fast.md"

[profiles.broken]
`;

test('MoMo’s home: the user’s model and provider settings, and nothing that instructs, extends or remembers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-codex-home-'));
  const user = path.join(root, 'user');
  const home = path.join(root, 'momo', 'codex-home');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'config.toml'), USER_CONFIG);
  // what an earlier run or anyone else left there
  fs.mkdirSync(path.join(home, 'skills', 's'), { recursive: true });
  fs.mkdirSync(path.join(home, 'memories'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  for (const f of ['AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'memories_1.sqlite', 'auth.json', 'installation_id'])
    fs.writeFileSync(path.join(home, f), 'x');
  prepareMomoHome({ home, userHome: user });
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.toml', 'installation_id', 'sessions']);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, 'config.toml')).mode & 0o777, 0o600);
  const { parse } = require('smol-toml');
  assert.deepEqual(JSON.parse(JSON.stringify(parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')))), {
    model: 'gpt-5.6',
    model_reasoning_effort: 'low',
    model_provider: 'acme',
    profile: 'fast',
    model_providers: { acme: { name: 'Acme', base_url: 'https://acme.test/v1' } },
    profiles: { fast: { model: 'gpt-5.6-mini' }, broken: {} },
    // not the user's own [features] (their memories = true): Codex's own shell and the rest off for every thread (#2139)
    features: HOME_FEATURES_OFF,
  });
  // ready again: the settings follow the user's config
  fs.writeFileSync(path.join(user, 'config.toml'), 'model = "gpt-6"\n');
  prepareMomoHome({ home, userHome: user });
  const again = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')) as any;
  assert.equal(again.model, 'gpt-6');
  assert.deepEqual({ ...again.features }, HOME_FEATURES_OFF);
  fs.rmSync(root, { recursive: true, force: true });
});

test('MoMo’s home switches Codex’s shell, exec, image and memory tools off for every thread on its app-server, whatever the thread asks (#2139)', () => {
  // every switch a thread's own config turns off is off at the home too, except the code-mode host: off at the home,
  // Codex turns the whole host off ("code-mode host is disabled": every exec call fails, probed on 0.162.1)
  assert.deepEqual(
    Object.keys(FEATURES_OFF).filter((k) => !(k in HOME_FEATURES_OFF)),
    ['code_mode_host'],
  );
  for (const k of ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'memories', 'hooks', 'skill_search'])
    assert.equal(HOME_FEATURES_OFF[k], false, k);
  assert.ok(Object.values(HOME_FEATURES_OFF).every((v) => v === false));
  // a user config that turns them on again changes nothing: only the model and provider settings are kept
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-codex-home-'));
  const user = path.join(root, 'user');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'config.toml'), '[features]\nshell_tool = true\nunified_exec = true\nview_image = true\n');
  prepareMomoHome({ home: path.join(root, 'home'), userHome: user });
  const text = fs.readFileSync(path.join(root, 'home', 'config.toml'), 'utf8');
  assert.match(text, /shell_tool = false/);
  assert.doesNotMatch(text, /= true/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('MoMo’s home: no config of the user’s keeps none; one Codex can’t read or this can’t open is noted and keeps none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-codex-home-'));
  const home = path.join(root, 'home');
  prepareMomoHome({ home, userHome: path.join(root, 'nobody') });
  assert.deepEqual(JSON.parse(JSON.stringify(require('smol-toml').parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')))), {
    features: HOME_FEATURES_OFF,
  });
  clearIgnored();
  assert.deepEqual(settingsOf('model = '), {});
  assert.ok(recentIgnored().some((x: any) => /read the Codex settings for MoMo's Codex/.test(x.context)));
  // a config that is a folder: read fails other than missing
  const odd = path.join(root, 'odd');
  fs.mkdirSync(path.join(odd, 'config.toml'), { recursive: true });
  clearIgnored();
  prepareMomoHome({ home, userHome: odd });
  assert.ok(recentIgnored().some((x: any) => /read the Codex settings/.test(x.context)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('MoMo’s Codex signs in to the account in use with its tokens; an API key or no account signs nothing in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-login-'));
  const keyHome = path.join(root, 'key');
  fs.mkdirSync(keyHome);
  fs.writeFileSync(path.join(keyHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
  const accounts = (active: any, home: string) => ({
    active: () => active,
    home: () => home,
    tokens: async () => ({ accessToken: 'at', chatgptAccountId: 'acc' }),
  });
  assert.equal(await isolatedLogin(accounts(null, root)), null);
  // an API key is never signed in there: Codex would keep it in MoMo's home, and a key's threads carry their provider
  assert.equal(await isolatedLogin(accounts({ id: 'k' }, keyHome)), null);
  assert.deepEqual(await isolatedLogin(accounts({ id: 'c', planType: 'pro' }, root)), {
    type: 'chatgptAuthTokens',
    accessToken: 'at',
    chatgptAccountId: 'acc',
    chatgptPlanType: 'pro',
  });
  assert.equal((await isolatedLogin(accounts({ id: 'c' }, root))).chatgptPlanType, null);
  fs.rmSync(root, { recursive: true, force: true });
});
