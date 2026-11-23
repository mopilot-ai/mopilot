// electron/harness/claude/index.cjs: which credential the CLI runs on, the environment it gets, finding the binary,
// detect, probe and usage. Electron, the SDK, child_process and fs are fakes (tests/support/electron-claude.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load, fakeBin, flush, home, tmp, lastQuery, savedKey } from './support/electron-claude.ts';
import { waitFor } from './support/waitFor.ts';

const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
const gateway = createRequire(import.meta.url)('../electron/platform/mopilotEndpoints.cjs').endpoints?.API_BASE ?? null;
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const key = ({ routed: _routed, ...rest }: any) => rest; // the key setting without Your own provider's (tests/claudeRoutedMode.test.ts)

test('the auth mode comes from its file and falls back to the subscription when its credential is gone', () => {
  let t = load();
  assert.equal(t.claude.authMode(), 'subscription');
  for (const [mode, expect] of [
    ['apiKey', 'subscription'],
    ['mopilot', 'subscription'],
    ['garbage', 'subscription'],
  ]) {
    t = load();
    fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), `${mode}\n`);
    assert.equal(t.claude.authMode(), expect, mode);
    if (mode === 'apiKey') {
      t = load();
      fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
      fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-1');
      assert.equal(t.claude.authMode(), 'apiKey');
    }
    if (mode === 'mopilot') {
      t.claude.setGatewayKeyProvider(() => 'mpk_1');
      assert.equal(t.claude.authMode(), 'mopilot');
      assert.equal(t.claude.identity.gatewaySet(), true);
    }
  }
});

test('API keys are validated, stored privately with an optional endpoint, and cleared back to the subscription', async () => {
  const t = load();
  let told = 0;
  t.claude.setProbeListener(() => told++);
  await assert.rejects(t.call('claude:setApiKey', '  ', ''), /Enter an API key/);
  await assert.rejects(t.call('claude:setApiKey', 'sk a', ''), /doesn’t look like an API key/);
  await assert.rejects(t.call('claude:setApiKey', 'sk', 'not a url'), /isn’t a valid URL/);
  await assert.rejects(t.call('claude:setApiKey', 'sk', 'ftp://gw.example'), /must start with https/);
  await assert.rejects(t.call('claude:setApiKey', undefined, undefined), /Enter an API key/);

  const info = await t.call('claude:setApiKey', ' sk-ant-1234 ', 'https://gw.example/v1//');
  assert.deepEqual(key(info), {
    set: true,
    hint: '1234',
    mode: 'apiKey',
    baseUrl: 'https://gw.example/v1',
    cloudEnv: false,
    cloudDetected: false,
  });
  assert.equal(told, 1);
  assert.equal(fs.statSync(path.join(t.userData, 'claude-api-key.json')).mode & 0o777, 0o600);
  assert.ok(!read(t.userData, 'claude-api-key.json').includes('sk-ant-1234'), 'the key is not readable on disk');
  assert.equal(savedKey(t.userData), 'sk-ant-1234');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key')), false);
  assert.equal(read(t.userData, 'claude-api-base'), 'https://gw.example/v1');
  assert.equal(read(t.userData, 'claude-auth-mode'), 'apiKey');
  let env = t.claude.cleanEnv();
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.example/v1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-ant-1234');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(t.userData, 'claude-accounts', 'key-apiKey'));
  assert.equal(t.claude.billingSig(), JSON.stringify(['apiKey', 'https://gw.example/v1', 'sk-ant-1234']));
  // a key is never sent to another host
  assert.equal(t.claude.visionAuth(), null);
  assert.equal(t.claude.turnApi.metered(), false);
  assert.equal(t.claude.turnApi.keyMode(), true);

  await t.call('claude:setApiKey', 'sk-ant-5678');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-base')), false);
  env = t.claude.cleanEnv();
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-5678');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(t.claude.visionAuth(), { baseUrl: 'https://api.anthropic.com', headers: { 'x-api-key': 'sk-ant-5678' } });
  assert.equal(t.claude.billingSig(), JSON.stringify(['apiKey', null, 'sk-ant-5678']));
  assert.equal(t.claude.turnApi.metered(), true);
  assert.deepEqual(key(await t.call('claude:apiKey')), {
    set: true,
    hint: '5678',
    mode: 'apiKey',
    baseUrl: null,
    cloudEnv: false,
    cloudDetected: false,
  });

  const cleared = await t.call('claude:clearApiKey');
  assert.deepEqual(key(cleared), { set: false, hint: null, mode: 'subscription', baseUrl: null, cloudEnv: false, cloudDetected: false });
  assert.equal(read(t.userData, 'claude-auth-mode'), 'subscription');
  assert.equal(t.claude.visionAuth(), null);
  // clearing again leaves the mode file alone
  fs.rmSync(path.join(t.userData, 'claude-auth-mode'));
  await t.call('claude:clearApiKey');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-auth-mode')), false);
});

