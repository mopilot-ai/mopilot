// Update preferences refresh the shared feature flags whenever the effective release channel changes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let refreshes = 0;
mock.module('../electron/platform/flags.cjs', {
  namedExports: {
    refreshFlags: async () => {
      refreshes++;
      return false;
    },
  },
});
mock.module('../electron/platform/install.cjs', {
  namedExports: { installId: () => 'install', serviceFile: (dir: string, name: string) => `${dir}/${name}` },
});
mock.module('../electron/platform/exitGate.cjs', { namedExports: { createExitGate: () => ({}), isEmpty: () => true } });
mock.module('../electron/updates/updater.cjs', {
  namedExports: {
    Updater: class {
      channel = 'stable';
      state = { status: 'idle' };
      configure(prefs: { channel: string }) {
        this.channel = prefs.channel;
        return this.state;
      }
    },
  },
});
const { createUpdates } = await import('../electron/app/updates.cjs');

test('startup, repeated preferences, switches, and loss of internal access use the effective channel', () => {
  let internal = true;
  const updates = createUpdates({
    app: { getPath: () => '/unused', getVersion: () => '1.0.0', on: () => {} },
    win: { mainWindow: () => null, viewedBy: new Map(), windows: new Set() },
    readState: () => ({ prefs: {} }),
    live: { mopilot: { status: () => ({ user: { internal } }) } },
  } as any);
  updates.openUpdates();
  assert.equal(refreshes, 0, 'flags startup will discover the initial stable channel');
  const state = updates.configureUpdates({ auto: true, channel: 'beta' });
  assert.equal(state, updates.updater.state);
  assert.equal(refreshes, 1);
  updates.configureUpdates({ auto: false, channel: 'beta' });
  assert.equal(refreshes, 1, 'changing only auto-update does not rediscover flags');
  updates.configureUpdates({ auto: false, channel: 'dogfood' });
  assert.equal(refreshes, 2);
  internal = false;
  updates.configureUpdates();
  assert.equal(updates.updater.channel, 'beta');
  assert.equal(refreshes, 3, 'sign-out/internal-access changes refresh shared flags too');
  updates.configureUpdates();
  assert.equal(refreshes, 3);
});
