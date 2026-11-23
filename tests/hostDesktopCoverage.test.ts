// The Host desktop's smaller pieces that the larger flows do not reach: a write whose reply is lost, the machine a chat lives on when that cannot be read, a machine's approvals on disk (kept, listed, taken back, gone with the machine), the announce timer, the connection's agreed features, a typed message to a Host, and the Host desktop as setupComputerUse builds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { FEATURES } from '../shared/host/schema.mjs';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';
import { world as sendWorld, msg, UUID } from './support/host/remoteSendKit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { rig } = await import('./support/computer-use-setup-rig.ts');
const { createRemoteDesktop, hostDesktopOptions } = require('../electron/host/remoteDesktop.cjs');
const { UNKNOWN_OWNER } = require('../shared/host/desktop.mjs');
const { createHostApprovals } = require('../electron/capabilities/hostApprovals.cjs');
const { hostChatMeta, hostGrantStore, hostsWithGrants, removeHostGrants } = require('../electron/capabilities/hostGrants.cjs');
const { desktopAnnounce } = require('../electron/host/desktopAnnounce.cjs');
const { machineBroker } = require('../electron/capabilities/hostDesktop.cjs');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-desktop-cov-'));

test('a write whose reply is lost after it was sent is outcome_unknown; one that was never sent, and a read, are not', async () => {
  const fail = (e: any) => createRemoteDesktop({ host: { desktop: { request: async () => Promise.reject(e) } } });
  const lost = () => Object.assign(new Error('gone'), { code: 'host_unreachable' });
  await assert.rejects(fail(lost()).command('c', 'input.click', {}), (e: any) => e.code === 'outcome_unknown');
  await assert.rejects(
    fail(Object.assign(lost(), { notSent: true })).command('c', 'input.click', {}),
    (e: any) => e.code === 'not_connected',
  );
  await assert.rejects(fail(lost()).command('c', 'screenshot', {}), (e: any) => e.code === 'not_connected');
});

test('where a chat lives: a machine, this Mac, or unknown (never this Mac) when the ownership cannot be read; the machine is named', () => {
  const hosts: Record<string, any> = { h1: { desktop: { request: async () => ({}) } } };
  const o = hostDesktopOptions({
    hostOwnership: {
      get: (c: string) => {
        if (c === 'boom') throw new Error('unreadable');
        return c === 'none' ? {} : { hostId: c === 'mac' ? 'local' : 'h1' };
      },
    },
    connectedHostFor: (id: string) => hosts[id] ?? null,
    hostNameOf: (id: string) => (id === 'h1' ? 'box' : undefined),
  });
  assert.equal(o.hostOwner('x'), 'h1');
  assert.equal(o.hostOwner('mac'), null);
  assert.equal(o.hostOwner('none'), UNKNOWN_OWNER);
  assert.equal(o.hostOwner('boom'), UNKNOWN_OWNER);
  assert.equal(o.hostName('h1'), 'box');
  assert.equal(o.hostName('h2'), 'another machine');
  assert.equal(o.remoteDesktopFor('h2'), null);
  assert.equal(o.remoteDesktopFor('h1'), o.remoteDesktopFor('h1'));
  assert.equal(hostDesktopOptions({}).hostName('h1'), 'another machine');
});

test('a machine’s chat approvals: unchanged writes answer false, a file that cannot be read is an empty list, and the index finds a machine that left', () => {
  const dir = tmp();
  const file = path.join(dir, 'chats.json');
  fs.writeFileSync(file, '{ not json');
  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(valid, JSON.stringify({ k: { n: 1 } }));
  assert.deepEqual(hostChatMeta(valid).ids(), ['k']);
  assert.equal(hostChatMeta(valid).patchMeta('k', { n: 1 }), false, 'a value that stays the same is no change');
  assert.equal(hostChatMeta(valid).patchMeta('k', { n: 2 }), true);
  assert.equal(
    hostChatMeta(path.join(dir, 'fresh.json')).patchMeta('c', { n: 1 }),
    true,
    'a plain value on a chat with nothing yet is a change',
  );
  const meta = hostChatMeta(file);
  assert.deepEqual(meta.ids(), []);
  assert.equal(meta.get('c'), null);
  assert.equal(meta.patchMeta('c', { computerGrants: [] }), false, 'a list that stays empty is no change');
  assert.equal(meta.patchMeta('c', { computerGrants: [1] }), true);
  assert.equal(meta.patchMeta('c', { computerGrants: [1] }), false);
  assert.deepEqual(meta.get('c'), { meta: { computerGrants: [1] } });
  // the index of machines with approvals
  fs.mkdirSync(path.join(dir, 'capabilities'));
  fs.writeFileSync(path.join(dir, 'capabilities', 'computer-hosts.json'), 'garbage');
  assert.deepEqual(hostsWithGrants(dir), []);
  hostGrantStore({ dir, hostId: 'm1' });
  assert.deepEqual(hostsWithGrants(dir), ['m1']);
  removeHostGrants(dir, 'm1');
  assert.deepEqual(hostsWithGrants(dir), []);
});

