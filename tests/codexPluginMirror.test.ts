// Codex plugin mirror follows installs, upgrades, removals and the native plugin configuration.
import {
  test,
  assert,
  fs,
  path,
  tmp,
  plugin,
  install,
  setup,
  CodexPluginMirror,
  PluginStore,
  codexId,
  codexMarketplace,
} from './support/codex-plugin-mirror-fixture.ts';

test('ids and marketplace names Codex sees', () => {
  assert.equal(codexId('tidy@acme'), 'tidy@mopilot-acme');
  assert.equal(codexMarketplace('acme'), 'mopilot-acme');
});

test('nothing goes to Codex while it is down', async () => {
  const dir = tmp();
  const store = new PluginStore({ dir: () => dir });
  const calls: string[] = [];
  const request = async (m: string) => (calls.push(m), { marketplaces: [] });
  assert.equal(await new CodexPluginMirror({ store }).sync(), false, 'nothing attached: not connected');
  assert.deepEqual(calls, []);
  const later = new CodexPluginMirror({ store });
  await assert.rejects(later.request('plugin/list', {}), /Codex isn't connected/);
  later.attach({ request, connected: () => true });
  assert.equal(await later.sync(), true);
  assert.deepEqual(calls, ['plugin/list']);
});

test('a store plugin is installed through its marketplace; one Codex already has is left to it', async () => {
  const t = setup();
  const tidy = await install(t.store, plugin('tidy'));
  await install(t.store, plugin('stripe'));
  assert.equal(await t.mirror.sync(), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(t.dir, 'cache/acme/.agents/plugins/marketplace.json'), 'utf8'));
  assert.deepEqual(manifest, {
    name: 'mopilot-acme',
    plugins: [{ name: 'tidy', source: { source: 'local', path: `./${path.relative(path.join(t.dir, 'cache/acme'), tidy.path)}` } }],
  });
  assert.deepEqual(t.methods(), ['plugin/list', 'marketplace/add', 'plugin/install']);
  assert.deepEqual([...t.codex.markets.get('mopilot-acme')!.installed], ['tidy']);
  assert.deepEqual(t.mirror.states, {
    'stripe@acme': { codexId: 'stripe@mopilot-acme', path: (await t.store.list()).plugins[0].path, state: 'alreadyOn' },
    'tidy@acme': { codexId: 'tidy@mopilot-acme', path: tidy.path, state: 'installed' },
  });
  // what it left is kept on disk, and read back by the next start
  assert.deepEqual(new CodexPluginMirror({ store: t.store }).states, t.mirror.states);
  assert.deepEqual(t.mirror.threadConfig(), {}, 'on: nothing switched off per thread');

  // again: already installed from this folder, nothing to do
  t.codex.calls.length = 0;
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list']);
});

test('an upgrade replaces Codex’s copy; a plugin the store no longer gives Codex is removed, then its marketplace', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  await t.mirror.sync();
  const upgraded = await install(t.store, plugin('tidy', '1.1.0'));
  t.codex.calls.length = 0;
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list', 'plugin/uninstall', 'plugin/install']);
  assert.equal(t.mirror.states['tidy@acme'].path, upgraded.path);

  await t.store.setEnabled('tidy@acme', false, 'codex');
  t.codex.calls.length = 0;
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list', 'plugin/uninstall', 'marketplace/remove']);
  assert.equal(t.codex.markets.size, 0);
  assert.equal(fs.existsSync(path.join(t.dir, 'cache/acme/.agents')), false);
  assert.deepEqual(t.mirror.states, {});
});

test('failures are recorded per plugin and logged, and the next sync tries again', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  t.codex.fail['marketplace/add'] = 'marketplace refused';
  await t.mirror.sync();
  assert.deepEqual(t.mirror.states['tidy@acme'], {
    codexId: 'tidy@mopilot-acme',
    path: (await t.store.list()).plugins[0].path,
    state: 'failed',
    // a sentence without the RPC method; the method and Codex's words are logged (#1863)
    error: 'Marketplace refused.',
  });
  assert.deepEqual(t.logs, ["Couldn't add the acme marketplace to Codex (marketplace/add): marketplace refused"]);
  t.logs.length = 0;
  delete t.codex.fail['marketplace/add'];
  t.codex.fail['plugin/install'] = 'install refused';
  await t.mirror.sync();
  assert.equal(t.mirror.states['tidy@acme'].error, 'Install refused.');
  assert.deepEqual(t.logs, ["Couldn't install tidy@mopilot-acme in Codex (plugin/install): install refused"]);
  t.logs.length = 0;
  delete t.codex.fail['plugin/install'];
  await t.mirror.sync();
  assert.equal(t.mirror.states['tidy@acme'].state, 'installed');

  // Failed cleanup retains native ownership and its manifest for suppression and retry.
  await t.store.uninstall('tidy@acme');
  t.codex.fail['plugin/uninstall'] = 'busy';
  t.codex.fail['marketplace/remove'] = 'busy too';
  await t.mirror.sync();
  assert.deepEqual(t.logs, ["Couldn't remove tidy@mopilot-acme from Codex: busy"]);
});

