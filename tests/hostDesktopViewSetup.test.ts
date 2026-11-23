// A Host chat's desktop pane as the real setup builds it (electron/capabilities/hostDesktop.cjs with hostDesktopView.cjs): watching, takeover through main's tab, and the agent's cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
const { rig: setupRig } = await import('./support/computer-use-setup-rig.ts');

const require = createRequire(import.meta.url);
const { waitFor } = await import('./support/waitFor.ts');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

const SHOT = {
  png: Buffer.from('PNGDATA').toString('base64'),
  width: 1000,
  height: 500,
  pixelsPerPoint: 0.5,
  display: { id: 1, x: 100, y: 50, width: 2000, height: 1000 },
};

test('as the real setup builds it: a pane watches a chat on a Host, not one on this Mac or one that cannot be placed; taking over holds the agent without a stack too', async () => {
  const log: any[] = [];
  const remote = {
    lease: async () => undefined,
    command: async (c: string, m: string) => (log.push([c, m]), SHOT),
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  };
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: (c: string) => (c === 'lost' ? '\u0000unknown-owner' : c === 'onHost' ? 'h1' : null),
      remoteDesktopFor: (id: string) => (id === 'h1' ? remote : null),
      userIdleSeconds: async () => 1,
    },
  });
  const sender: any = { id: 7, isDestroyed: () => false, send: () => undefined, once: () => undefined };
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p1', 'onHost', 'h1'), true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p2', 'onMac', 'h1'), false);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p3', 'lost', 'h1'), false);
  // no stack was built for the chat yet (it has not used the desktop): taking over holds nothing and does not throw
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { visible: true, takeover: true }), true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteStop', 'p1'), true);
  // once the chat has used its Host's desktop there is a stack, and the takeover reaches its interrupt
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p1', 'onHost', 'h1'), true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { takeover: true }), true);
});

test('as the real setup builds it: a takeover from main’s tab (any window) aborts the Host and the pane’s input follows main’s state, not the pane’s claim', async () => {
  const log: string[] = [];
  const remote = {
    lease: async (c: string, a: unknown) => void log.push(`lease ${c} ${String(a)}`),
    command: async (c: string, m: string) => (log.push(`${m} ${c}`), SHOT),
    release: async (c: string) => void log.push(`release ${c}`),
    abort: async (c: string) => void log.push(`abort ${c}`),
    state: async () => ({ available: true }),
    alive: () => true,
  };
  let current: any = remote;
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: (c: string) => (c === 'onHost' ? 'h1' : null),
      remoteDesktopFor: (id: string) => (id === 'h1' ? current : null),
      userIdleSeconds: async () => 1,
    },
  });
  const sender: any = { id: 8, isDestroyed: () => false, send: () => undefined, once: () => undefined };
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  const tabs = r.runtime.hostDesktop.tabs;
  tabs.note('onHost', 'h1', true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p1', 'onHost', 'h1'), true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p2', 'onHost', 'h2'), false, 'a pane for another machine');
  // the pane claims a takeover; main's tab does not know it: nothing is forwarded, and the agent is not stopped
  await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { takeover: true });
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteInput', 'p1', { kind: 'key', key: 'a' }), false);
  assert.ok(!log.some((l) => l.startsWith('abort')));
  tabs.takeOver('onHost', false);
  // the takeover comes from the tab (browser:takeOver from any window): the Host is told to let go, then the user's lease is taken
  tabs.takeOver('onHost', true);
  await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { takeover: true }); // the pane follows main's list
  await waitFor(() => log.includes('lease onHost *'), 'the user’s lease');
  assert.ok(log.indexOf('abort onHost') >= 0, 'the agent’s side on the Host is stopped');
  assert.ok(log.indexOf('lease onHost *') > log.indexOf('abort onHost'), 'the user’s lease comes after');
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteInput', 'p1', { kind: 'key', key: 'a' }), true);
  // the turn ends: the takeover ends with it and input stops
  tabs.idle('onHost');
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteInput', 'p1', { kind: 'key', key: 'a' }), false);
  // the pane follows main's list and hands the desktop back: the user's lease is released, the agent holding nothing
  await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { takeover: false });
  await waitFor(() => log.includes('release onHost'), 'the user’s lease given back');
  // a chat that is not on a Host any more has nothing to stop there
  tabs.note('onMac', 'h1', true);
  assert.equal(tabs.takeOver('onMac', true), true);
  // the Host reconnects: its leases are gone, so a takeover on it ends
  tabs.takeOver('onHost', true);
  current = { ...remote };
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  assert.equal(tabs.takenOver('onHost'), false);
});

