// A Host connection replacement retires cursor input even without a pane polling it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
const { rig: setupRig } = await import('./support/computer-use-setup-rig.ts');
const { guarded } = createRequire(import.meta.url)('../electron/capabilities/contract/actionGuard.cjs');
const SHOT = {
  png: Buffer.from('PNGDATA').toString('base64'),
  width: 1000,
  height: 500,
  pixelsPerPoint: 0.5,
  display: { id: 1, x: 100, y: 50, width: 2000, height: 1000 },
};

test('a Host reconnect between pane polls retires a pending approach even without a pane', async () => {
  const log: string[] = [];
  const makeRemote = (name: string) => ({
    lease: async () => undefined,
    command: async (_c: string, method: string) => (log.push(`${name}:${method}`), method === 'screenshot' ? SHOT : { ok: true }),
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  });
  let remote = makeRemote('old');
  let arrive!: () => void;
  let approached!: () => void;
  const started = new Promise<void>((resolve) => {
    approached = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: () => 'h1',
      remoteDesktopFor: () => remote,
      userIdleSeconds: async () => 1,
      sleep: () => {
        approached();
        return waiting;
      },
    },
  });
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  const helper = r.runtime.hostDesktop.stack('h1').helper;
  const as = (fn: () => Promise<unknown>) => guarded({ token: { chat: 'onHost', turn: 1 } }, fn);
  const clicking = as(() => helper.click(40, 30));
  const stopped = assert.rejects(clicking, (e: any) => e.code === 'aborted');
  await started;
  remote = makeRemote('new');
  await r.registry.invoke('onHost', 's1', 'desktop_screenshot', {});
  arrive();
  await stopped;
  assert.equal(
    log.some((entry) => entry.endsWith(':input.click')),
    false,
  );
  // The replacement connection still supports the next action.
  await as(() => helper.click(60, 30));
  assert.equal(log.at(-1), 'new:input.click');
});

for (const replacement of [false, true]) {
  test(`actual transport reconnect retires delayed input without another lookup (${replacement ? 'replacement wrapper' : 'stable wrapper'})`, async (t) => {
    const { hostWorld, onlineRemote } = await import('./support/host-wire-kit.ts');
    const { waitFor } = await import('./support/waitFor.ts');
    const { FEATURES } = await import('../shared/host/schema.mjs');
    const { hostDesktopOptions } = createRequire(import.meta.url)('../electron/host/remoteDesktop.cjs');
    const w = hostWorld(t);
    w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...FEATURES] });
    w.net.handlers['desktop.lease'] = () => ({ leased: true });
    w.net.handlers['desktop.state'] = () => ({ available: true });
    w.net.handlers['desktop.call'] = (p: any) => (p.method === 'screenshot' ? SHOT : { ok: true });
    const original = await onlineRemote(w);
    let currentHost = original.host;
    const hosts = [original.host];
    t.after(() => hosts.forEach((host) => host.dispose()));
    let arrive!: () => void;
    let approached!: () => void;
    const started = new Promise<void>((resolve) => {
      approached = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const r = setupRig({
      flags: { 'shared.computerUse.parityTools': true },
      options: {
        ...hostDesktopOptions({ hostOwnership: { get: () => ({ hostId: 'h1' }) }, connectedHostFor: () => currentHost }),
        userIdleSeconds: async () => 1,
        sleep: () => {
          approached();
          return waiting;
        },
      },
    });
    await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
    const helper = r.runtime.hostDesktop.stack('h1').helper;
    const as = (fn: () => Promise<unknown>) => guarded({ token: { chat: 'onHost', turn: 1 } }, fn);
    const clicking = as(() => helper.click(40, 30));
    const rejected = assert.rejects(clicking, (error: any) => error.code === 'aborted');
    await started;
    w.net.last.destroy();
    await waitFor(() => original.host.state() !== 'online', 'old transport offline');
    if (replacement) {
      const next = await onlineRemote(w);
      currentHost = next.host;
      hosts.push(next.host);
    } else {
      await waitFor(() => {
        w.clock.advance(100);
        return original.host.state() === 'online';
      }, 'same transport reconnected');
    }
    // No tool call, frame poll or stackFor lookup happened during the wait.
    arrive();
    await rejected;
    const inputs = () =>
      w.net.sockets
        .flatMap((socket) => socket.written)
        .filter((request) => request.method === 'desktop.call' && request.params.method === 'input.click');
    assert.equal(inputs().length, 0);
    await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'next action' });
    await as(() => helper.click(60, 30));
    assert.equal(inputs().length, 1, 'fresh input succeeds after reconnect');
  });
}

test('an ownership epoch change cancels a delayed click even when the chat returns to the same Host', async () => {
  const log: string[] = [];
  const remote = {
    lease: async () => undefined,
    command: async (_chat: string, method: string) => (log.push(method), {}),
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  };
  let epoch = 1;
  let arrive!: () => void;
  let approached!: () => void;
  const started = new Promise<void>((resolve) => {
    approached = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: () => 'h1',
      hostEpoch: () => epoch,
      remoteDesktopFor: () => remote,
      userIdleSeconds: async () => 1,
      sleep: () => {
        approached();
        return waiting;
      },
    },
  });
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  const helper = r.runtime.hostDesktop.stack('h1').helper;
  const as = (fn: () => Promise<unknown>) => guarded({ token: { chat: 'onHost', turn: 1 } }, fn);
  const clicking = as(() => helper.click(40, 30));
  const rejected = assert.rejects(clicking, (error: any) => error.code === 'aborted');
  await started;
  epoch = 3;
  arrive();
  await rejected;
  assert.equal(log.includes('input.click'), false);
  await as(() => helper.click(60, 30));
  assert.equal(log.at(-1), 'input.click');
});

test('one desktop wrapper/listener per live Host; disposal retires its generation', async (t) => {
  const { hostWorld, onlineRemote } = await import('./support/host-wire-kit.ts');
  const { hostDesktopOptions } = createRequire(import.meta.url)('../electron/host/remoteDesktop.cjs');
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const onState = host.onState;
  let listeners = 0;
  host.onState = (fn: any) => {
    listeners++;
    return onState(fn);
  };
  const options = hostDesktopOptions({ connectedHostFor: () => host });
  const first = options.remoteDesktopFor('h1');
  assert.equal(options.remoteDesktopFor('h1'), first);
  assert.equal(listeners, 1);
  const generation = first.generation();
  host.dispose();
  assert.notEqual(first.generation(), generation);
  assert.equal(first.alive(), false);
});