test('a refusal that is not an Error is recorded as it was said', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  const request = t.mirror.request;
  t.mirror.request = async (m: string, p: unknown) => {
    if (m === 'marketplace/add') throw 'plain refusal';
    return request(m, p);
  };
  await t.mirror.sync();
  assert.equal(t.mirror.states['tidy@acme'].error, 'Plain refusal.');
});

test('a sync that throws leaves the next one free to run', async () => {
  const t = setup();
  t.codex.fail['plugin/list'] = 'down';
  await assert.rejects(t.mirror.sync(), /down/);
  delete t.codex.fail['plugin/list'];
  assert.equal(await t.mirror.sync(), true);
});

test('with plugins.codex off, threads switch them off at once and the next sync takes them out of Codex', async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await install(t.store, plugin('tidy'));
  await t.mirror.sync();
  assert.deepEqual(t.mirror.threadConfig({ helper: true }), { plugins: { 'tidy@mopilot-acme': { enabled: false } } }, 'helpers never');
  on = false;
  assert.deepEqual(t.mirror.threadConfig(), { plugins: { 'tidy@mopilot-acme': { enabled: false } } });
  t.codex.calls.length = 0;
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list', 'plugin/uninstall', 'marketplace/remove']);
  assert.deepEqual(t.mirror.threadConfig(), {});
});

test('a store that cannot be read leaves Codex as it is', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  await t.mirror.sync();
  fs.writeFileSync(t.store.file(), JSON.stringify({ version: 99, plugins: {} }));
  t.codex.calls.length = 0;
  await assert.rejects(t.mirror.sync(), /couldn't be read, so Codex was left as it is/);
  assert.deepEqual(t.methods(), []);
  assert.deepEqual([...t.codex.markets.get('mopilot-acme')!.installed], ['tidy']);
});

test("a mopilot-* marketplace that isn't in the store's folder is the user's, and left alone", async () => {
  const t = setup();
  t.codex.extra.push({
    name: 'mopilot-tools',
    path: '/Users/me/tools/.agents/plugins/marketplace.json',
    plugins: [{ id: 'x@mopilot-tools', name: 'x', installed: true }],
  });
  t.codex.extra.push({ name: 'mopilot-odd', path: null, plugins: [] });
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list']);
});

test('a plugin found installed with no record of where from is adopted, not reinstalled', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  await t.mirror.sync();
  fs.rmSync(t.mirror.stateFile());
  const fresh = new CodexPluginMirror({ store: t.store, request: t.codex.request, connected: () => true });
  assert.deepEqual(fresh.states, {});
  t.codex.calls.length = 0;
  await fresh.sync();
  assert.deepEqual(t.methods(), ['plugin/list']);
  assert.equal(fresh.states['tidy@acme'].state, 'installed');
});

test('an unchanged marketplace file is not written again', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  await t.mirror.sync();
  const file = path.join(t.dir, 'cache/acme/.agents/plugins/marketplace.json');
  const old = new Date(2020, 0, 1);
  fs.utimesSync(file, old, old);
  await t.mirror.sync();
  assert.equal(fs.statSync(file).mtime.getTime(), old.getTime());
});

test("the store's folder may not exist yet, and an unreadable file in the way is an error", async () => {
  const store = {
    o: { dir: () => path.join(tmp(), 'not-yet') },
    reserveFor: async () => ({ deliver: [], withheld: [], error: null }),
    release: async () => {},
  };
  const m = new CodexPluginMirror({ store, request: async () => ({ marketplaces: [] }), connected: () => true });
  assert.equal(await m.sync(), true);
  const blocked = tmp();
  fs.writeFileSync(path.join(blocked, 'file'), 'x');
  const bad = new CodexPluginMirror({
    store: { o: { dir: () => path.join(blocked, 'file', 'below') }, reserveFor: store.reserveFor, release: store.release },
    request: async () => ({ marketplaces: [] }),
    connected: () => true,
  });
  await assert.rejects(bad.sync(), /ENOTDIR/);
});

test('a marketplace file that cannot be read stops the sync with why', async () => {
  const t = setup();
  await install(t.store, plugin('tidy'));
  fs.mkdirSync(path.join(t.dir, 'cache/acme/.agents/plugins/marketplace.json'), { recursive: true });
  await assert.rejects(t.mirror.sync(), /EISDIR/);
});