test('as the real setup builds it: an agent click shows its cursor in the watching pane, goes when the cursor has arrived, presses on the Host’s answer; a takeover takes the cursor away', async () => {
  const log: string[] = [];
  const remote = {
    lease: async () => undefined,
    command: async (c: string, m: string) => (log.push(`${m} ${c}`), m === 'screenshot' ? SHOT : { ok: true }),
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  };
  const waits: number[] = [];
  let online = true;
  const r = setupRig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: (c: string) => (c === 'onHost' ? 'h1' : null),
      remoteDesktopFor: (id: string) => (id === 'h1' && online ? remote : null),
      userIdleSeconds: async () => 1,
      sleep: async (ms: number) => void (waits.push(ms), log.push('arrived')),
    },
  });
  const sent: any[] = [];
  const sender: any = { id: 9, isDestroyed: () => false, send: (_c: string, m: any) => sent.push(m), once: () => undefined };
  await r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: [], reason: 'x' });
  r.runtime.hostDesktop.tabs.note('onHost', 'h1', true);
  assert.equal(await r.ipcFrom(sender, 'desktop:remoteWatch', 'p1', 'onHost', 'h1'), true);
  // the pane's own frame is taken with the same geometry bookkeeping as the agent's screenshots
  await r.ipcFrom(sender, 'desktop:remoteView', 'p1', { visible: true });
  await waitFor(() => sent.some((m) => m.data), 'the pane’s first frame');
  assert.equal(sent.find((m) => m.data).version, 1);
  const helper = r.runtime.hostDesktop.stack('h1').helper;
  const as = (fn: () => Promise<unknown>) => guarded({ token: { chat: 'onHost', turn: 1 } }, fn);
  await as(() => helper.screenshot({}));
  await as(() => helper.click(40, 30));
  const cursors = sent.filter((m) => m.cursor).map((m) => m.cursor.kind);
  assert.deepEqual(cursors, ['approach', 'dispatched']);
  assert.equal(sent.find((m) => m.cursor?.kind === 'approach').cursor.version, 1, 'placed by the display layout the chat’s screenshot had');
  assert.deepEqual(log.slice(-3), ['screenshot onHost', 'arrived', 'input.click onHost'], 'the click goes when the cursor has arrived');
  assert.equal(waits.length, 1);
  // the user takes over while it is showing: the cursor goes with the agent's side
  await as(() => helper.click(60, 30));
  r.runtime.hostDesktop.tabs.takeOver('onHost', true);
  assert.deepEqual(
    sent.filter((m) => m.cursor).at(-1).cursor,
    { kind: 'hide', id: 0, hostId: 'h1' },
    'the takeover takes the agent’s cursor away',
  );
  // the machine drops while the pane watches: what shows for its chats goes with it
  r.runtime.hostDesktop.tabs.takeOver('onHost', false);
  await as(() => helper.click(80, 30));
  online = false;
  await waitFor(() => sent.some((m) => m.error), 'the pane to find the machine gone');
  assert.deepEqual(sent.filter((m) => m.cursor).at(-1).cursor, { kind: 'hide', id: 0, hostId: 'h1' });
  await r.ipcFrom(sender, 'desktop:remoteStop', 'p1');
});
