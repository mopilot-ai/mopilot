// The real shared Host tool setup captures while an action runs and again right after it settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { deferred } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';
// @ts-ignore: plain ESM without declarations
const { rig: setupRig } = await import('./support/computer-use-setup-rig.ts');
const { guarded } = createRequire(import.meta.url)('../electron/capabilities/contract/actionGuard.cjs');
const SHOT = {
  png: Buffer.from('PNGDATA').toString('base64'),
  width: 100,
  height: 100,
  pixelsPerPoint: 1,
  display: { id: 1, x: 0, y: 0, width: 100, height: 100 },
};

test('typing in the shared RemoteHelper requests a frame while the input runs and one right after completion', async () => {
  const action = deferred<any>();
  const entered = deferred();
  const shots: number[] = [];
  const sent: any[] = [];
  const remote = {
    lease: async () => undefined,
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
    command: async (_chat: string, method: string) => {
      if (method === 'screenshot') {
        shots.push(performance.now());
        return SHOT;
      }
      if (method === 'input.type') {
        entered.resolve();
        return action.promise;
      }
      return {};
    },
  };
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: { hostOwner: (c: string) => (c === 'onHost' ? 'h1' : null), remoteDesktopFor: () => remote, userIdleSeconds: async () => 1 },
  });
  const sender: any = {
    id: 70,
    isDestroyed: () => false,
    send: (_channel: string, message: any) => sent.push(message),
    once: () => undefined,
  };
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  const helper = r.runtime.hostDesktop.stack('h1').helper;
  await r.ipcFrom(sender, 'desktop:remoteWatch', 'p', 'onHost', 'h1');
  await r.ipcFrom(sender, 'desktop:remoteView', 'p', { visible: true });
  try {
    await waitFor(() => sent.some((f) => f.data), 'initial visible frame');
    const before = shots.length;
    const running = guarded({ token: { chat: 'onHost', turn: 1 } }, () => helper.type('hello'));
    await entered.promise;
    await waitFor(() => shots.length > before, 'frame while typing remains unresolved');
    const inFlight = shots.length;
    action.resolve({ ok: true });
    assert.deepEqual(await running, { ok: true });
    await waitFor(() => shots.length > inFlight, 'post-action frame');
    for (let i = 1; i < shots.length; i++) assert.ok(shots[i] - shots[i - 1] >= 249, 'shared Host budget remains bounded');
  } finally {
    action.resolve({ ok: true });
    await r.ipcFrom(sender, 'desktop:remoteStop', 'p');
  }
});
