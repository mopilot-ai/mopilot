// Native marketplace responses cannot authorize unrelated plugin removal or escape the owned cache.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { test, assert, fs, path, write, setup, plugin, install } from './support/codex-plugin-mirror-fixture.ts';

for (const issue of ['traversal', 'unrelated-id', 'wrong-location', 'linked-location']) {
  test(`mirror refuses ${issue} ownership before any native or disk cleanup`, async (t) => {
    const world = setup();
    t.after(() => fs.rmSync(world.dir, { recursive: true, force: true }));
    const base = fs.realpathSync(world.dir);
    const manifest = path.join(base, 'cache', 'acme', '.agents', 'plugins', 'marketplace.json');
    write(manifest, '{}');
    const row: any = {
      name: 'mopilot-acme',
      path: manifest,
      plugins: [{ id: 'tidy@mopilot-acme', name: 'tidy', installed: true, enabled: true }],
    };
    if (issue === 'traversal') row.name = 'mopilot-../../victim';
    if (issue === 'unrelated-id') row.plugins[0].id = 'native@user';
    if (issue === 'wrong-location') row.path = path.join(base, 'unrelated.json');
    if (issue === 'linked-location') {
      const unrelated = path.join(base, 'unrelated.json');
      write(unrelated, 'preserve');
      fs.unlinkSync(manifest);
      fs.symlinkSync(unrelated, manifest);
    }
    world.codex.extra.push(row);
    await assert.rejects(world.mirror.sync(), /marketplace|plugin/i);
    assert.deepEqual(world.methods(), ['plugin/list']);
    assert.equal(fs.existsSync(manifest), true);
  });
}

for (const response of [
  null,
  {},
  { marketplaces: null },
  { marketplaces: 1 },
  { marketplaces: [null] },
  { marketplaces: [{ name: 'acme', plugins: {} }] },
]) {
  test(`mirror rejects malformed plugin/list boundary ${JSON.stringify(response)}`, async () => {
    const world = setup();
    world.mirror.request = async () => response;
    await assert.rejects(world.mirror.sync(), /plugin\/list|marketplace/i);
  });
}

test('a failed uninstall retains suppression and manifest ownership until a successful retry', async () => {
  let on = true;
  const world = setup({ enabled: () => on });
  await install(world.store, plugin('tidy'));
  await world.mirror.sync();
  on = false;
  world.codex.fail['plugin/uninstall'] = 'busy';
  await world.mirror.sync();
  const off = { plugins: { 'tidy@mopilot-acme': { enabled: false } } };
  assert.deepEqual(world.mirror.threadConfig(), off);
  assert.deepEqual(world.mirror.threadConfig({ helper: true }), off);
  const manifest = path.join(world.dir, 'cache/acme/.agents/plugins/marketplace.json');
  assert.equal(fs.existsSync(manifest), true);
  delete world.codex.fail['plugin/uninstall'];
  world.codex.fail['marketplace/remove'] = 'still busy';
  await world.mirror.sync();
  assert.equal(fs.existsSync(manifest), true, 'unregistration failure preserves a retryable marketplace');
  delete world.codex.fail['marketplace/remove'];
  await world.mirror.sync();
  assert.equal(fs.existsSync(manifest), false);
  assert.deepEqual(world.mirror.threadConfig(), {});
});

for (const response of [
  null,
  {},
  { installedRoot: 7 },
  { installedRoot: '/unrelated' },
  { installedRoot: '/unrelated', marketplaceName: 'foreign' },
]) {
  test(`marketplace/add cannot redirect plugin installation: ${JSON.stringify(response)}`, async () => {
    const world = setup();
    await install(world.store, plugin('tidy'));
    const request = world.codex.request;
    world.mirror.request = async (method: string, params: any) => (method === 'marketplace/add' ? response : request(method, params));
    await world.mirror.sync();
    assert.equal(world.mirror.states['tidy@acme'].state, 'failed');
    assert.match(world.mirror.states['tidy@acme'].error, /marketplace\/add/);
    assert.equal(world.methods().includes('plugin/install'), false);
  });
}