test('a stored key and endpoint are read back from disk; an empty key file holds no key and is not used', () => {
  let t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-disk-9999\n');
  fs.writeFileSync(path.join(t.userData, 'claude-api-base'), 'https://gw.example\n');
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  assert.deepEqual(key(t.claude.identity.keyInfo()), {
    set: true,
    hint: '9999',
    mode: 'apiKey',
    baseUrl: 'https://gw.example',
    cloudEnv: false,
    cloudDetected: false,
  });
  t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), '  ');
  fs.writeFileSync(path.join(t.userData, 'claude-api-base'), '');
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  assert.equal(t.claude.authMode(), 'subscription');
  assert.equal(t.claude.visionAuth(), null);
  assert.deepEqual(key(t.claude.identity.keyInfo()), {
    set: false,
    hint: null,
    mode: 'subscription',
    baseUrl: null,
    cloudEnv: false,
    cloudDetected: false,
  });
});

test('a key that cannot be deleted stays saved and in use, and clearing it fails with the reason', async () => {
  const t = load();
  await t.call('claude:setApiKey', 'sk-ant-5678', 'https://gw.example');
  // a folder that refuses deletes: the key file stays on disk
  fs.chmodSync(t.userData, 0o500);
  try {
    await assert.rejects(t.call('claude:clearApiKey'), /Couldn't remove the API key: EACCES/);
  } finally {
    fs.chmodSync(t.userData, 0o700);
  }
  // still on disk, so still shown and still used: not shown as removed while it stays saved
  assert.equal(savedKey(t.userData), 'sk-ant-5678');
  const info = t.claude.identity.keyInfo();
  assert.deepEqual([info.set, info.hint, info.mode, info.baseUrl], [true, '5678', 'apiKey', 'https://gw.example']);
});

test('a removed key whose endpoint cannot be deleted is still removed, and the endpoint failure recorded', async () => {
  const t = load();
  await t.call('claude:setApiKey', 'sk-ant-5678', 'https://gw.example');
  const baseFile = path.join(t.userData, 'claude-api-base');
  fs.rmSync(baseFile);
  fs.mkdirSync(path.join(baseFile, 'x'), { recursive: true });
  clearIgnored();
  const info = await t.call('claude:clearApiKey');
  assert.deepEqual([info.set, info.baseUrl, info.mode], [false, null, 'subscription']);
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key.json')), false);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['remove the endpoint of a removed Claude API key'],
  );
});

test("a key file that can't be read holds no key, and the failure is recorded; a missing one is not", () => {
  let t = load();
  clearIgnored();
  assert.equal(t.claude.identity.keyInfo().set, false);
  assert.deepEqual(recentIgnored(), []);
  t = load();
  fs.mkdirSync(path.join(t.userData, 'claude-api-key.json'));
  assert.equal(t.claude.identity.keyInfo().set, false);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the saved Claude API key'],
  );
});