test('Settings’ approvals per machine with the defaults a caller may leave out, and the two channels that take them back', async () => {
  const dir = tmp();
  const stores = new Map<string, any>();
  const grantsFor = (id: string) => (stores.has(id) || stores.set(id, hostGrantStore({ dir, hostId: id })), stores.get(id));
  grantsFor('h1').grant('c1', NOTES, 'click', 'chat');
  // no known machines, no live stack, no forget: nothing listed, a revoke goes to the store, a sweep forgets nothing
  const bare = createHostApprovals({ grantsFor, nameOf: () => 'box' });
  assert.deepEqual(bare.settings(), []);
  assert.equal(bare.revoke('h1', 'c1', NOTES.bundleId), true);
  assert.doesNotThrow(() => bare.sweep(new Set()));
  assert.doesNotThrow(
    () => createHostApprovals({ grantsFor, nameOf: () => 'box', knownHosts: () => ['h1'] }).sweep(new Set()),
    'no forget given: nothing to do',
  );
  const live = createHostApprovals({
    grantsFor,
    nameOf: () => 'box',
    stackOf: () => ({ desktop: { revoke: (_c: any, b: string) => b === 'x' } }),
  });
  assert.equal(live.revoke('h1', null, 'x'), true, 'a live stack forgets the app in its session too');
  grantsFor('h1').grant(null as any, NOTES, 'click', 'always');
  const a = createHostApprovals({ grantsFor, nameOf: () => 'box', knownHosts: () => ['h1', ''] });
  assert.equal(a.settings().length, 1);
  const handlers = new Map<string, any>();
  a.register({ handle: (c: string, fn: any) => handlers.set(c, fn) });
  assert.equal(await handlers.get('computer:revokeOnMachine')({}, 'h1', null, NOTES.bundleId), true);
  assert.equal(await handlers.get('computer:revokeOnMachine')({}, 7, null, NOTES.bundleId), false, 'a machine id that is not text');
  assert.equal(await handlers.get('computer:revokeOnMachine')({}, 'h1', null, 5), false, 'an app that is not text');
  grantsFor('h1').grant(null as any, NOTES, 'click', 'always');
  assert.equal(await handlers.get('computer:revokeAllOnMachine')({}, 'h1'), true);
  assert.equal(await handlers.get('computer:revokeAllOnMachine')({}, 9), false);
});

test('a lost desktop is announced as lost after the wait, with the real timer; a gain is told at once', async () => {
  const row = { has: true };
  let resyncs = 0;
  const a = desktopAnnounce({ has: () => row.has, resync: () => void resyncs++, goneMs: 15 });
  row.has = false;
  a.onRow();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.announced(), false);
  assert.equal(resyncs, 1);
  // it came back and went again while waiting: nothing is told for the blip
  row.has = true;
  a.onRow();
  assert.equal(a.announced(), true);
  row.has = false;
  a.onRow();
  row.has = true;
  a.onRow();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.announced(), true, 'the wait ended with the desktop back');
  a.dispose();
  // a reading that flipped back with no notice: the timer looks again before it tells anyone
  const quiet = { has: true };
  let told = 0;
  const b = desktopAnnounce({ has: () => quiet.has, resync: () => void told++, goneMs: 15 });
  quiet.has = false;
  b.onRow();
  quiet.has = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.announced(), true);
  assert.equal(told, 0);
});

test('the machine’s broker passes everything but a card through, and a card names the machine', async () => {
  const asked: any[] = [];
  const target = { ask: async (...a: any[]) => asked.push(a), sweep: () => 'swept', plain: 7 };
  const b = machineBroker(target, 'box');
  assert.equal(b.sweep(), 'swept');
  assert.equal(b.plain, 7);
  await b.ask('c', 'computerAccess', { app: 'x' }, { signal: null });
  assert.deepEqual(asked[0].slice(0, 3), ['c', 'computerAccess', { app: 'x', machine: 'box' }]);
});

