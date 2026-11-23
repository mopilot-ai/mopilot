// Where a Host keeps its files (host/src/paths.mjs): a data dir spelled out is the same Host as the default one, so its config is in the same place; only another dir has a config of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';

const home = '/Users/me';
const mac = { platform: 'darwin' as const, home, env: {} };
const linux = { platform: 'linux' as const, home, env: {} };

test('the default Host: data in the platform folder, config in the XDG config folder', () => {
  assert.deepEqual(createPaths(mac), createPaths(mac));
  assert.equal(createPaths(mac).dataDir, '/Users/me/Library/Application Support/mopilot-host');
  assert.equal(createPaths(mac).configDir, '/Users/me/.config/mopilot-host');
  assert.equal(createPaths(linux).dataDir, '/Users/me/.local/share/mopilot-host');
  assert.equal(createPaths(linux).configDir, '/Users/me/.config/mopilot-host');
});

test('I: the default data dir spelled out (as the installed unit does) is the default Host: same config, so pair and login reach the running server', () => {
  for (const o of [mac, linux]) {
    const fallback = createPaths(o);
    for (const spelled of [fallback.dataDir, `${fallback.dataDir}/`, `${fallback.dataDir}/../${fallback.dataDir.split('/').pop()}`]) {
      assert.deepEqual(createPaths({ ...o, dataDir: spelled }), fallback, spelled);
    }
    // through the environment too
    assert.deepEqual(createPaths({ ...o, env: { MOPILOT_HOST_DATA: fallback.dataDir } }), fallback);
  }
  // XDG_DATA_HOME / XDG_CONFIG_HOME move the default, and spelling the moved default out is still the default
  const xdg = { ...linux, env: { XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/conf' } };
  assert.equal(createPaths(xdg).configDir, '/x/conf/mopilot-host');
  assert.deepEqual(createPaths({ ...xdg, dataDir: '/x/data/mopilot-host' }), createPaths(xdg));
});

test('another data dir is another Host: its config is inside it, so two Hosts never share keys or pairings', () => {
  for (const o of [mac, linux]) {
    const other = createPaths({ ...o, dataDir: '/srv/host-b' });
    assert.equal(other.configDir, '/srv/host-b/config');
    assert.notEqual(other.configDir, createPaths(o).configDir);
    assert.equal(createPaths({ ...o, env: { MOPILOT_HOST_DATA: '/srv/host-b' } }).configDir, '/srv/host-b/config');
  }
});