test('choices that cannot be saved still hold for this run, and the failure is recorded', async () => {
  const t = load();
  await t.call('claude:setApiKey', 'sk-ant-1', '');
  // folders where the files go: neither can be written or deleted
  for (const f of ['claude-cloud-env', 'claude-auth-mode']) {
    fs.rmSync(path.join(t.userData, f), { force: true });
    fs.mkdirSync(path.join(t.userData, f, 'x'), { recursive: true });
  }
  clearIgnored();
  assert.equal((await t.call('claude:setCloudEnv', true)).cloudEnv, true);
  assert.equal((await t.call('claude:setCloudEnv', false)).cloudEnv, false);
  assert.equal((await t.call('claude:setAuthMode', 'subscription')).mode, 'subscription');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['save the Claude Code cloud-provider choice', 'save the Claude Code cloud-provider choice', 'save how Claude Code pays'],
  );
});

test('switching the auth mode checks its credential and writes only a real change', async () => {
  const t = load();
  await assert.rejects(t.call('claude:setAuthMode', 'bogus'), /Unknown mode/);
  await assert.rejects(t.call('claude:setAuthMode', 'apiKey'), /Add an API key first/);
  await assert.rejects(t.call('claude:setAuthMode', 'mopilot'), /Sign in to MoPilot first/);
  assert.equal((await t.call('claude:setAuthMode', 'subscription')).mode, 'subscription');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-auth-mode')), false);
  t.claude.setGatewayKeyProvider(() => 'mpk_7');
  assert.equal((await t.call('claude:setAuthMode', 'mopilot')).mode, 'mopilot');
  assert.equal(read(t.userData, 'claude-auth-mode'), 'mopilot');
  const env = t.claude.cleanEnv();
  // the gateway is the build's own MoPilot origin: a private build's endpoint, none in the open-source edition
  assert.deepEqual([env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY], [gateway, 'mpk_7', '']);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(t.userData, 'claude-accounts', 'key-mopilot'));
  assert.equal(t.claude.billingSig(), 'mopilot:mpk_7');
});

test('signing out of MoPilot when its folder is unwritable still falls back to the subscription', () => {
  const t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'mopilot');
  let key: string | null = 'mpk_1';
  t.claude.setGatewayKeyProvider(() => key);
  assert.equal(t.claude.authMode(), 'mopilot');
  key = null;
  fakes.userData = path.join(tmp, 'gone', 'nowhere');
  t.claude.mopilotChanged();
  assert.equal(t.claude.authMode(), 'subscription');
});

test('the cloud opt-in holds for this run even when it cannot be written', async () => {
  const t = load();
  fakes.userData = path.join(tmp, 'gone', 'nowhere');
  assert.equal((await t.call('claude:setCloudEnv', true)).cloudEnv, true);
  assert.equal((await t.call('claude:setCloudEnv', false)).cloudEnv, false);
});