test('a connection says which features it agreed on: the Host’s own after the hello', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...FEATURES] });
  const { host } = await onlineRemote(w, {}, { epochOf: () => 0 });
  assert.equal(host.speaks('origin'), true);
  assert.equal(host.speaks('not-a-feature'), false);
});

test('a message the user typed goes to its Host as one a person wrote; one nobody typed does not', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  await w.service.send('c1', { ...msg('typed', UUID(1)), opts: { human: true } }, 1);
  await w.service.send('c1', { ...msg('peer', UUID(2)), opts: {} }, 1);
  assert.deepEqual(
    w.sent.map((s: any) => [s.item.text, s.item.human]),
    [
      ['typed', true],
      ['peer', undefined],
    ],
  );
});

test('the Host desktop as the real setup builds it: an approval lists under the machine and is taken back through the channels, an idle user is refused and stops the turn, a machine that left takes its approvals, a chat that cannot be placed fails closed', async () => {
  const log: any[] = [];
  const remote = {
    lease: async (c: string, apps: any) => void log.push(['lease', c, apps]),
    command: async (c: string, m: string, params: any = {}) => {
      log.push(['command', c, m]);
      if (m === 'apps.resolve')
        return {
          apps: params.queries.map((q: string) => ({
            query: q,
            app: { bundleId: 'com.apple.Notes', name: 'Notes', running: true, pid: 1 },
          })),
        };
      return m === 'displays.list' ? { displays: [] } : { ok: true };
    },
    release: async (c: string) => void log.push(['release', c]),
    abort: async (c: string) => void log.push(['abort', c]),
    state: async () => ({ available: true }),
    alive: () => true,
  };
  let idle = 1;
  const r = rig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: (c: string) => (c === 'lost' ? UNKNOWN_OWNER : c === 'onHost' ? 'h1' : null),
      remoteDesktopFor: (id: string) => (id === 'h1' ? remote : null),
      hostName: (id: string) => (id === 'h1' ? 'box' : undefined),
      userIdleSeconds: async () => idle,
    },
  });
  r.states.set('onHost', { activeTurn: { id: 't1', human: true }, permission: 'default' });
  const lost = await r.registry.invoke('lost', 's1', 'desktop_screenshot', {});
  assert.equal(lost.error.code, 'unavailable', 'a chat that cannot be placed never runs on this Mac');
  // the person answers the machine-named card with "Allow in this chat"
  const asked = r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: ['Notes'], reason: 'x' });
  await waitFor(() => r.approvals.length > 0, 'the machine-named card');
  assert.equal(r.approvals[0].params.machine, 'box');
  await r.ipc('computer:answer', r.approvals[0].id, { decision: 'allow', scope: 'chat' });
  assert.equal((await asked).ok, true);
  assert.ok(
    r.log.some((l) => l[0] === 'broadcast' && l[1] === 'computer:changed'),
    'the page hears the approval',
  );
  const status = await r.ipc('computer:status');
  assert.deepEqual(
    status.machines.map((m: any) => [m.id, m.name, m.chats.map((c: any) => c.chatId)]),
    [['h1', 'box', ['onHost']]],
  );
  // nobody is at the user's Mac: the call is refused, the turn stops, nothing reaches the Host's desktop
  idle = 11 * 60;
  const before = log.length;
  const click = await r.registry.invoke('onHost', 's1', 'desktop_left_click', { coordinate: [1, 1] });
  assert.equal(click.ok, false);
  assert.equal(click.error.code, 'unattended');
  assert.equal(log.slice(before).filter((l) => l[2] === 'input.click').length, 0);
  assert.ok(r.log.some((l) => l[0] === 'stop' && l[1] === 'onHost'));
  // Remove through the channels, then a machine that left takes the rest with it
  assert.equal(await r.ipc('computer:revokeOnMachine', 'h1', 'onHost', 'com.apple.Notes'), true);
  assert.equal(await r.ipc('computer:revokeAllOnMachine', 'h1'), false, 'nothing always allowed there');
  assert.deepEqual((await r.ipc('computer:status')).machines, []);
  r.runtime.hostDesktop.approvals.sweep(new Set());
  assert.deepEqual((await r.ipc('computer:status')).machines, []);
});