for (const mutation of ['uninstall', 'reinstall']) {
  test(`Codex holds its snapshot through native installation during ${mutation}`, async () => {
    const world = setup();
    const source = plugin('tidy');
    const record = await install(world.store, source);
    const request = world.codex.request;
    world.mirror.request = async (method: string, params: any) => {
      if (method === 'plugin/list') {
        if (mutation === 'uninstall') await world.store.uninstall('tidy@acme');
        else await install(world.store, source);
        assert.equal(fs.existsSync(record.path), true, 'the native copy still owns its source');
      }
      return request(method, params);
    };
    await world.mirror.sync();
    assert.equal(fs.existsSync(record.path), false, 'the stale source is released when sync settles');
    assert.equal(world.store.inUse.size, 0);
  });
}

for (const phase of ['list', 'write', 'remove']) {
  test(`missing manifest under a redirected ancestor cannot authorize ${phase}`, async (t) => {
    const world = setup();
    t.after(() => fs.rmSync(world.dir, { recursive: true, force: true }));
    const base = fs.realpathSync(world.dir);
    const outside = path.join(base, 'outside');
    const marker = path.join(outside, '.agents', 'keep');
    write(marker, 'preserve');
    if (phase === 'write') await install(world.store, plugin('tidy'));
    const market = path.join(base, 'cache', 'acme');
    const manifest = path.join(market, '.agents', 'plugins', 'marketplace.json');
    const redirect = () => {
      fs.rmSync(market, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(market), { recursive: true });
      fs.symlinkSync(outside, market);
    };
    if (phase !== 'write') world.codex.extra.push({ name: 'mopilot-acme', path: manifest, plugins: [] });
    if (phase === 'remove' || phase === 'write') {
      if (phase === 'remove') write(manifest, '{}');
      const request = world.codex.request;
      world.mirror.request = async (method: string, params: any) => {
        if (method === (phase === 'remove' ? 'marketplace/remove' : 'plugin/list')) redirect();
        return request(method, params);
      };
    } else redirect();
    await assert.rejects(world.mirror.sync(), /marketplace/i);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
    assert.equal(fs.existsSync(path.join(outside, '.agents/plugins/marketplace.json')), false);
  });
}

for (const row of [
  { name: 'mopilot-acme', path: 7, plugins: [] },
  { name: 'native', plugins: [null] },
]) {
  test(`mirror rejects malformed marketplace ownership ${JSON.stringify(row)}`, async () => {
    const world = setup();
    world.mirror.request = async () => ({ marketplaces: [row] });
    await assert.rejects(world.mirror.sync(), /marketplace/i);
  });
}

test('duplicate owned marketplaces are refused, and missing removal state remains retryable', async () => {
  const world = setup();
  const manifest = path.join(fs.realpathSync(world.dir), 'cache/acme/.agents/plugins/marketplace.json');
  write(manifest, '{}');
  const row = { name: 'mopilot-acme', path: manifest, plugins: [{ id: 'tidy@mopilot-acme', name: 'tidy', installed: true }] };
  world.codex.extra.push(row, row);
  await assert.rejects(world.mirror.sync(), /Duplicate/);
  world.codex.extra.pop();
  world.codex.fail['plugin/uninstall'] = 'busy';
  await world.mirror.sync();
  assert.equal(world.mirror.states['tidy@acme'].path, '');
});

test('dangling marketplace ancestors cannot receive generated manifests', async () => {
  const { ownedManifestPath, addedMarketplacePath } = require('../electron/plugins/codexMirrorBoundary.cjs');
  const world = setup();
  const root = fs.realpathSync(world.dir);
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'cache', 'acme'));
  assert.throws(() => ownedManifestPath(root, 'acme'), /Dangling/);
  assert.throws(() => ownedManifestPath(root, '../bad'), /name/);
  assert.throws(() => addedMarketplacePath({}, root, 'acme'), /Dangling/);
});

test('an unregistered owned plugin can fail removal without a logging subscriber', async () => {
  const { CodexPluginMirror } = require('../electron/plugins/codexMirror.cjs');
  const world = setup();
  const manifest = path.join(fs.realpathSync(world.dir), 'cache/acme/.agents/plugins/marketplace.json');
  write(manifest, '{}');
  world.codex.extra.push({ name: 'mopilot-acme', path: manifest, plugins: [{ id: 'tidy@mopilot-acme', name: 'tidy', installed: true }] });
  world.codex.fail['plugin/uninstall'] = 'busy';
  const mirror = new CodexPluginMirror({ store: world.store, request: world.codex.request, connected: () => true });
  await mirror.sync();
  assert.equal(mirror.states['tidy@acme'].state, 'removeFailed');
});