test('cloud-provider switches are taken out of the process and only route the CLI once opted in', async () => {
  const t = load();
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.ANTHROPIC_API_KEY = 'inherited';
  t.claude.scrubProcessEnv();
  assert.equal(process.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  let info = await t.call('claude:apiKey');
  assert.equal(info.cloudDetected, true);
  assert.equal(info.cloudEnv, false);
  assert.equal(t.claude.billingSig(), 'subscription');
  assert.equal(t.claude.cleanEnv().CLAUDE_CODE_USE_BEDROCK, undefined);

  info = await t.call('claude:setCloudEnv', true);
  assert.equal(info.cloudEnv, true);
  assert.ok(fs.existsSync(path.join(t.userData, 'claude-cloud-env')));
  assert.equal(t.claude.billingSig(), 'cloud:CLAUDE_CODE_USE_BEDROCK');
  t.claude.setGatewayKeyProvider(() => 'mpk_1');
  await t.call('claude:setAuthMode', 'mopilot');
  const env = t.claude.cleanEnv();
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  await t.call('claude:setApiKey', 'sk-1');
  assert.equal(t.claude.visionAuth(), null);

  info = await t.call('claude:setCloudEnv', false);
  assert.equal(info.cloudEnv, false);
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-cloud-env')), false);

  // the opt-in is read from disk; a skip-auth switch alone doesn't route anywhere
  const u = load();
  fs.writeFileSync(path.join(u.userData, 'claude-cloud-env'), '1');
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
  u.claude.scrubProcessEnv();
  assert.equal(u.claude.identity.keyInfo().cloudEnv, true);
  assert.equal(u.claude.billingSig(), 'subscription');
});

test('the environment drops inherited auth and adds the account folder of the login in use', () => {
  const bare = load({ register: false });
  process.env.ANTHROPIC_AUTH_TOKEN = 'leak';
  try {
    const env = bare.claude.cleanEnv();
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.HOME, home);
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
  assert.deepEqual(bare.claude.turnApi.accounts(), { active: 'default', accounts: [] });
  assert.equal(bare.claude.turnApi.metered(), false);
  const t = load();
  assert.equal(t.claude.cleanEnv('unknown-account').CLAUDE_CONFIG_DIR, undefined);
  assert.equal(t.claude.turnApi.accounts().active, 'default');
  assert.equal(t.claude.turnApi.keyMode(), false);
  assert.equal(t.claude.identity.accounts(), t.claude.identity.accounts());
});

test('the gateway lists only the models it serves over the Anthropic wire that the CLI lacks', () => {
  const { withGatewayModels } = load({ register: false }).claude;
  const models = [{ value: 'opus' }];
  assert.equal(withGatewayModels(models, undefined), models);
  assert.equal(
    withGatewayModels(models, {
      opus: { wires: ['anthropic'] },
      'claude-x': { wires: ['anthropic'] },
      gpt: { wires: ['openai'] },
      nul: null,
    }),
    models,
  );
  assert.deepEqual(withGatewayModels(models, { ds: { wires: ['anthropic'], efforts: ['low'] }, ds2: { wires: ['anthropic'] } }).slice(1), [
    {
      value: 'ds',
      displayName: 'ds',
      description: 'Served by MoPilot credits',
      supportsEffort: true,
      supportedEffortLevels: ['low'],
      supportsFastMode: false,
      supportsAutoMode: false,
    },
    {
      value: 'ds2',
      displayName: 'ds2',
      description: 'Served by MoPilot credits',
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsFastMode: false,
      supportsAutoMode: false,
    },
  ]);
});

test('binary discovery picks the newest CLI, counts a linked path once and reads the desktop app’s bundled copies', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'disc-'));
  process.env.HOME = dir;
  try {
    const t = load();
    // nothing installed (a CLI elsewhere on this machine is invisible to the fake fs)
    assert.equal(await t.claude.findBinary(), null);
    let d = await t.call('claude:detect', null, true, false, null);
    assert.equal(d.state, 'missing');
    assert.equal(d.plan, null);
    assert.deepEqual(d.candidates, []);

    const local = fakeBin(path.relative(tmp, path.join(dir, '.local/bin/claude')), '2.1.0');
    const newer = fakeBin(path.relative(tmp, path.join(dir, '.claude/local/claude')), '2.10.0');
    const bundled = fakeBin(
      path.relative(tmp, path.join(dir, 'Library/Application Support/Claude/claude-code/1.0/abc/claude.app/Contents/MacOS/claude')),
      null,
    );
    // a stray file beside the version folders skips only itself
    fs.writeFileSync(path.join(dir, 'Library/Application Support/Claude/claude-code/.DS_Store'), '');
    const npm = fakeBin(path.relative(tmp, path.join(dir, '.npm-global/bin/claude')), '2.1.0');
    const link = path.join(dir, 'link-claude');
    fs.symlinkSync(local, link);
    process.env.CLAUDE_BIN = link;
    fakes.versions[link] = '2.1.0';
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { organizationType: 'team', organizationRateLimitTier: 'tier1' } }),
    );
    fakes.run = (_c: string, args: string[]) =>
      args[0] === 'auth'
        ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) }
        : { stdout: '' };
    d = await t.call('claude:detect', null, true, false, null);
    assert.deepEqual(
      d.candidates.map((c: any) => [c.path, c.version]),
      [
        [link, '2.1.0'],
        [npm, '2.1.0'],
        [newer, '2.10.0'],
        [bundled, null],
      ],
    );
    assert.equal(d.state, 'ready');
    assert.equal(d.bin, newer);
    assert.equal(d.version, '2.10.0');
    assert.deepEqual(d.plan, { organizationType: 'team', rateLimitTier: 'tier1' });
    assert.deepEqual(d.auth, { loggedIn: true, authMethod: 'claude.ai', apiProvider: null, subscriptionType: 'max' });
    assert.equal(d.billing.mode, 'subscription');
    assert.equal(t.claude.version(), '2.10.0');
    // cached until forced
    assert.equal(await t.claude.findBinary(), newer);

    // a path set by hand isn't a candidate: its version is asked for; one that fails keeps the last known
    const own = fakeBin(path.relative(tmp, path.join(dir, 'own/claude')), null);
    d = await t.claude.turnApi.detect(own);
    assert.equal(d.bin, own);
    assert.equal(d.version, null);
    assert.equal(t.claude.version(), '2.10.0');
    assert.equal(await t.claude.findBinary(path.join(dir, 'missing')), newer);
    // a candidate whose real path can't be read still counts
    const virtual = path.join(dir, 'virtual-claude');
    const exists = fakes.exists;
    fakes.exists = (p: string) => p === virtual || exists(p);
    process.env.CLAUDE_BIN = virtual;
    try {
      assert.equal((await t.call('claude:detect', null, true, false, null)).candidates[0].path, virtual);
    } finally {
      fakes.exists = exists;
    }
  } finally {
    process.env.HOME = home;
    delete process.env.CLAUDE_BIN;
  }
});

