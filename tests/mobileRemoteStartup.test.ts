// Startup retains module instrumentation and applies initial flags before restoring phone consent.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const startup = createRequire(import.meta.url)('../electron/perf/startup.cjs');
after(() => {
  unloadMain();
  startup.resetStartupMarks();
});

test('persisted phone consent starts after initial flags without a change event', { timeout: 10_000 }, async () => {
  startup.resetStartupMarks();
  let initialized = false;
  const started = deferred<void>();
  const h = await loadMain({
    state: { prefs: { mobileRemoteOwner: JSON.stringify(['user', 'desktop']) } },
    before(h) {
      const flags = h.mod('platform/flags.cjs');
      const original = flags.isEnabled;
      flags.isEnabled = mock.fn((key: string) => (key === 'remote.enabled' ? initialized : original(key)));
      flags.initFlags.mock.mockImplementation((options: unknown) => {
        assert.deepEqual(
          startup.moduleBreakdowns().map((mark: any) => mark.name),
          ['whenReady'],
        );
        initialized = true;
        return { flags: options };
      });
      h.mods['electron/identity/mopilot.cjs'].MoPilotAccount = h.cls('MoPilotAccount', () => ({
        creds: { user: { id: 'user' }, deviceId: 'desktop' },
        status: () => ({ signedIn: true, user: { id: 'user', features: ['phone'] }, checkedAt: 1 }),
        gatewayKey: () => 'gateway',
        modelCaps: async () => ({}),
        accessToken: async () => 'token',
        setConsent: async () => undefined,
      }));
      h.mods['electron/remote/relayClient.cjs'] = {
        RelayClient: h.cls('RelayClient', () => ({ on: () => () => undefined, start: mock.fn(() => started.resolve()), stop: mock.fn() })),
      };
    },
  });
  assert.deepEqual(startup.moduleBreakdowns(), [], 'the module sample belongs to Electron readiness');
  await h.ready();
  assert.equal(startup.moduleBreakdowns().length, 1);
  assert.ok(Object.keys(startup.moduleBreakdowns()[0].packages).some((folder) => folder.startsWith('./electron')));
  assert.equal(initialized, true);
  const relay = h.one('RelayClient');
  await started.promise;
  assert.equal(relay.start.mock.callCount(), 1);
  assert.equal(h.mod('platform/flags.cjs').initFlags.mock.callCount(), 1);
});