test('detect treats malformed authentication status as an error rather than signed in or signed out', async () => {
  const t = load();
  const bin = fakeBin('malformed-detect/claude', '2.0.0');
  for (const reply of [
    [],
    {},
    true,
    3,
    'status',
    { loggedIn: 'false' },
    { loggedIn: 1 },
    { loggedIn: null },
    { loggedIn: true, email: {} },
    { loggedIn: true, authMethod: [] },
    { loggedIn: true, subscriptionType: false },
    { loggedIn: true, apiProvider: {} },
  ]) {
    fakes.run = () => ({ stdout: JSON.stringify(reply) });
    const result = await t.call('claude:detect', bin, false, false, 'default');
    assert.equal(result.state, 'error', JSON.stringify(reply));
    assert.match(result.error, /invalid.*authentication status/i);
    assert.equal(result.auth, undefined);
  }
});

test('detect tells a missing login, a key, a broken CLI and a login that no longer works', async () => {
  const t = load();
  const bin = fakeBin('detect/claude', '2.0.0');
  let status: any = { loggedIn: false };
  let probeOut: any = { stdout: 'hi' };
  fakes.run = (_c: string, args: string[]) =>
    args[0] === 'auth'
      ? typeof status === 'string'
        ? { stdout: status }
        : status.err
          ? status
          : { stdout: JSON.stringify(status) }
      : probeOut;
  let d = await t.call('claude:detect', bin, false, false, null);
  assert.equal(d.state, 'signin');
  assert.deepEqual(d.auth, { loggedIn: false, authMethod: null, apiProvider: null, subscriptionType: null });

  status = 'not json';
  d = await t.call('claude:detect', bin, false, false, 'default');
  assert.equal(d.state, 'error');
  assert.match(d.error, /JSON/);
  status = { err: new Error('spawn failed'), stderr: ' denied \n' };
  d = await t.call('claude:detect', bin, false, false, null);
  assert.deepEqual([d.state, d.error], ['error', 'denied']);
  status = { err: Object.assign(new Error(''), { message: '' }) };
  d = await t.call('claude:detect', bin, false, false, null);
  assert.deepEqual([d.state, d.error], ['error', 'Error']);

  status = { loggedIn: true, authMethod: 'claude.ai' };
  const verify = async () => (await t.call('claude:detect', bin, false, true, null)).state;
  assert.equal(await verify(), 'ready');
  const lastArgs = fakes.runs[fakes.runs.length - 1].args;
  assert.deepEqual(lastArgs, ['-p', 'hi', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence']);
  // the CLI prints the 401 on stdout and exits non-zero
  probeOut = { err: new Error('exit 1'), stdout: 'Failed to authenticate. API Error: 401' };
  assert.equal(await verify(), 'signin');
  probeOut = { err: new Error('exit 1'), stderr: 'OAuth token has expired' };
  assert.equal(await verify(), 'signin');
  probeOut = { err: new Error('network down') };
  assert.equal(await verify(), 'ready');
  probeOut = { err: { message: '' } };
  assert.equal(await verify(), 'ready');

  const u = load();
  fs.writeFileSync(path.join(u.userData, 'claude-api-key'), 'sk-1');
  fs.writeFileSync(path.join(u.userData, 'claude-auth-mode'), 'apiKey');
  fakes.run = (_c: string, args: string[]) => (args[0] === 'auth' ? { stdout: '{"loggedIn":false}' } : { stdout: 'Invalid API key' });
  d = await u.call('claude:detect', bin, false, false, null);
  assert.equal(d.state, 'apikey');
  assert.equal((await u.call('claude:detect', bin, false, true, null)).state, 'error');
});

test('Windows discovery reads the usual install folders and Claude desktop’s bundled CLI, case-insensitively', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'win-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  process.env.HOME = dir;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const appData = path.join(dir, 'AppData', 'Roaming');
    const exe = fakeBin(path.relative(tmp, path.join(dir, '.claude/local/claude.exe')), '1.0.0');
    const top = fakeBin(path.relative(tmp, path.join(appData, 'Claude/claude-code/2.0/claude.exe')), '2.1.300');
    const nested = fakeBin(path.relative(tmp, path.join(appData, 'Claude/claude-code/2.0/h1/claude.exe')), '2.1.301');
    fs.writeFileSync(path.join(appData, 'Claude/claude-code/notadir'), '');
    process.env.CLAUDE_BIN = exe.toUpperCase().replace(tmp.toUpperCase(), tmp);
    const virtual = path.join(dir, 'virtual', 'claude.exe');
    const exists = fakes.exists;
    fakes.exists = (p: string) => p === virtual || p === process.env.CLAUDE_BIN || exists(p); // any case, as on Windows
    const t = load();
    try {
      const list = (await t.call('claude:detect', null, true, false, null)).candidates;
      assert.deepEqual(
        list.map((c: any) => c.path),
        [process.env.CLAUDE_BIN, top, nested],
      );
      assert.equal(await t.claude.findBinary(), nested);
      // a candidate whose real path can't be read still counts
      process.env.CLAUDE_BIN = virtual;
      process.env.APPDATA = path.join(dir, 'nowhere');
      const again = (await t.call('claude:detect', null, true, false, null)).candidates.map((c: any) => c.path);
      assert.deepEqual(again, [virtual, exe]);
      // other apps' sessions are not looked for on Windows
      fakes.run = () => {
        throw new Error('ps must not run');
      };
      assert.deepEqual(await t.call('claude:presence'), {});
    } finally {
      fakes.exists = exists;
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env.HOME = home;
    delete process.env.CLAUDE_BIN;
    delete process.env.APPDATA;
  }
});

test('/design-login runs the CLI sign-in on the account, opens its page and stops when the window or the app lets go', async () => {
  const { EventEmitter } = await import('node:events');
  const made: any[] = [];
  fakes.spawn = (...a: any[]) => {
    fakes.spawns.push(a);
    const p: any = new EventEmitter();
    p.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    p.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    p.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {} });
    p.kill = () => p.emit('close', null);
    made.push(p);
    return p;
  };
  try {
    const t = load();
    await assert.rejects(async () => t.call('claude:designLogin', 'w1', path.join(tmp, 'none'), null), /not installed/);
    const bin = fakeBin('design/claude');
    await t.call('claude:designLogin', 'w1', bin, 'acct');
    const [cmd, args, opts] = fakes.spawns.at(-1)!;
    assert.deepEqual([cmd, args], [bin, ['design-login', '--json']]);
    assert.ok(opts.env.PATH);
    const url = 'https://claude.ai/oauth/authorize?x=1';
    made[0].stdout.emit('data', `${JSON.stringify({ event: 'pages', url, manual_url: url, manual_first: false })}\n`);
    await flush();
    assert.deepEqual(fakes.opened, [url]);
    assert.deepEqual(t.broadcasts.filter(([ch]) => ch === 'claude:designLogin').at(-1)![1].kind, 'pages');
    assert.equal(await t.call('claude:designLoginCode', 'w1', 'abc#s'), true);
    await t.call('claude:designLoginCancel', 'w1');
    assert.deepEqual(t.broadcasts.filter(([ch]) => ch === 'claude:designLogin').at(-1)![1], {
      id: 'w1',
      kind: 'done',
      ok: false,
      message: 'The sign-in was cancelled.',
    });
    // quitting stops the one still running
    await t.call('claude:designLogin', 'w2', bin, null);
    t.claude.closeAll(0);
    assert.equal(t.broadcasts.filter(([ch]) => ch === 'claude:designLogin').at(-1)![1].id, 'w2');
    // before the IPC is registered there is no sign-in to stop
    load({ register: false }).claude.closeAll(0);
  } finally {
    fakes.spawn = () => {
      throw new Error('spawn is not faked');
    };
    fakes.opened.length = 0;
  }
});

test('MCP commands run only as add or remove, on the installed CLI', async () => {
  const t = load();
  for (const args of [null, ['mcp', 'list'], ['other', 'add'], ['mcp', 'add', 3]])
    await assert.rejects(t.call('claude:mcp', null, args, null), /Not an MCP command/);
  await assert.rejects(t.call('claude:mcp', path.join(tmp, 'none'), ['mcp', 'add', 'x'], null), /not installed/);
  const bin = fakeBin('mcp/claude');
  fakes.run = () => ({ stdout: ' Added x \n' });
  assert.equal(await t.call('claude:mcp', bin, ['mcp', 'add', 'x', 'cmd'], 'acct'), 'Added x');
  const r = fakes.runs[fakes.runs.length - 1];
  assert.deepEqual([r.cmd, r.args, r.opts.timeout], [bin, ['mcp', 'add', 'x', 'cmd'], 30000]);
  await t.call('claude:logout', bin);
  assert.deepEqual(fakes.runs[fakes.runs.length - 1].args, ['auth', 'logout']);
});

test('probe reports models, the account and what blocks fast mode, and closes its query', async () => {
  const t = load();
  const bin = fakeBin('probe/claude');
  let told = 0;
  t.claude.setProbeListener(() => told++);
  assert.equal(t.claude.probeInfo(), null);
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({
      models: [{ value: 'opus' }],
      account: { email: 'a@b.c', subscriptionType: 'max', apiProvider: 'firstParty' },
      fast_mode_disabled_reason: 'extra_usage_disabled',
    });
  };
  const out = await t.call('claude:probe', bin, 'acct');
  assert.deepEqual(out, {
    models: [{ value: 'opus' }],
    account: { subscriptionType: 'max', apiProvider: 'firstParty', email: 'a@b.c' },
    fastBlocked: 'extra_usage_disabled',
  });
  const q = lastQuery();
  assert.deepEqual(q.options.settings, { fastMode: true });
  assert.deepEqual(q.options.extraArgs, { 'no-chrome': null });
  assert.ok(q.calls.some((c) => c[0] === 'close'));
  assert.equal(told, 1);
  assert.equal(t.claude.probeInfo('acct'), out);
  assert.equal(t.claude.probeInfo('other'), null);

  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ fast_mode_disabled_reason: 'preference' });
    q.close = () => {
      throw new Error('already gone');
    };
  };
  const plain = await t.call('claude:probe', bin, null);
  assert.deepEqual(plain, { models: [], account: { subscriptionType: null, apiProvider: null, email: null }, fastBlocked: null });
  assert.equal(t.claude.probeInfo('other'), plain);
  assert.equal(t.claude.probeInfo(), plain);

  // MoPilot credits: the gateway's own models join the list; a failed capability read changes nothing
  t.claude.setGatewayKeyProvider(() => 'mpk_1');
  await t.call('claude:setAuthMode', 'mopilot');
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ models: [{ value: 'opus' }] });
  };
  // no capability table wired yet: the CLI's own list
  assert.deepEqual(
    (await t.call('claude:probe', bin, null)).models.map((m: any) => m.value),
    ['opus'],
  );
  t.claude.setGatewayCapsProvider(async () => ({ ds: { wires: ['anthropic'] } }));
  assert.deepEqual(
    (await t.call('claude:probe', bin, null)).models.map((m: any) => m.value),
    ['opus', 'ds'],
  );
  t.claude.setGatewayCapsProvider(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(
    (await t.call('claude:probe', bin, null)).models.map((m: any) => m.value),
    ['opus'],
  );
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({});
  };
  assert.deepEqual((await t.call('claude:probe', bin, null)).models, []);
});

test('probe gives up when the CLI never answers', async () => {
  const t = load();
  const bin = fakeBin('probe-slow/claude');
  fakes.onQuery = (q: any) => {
    q.initializationResult = () => new Promise(() => {});
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = t.call('claude:probe', bin, null);
    const before = fakes.queries.length;
    await waitFor(() => !(fakes.queries.length === before), 'the probe query to start');
    mock.timers.tick(20000);
    await assert.rejects(p, /Timed out asking Claude Code for its models/);
  } finally {
    mock.timers.reset();
  }
});

test('usage runs /usage unpersisted and reports failures; the identity layer reads it from the installed CLI', async () => {
  const t = load();
  const bin = fakeBin('usage/claude');
  fakes.onQuery = (q: any) => {
    q.push({ type: 'result', result: 'Plan: 10%' });
  };
  assert.equal((await t.call('claude:usage', bin, null, 'now')).text, 'Plan: 10%');
  assert.equal(lastQuery().options.persistSession, false);
  fakes.onQuery = (q: any) => q.end('broken pipe');
  assert.equal((await t.call('claude:usage', bin, 'acct', 'now')).error, 'broken pipe');
  fakes.onQuery = (q: any) => q.end(new Error('boom'));
  assert.equal((await t.call('claude:usage', bin, 'acct2', 'now')).error, 'boom');

  const dir = fs.mkdtempSync(path.join(home, 'usage-'));
  process.env.HOME = dir;
  try {
    const u = load();
    assert.equal(await u.claude.identity.readUsage('acct'), '');
    const found = fakeBin(path.relative(tmp, path.join(dir, '.local/bin/claude')));
    const v = load();
    fakes.onQuery = (q: any) => q.push({ type: 'result', result: 'Plan: 20%' });
    assert.equal(await v.claude.identity.readUsage(), 'Plan: 20%');
    assert.equal(lastQuery().options.pathToClaudeCodeExecutable, found);
  } finally {
    process.env.HOME = home;
  }
});

test('different gateway endpoint/key pairs cannot share a Claude billing signature', async () => {
  const t = load();
  await t.call('claude:setApiKey', 'part:secret', 'https://gateway.test/v1');
  const first = t.claude.billingSig();
  await t.call('claude:setApiKey', 'secret', 'https://gateway.test/v1:part');
  assert.equal(t.claude.cleanEnv().ANTHROPIC_BASE_URL, 'https://gateway.test/v1:part');
  assert.equal(t.claude.cleanEnv().ANTHROPIC_AUTH_TOKEN, 'secret');
  assert.notEqual(t.claude.billingSig(), first);
  assert.equal(t.claude.billingSig(), t.claude.billingSig());
});
