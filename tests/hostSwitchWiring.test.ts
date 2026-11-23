// What stands behind the Switch host dialog: the pure target and reason rules, main's owner reader and IPC (host:owner, host:continue), the renderer's owner hook, and the composer wiring that sends the continue and reads the owner again.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, flush, mockTsx, mount } from './support/composer-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { targetsFor } from '../src/lib/hostSwitch.ts';

const require = createRequire(import.meta.url);
const { chatOwner: createChatOwner } = require('../electron/host/machines.cjs');
const { remoteChatOwners } = require('../electron/host/ownedChats.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const { ContinueRefusal } = require('../shared/host/continue.mjs');

let hostAllowed = true;
mock.module('../src/lib/host.ts', {
  namedExports: { useHostAccess: () => hostAllowed, useHostAnswered: () => true, hostAllowedNow: () => hostAllowed },
});
mock.module('../src/lib/hostMachines.ts', {
  namedExports: {
    useHostMachines: () => ({
      machines: [{ id: 'box', name: 'build-box', status: 'online', note: 'SSH · Codex', capabilities: { iab: true, cu: true } }],
      resolved: true,
    }),
    readMachineAgents: async () => [],
    readMachineRow: async () => undefined,
  },
});
mock.module('../src/components/momo/useMomoChat.ts', { namedExports: { useMomoChat: () => null } });
mockTsx(new URL('../src/components/composer/ComposerMenus.tsx', import.meta.url), { ModePicker: () => null, PermissionPicker: () => null });
const { ComposerModeChips } = await import('../src/components/composer/ComposerModeChips.tsx');
const { useChatOwner } = await import('../src/lib/hostOwner.ts');

const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('targets: the owner is out unless it is lost, and an attention row without a note still says why', () => {
  const ms = [
    { id: 'a', name: 'A', status: 'online' as const, note: '' },
    { id: 'b', name: 'B', status: 'attention' as const, note: '' },
    { id: 'c', name: 'C', status: 'attention' as const, note: 'Needs login' },
  ];
  assert.deepEqual(
    targetsFor(ms, 'a', false).map((t) => [t.id, t.reason]),
    [
      ['b', 'Needs attention'],
      ['c', 'Needs login'],
    ],
  );
  assert.deepEqual(
    targetsFor(ms, 'a', true).map((t) => [t.id, t.reason]),
    [
      ['a', null],
      ['b', 'Needs attention'],
      ['c', 'Needs login'],
    ],
  );
});

test('the owner reader: nothing while Host is off or for a bad id; this Mac for an unclaimed chat; the file read again each time', (t) => {
  const dir = dirOf(t);
  let allowed = false;
  const ownerOf = createChatOwner({ dir, allowed: () => allowed });
  assert.equal(ownerOf('c1'), null, 'gate closed');
  allowed = true;
  assert.equal(ownerOf(7), null);
  assert.equal(ownerOf(''), null);
  assert.deepEqual(ownerOf('c1'), { hostId: 'local', epoch: 0 });
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 2 });
  assert.deepEqual(ownerOf('c1'), { hostId: 'box', epoch: 2 }, 'a move by another window shows at once');
});

test('the remote chats reader: none while Host is off; every chat a machine owns, the file read again each time', (t) => {
  const dir = dirOf(t);
  let allowed = false;
  const owned = remoteChatOwners({ dir, allowed: () => allowed });
  assert.deepEqual(owned(), [], 'gate closed');
  allowed = true;
  assert.deepEqual(owned(), []);
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  store.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 2 });
  store.set('c2', { hostId: 'local', ownerHostId: 'local', epoch: 1 });
  store.set('c3', { hostId: 'local', ownerHostId: 'mini', epoch: 3 });
  assert.deepEqual(owned(), [
    { chatId: 'c1', hostId: 'box' },
    { chatId: 'c3', hostId: 'mini' },
  ]);
});

function ipc(over: { live?: any; allowed?: () => boolean; dir?: string } = {}) {
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      live: over.live ?? {},
      app: { getPath: () => over.dir ?? os.tmpdir() },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
    },
    { create: () => ({ list: () => ({ machines: [], resolved: true }) }) as any, allowed: over.allowed ?? (() => true) },
  );
  return (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
}

test('IPC host:owner answers only while Host is allowed', async (t) => {
  let allowed = false;
  const call = ipc({ allowed: () => allowed, dir: dirOf(t) });
  assert.equal(await call('host:owner', 'c1'), null);
  allowed = true;
  assert.deepEqual(await call('host:owner', 'c1'), { hostId: 'local', epoch: 0 });
  register({ handle: () => undefined }, undefined, { allowed: () => true });
});

test('IPC host:remoteChats answers only while Host is allowed', async (t) => {
  const dir = dirOf(t);
  let allowed = false;
  const call = ipc({ allowed: () => allowed, dir });
  assert.deepEqual(await call('host:remoteChats'), []);
  allowed = true;
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1 });
  assert.deepEqual(await call('host:remoteChats'), [{ chatId: 'c1', hostId: 'box' }]);
});

test('IPC host:continue: refused when Host is off, for a request without chat, host or folder, and until the machine is wired; otherwise main’s answer or the refusal with its code', async () => {
  let allowed = false;
  const asked: any[] = [];
  const live: any = {};
  const call = ipc({ live, allowed: () => allowed });
  const req = { chatId: 'c1', targetHostId: 'box', cwd: '/srv' };
  assert.equal((await call('host:continue', req)).error.code, 'not_allowed');
  allowed = true;
  for (const bad of [undefined, {}, { ...req, chatId: '' }, { ...req, targetHostId: 4 }, { ...req, cwd: null }]) {
    const r = await call('host:continue', bad);
    assert.equal(r.error.code, 'invalid');
    assert.equal(r.error.message, 'Pick a host and a folder.');
  }
  const idle = await call('host:continue', req);
  assert.deepEqual(idle.error, { message: "Switching host isn't available yet.", code: 'unsupported' });
  live.hostContinue = async (r: unknown) => (asked.push(r), { hostId: 'box', epoch: 1 });
  assert.deepEqual(await call('host:continue', req), { value: { hostId: 'box', epoch: 1 } });
  assert.deepEqual(await call('host:continue', { ...req, lostHostConfirmed: true, extra: 1 }), { value: { hostId: 'box', epoch: 1 } });
  assert.deepEqual(asked, [
    { ...req, lostHostConfirmed: false, carry: null },
    { ...req, lostHostConfirmed: true, carry: null },
  ]);
  // the changes the user asked to carry go through as a confirmed list of files; anything else is dropped
  await call('host:continue', { ...req, carry: { confirmed: true, untracked: ['a.txt', 4, null], extra: 1 } });
  await call('host:continue', { ...req, carry: { confirmed: 'yes', untracked: 'nope' } });
  assert.deepEqual(asked.slice(2), [
    { ...req, lostHostConfirmed: false, carry: { confirmed: true, untracked: ['a.txt'], unpushed: 0 } },
    { ...req, lostHostConfirmed: false, carry: { confirmed: false, untracked: [], unpushed: 0 } },
  ]);
  live.hostContinue = async () => {
    throw new ContinueRefusal('directory_missing', 'No such folder.');
  };
  assert.deepEqual((await call('host:continue', req)).error, { message: 'No such folder.', code: 'directory_missing' });
});

function Probe({ chatId, seen }: { chatId: string | null; seen: { ownerId: string; known: boolean; refresh: () => void }[] }) {
  seen.push(useChatOwner(chatId));
  return null;
}

test('the owner hook: this Mac until main answers, then the chat’s owner; an answer for another chat is dropped; refresh reads again; no read without Host or a chat', async () => {
  hostAllowed = true;
  const pending = new Map<string, (v: unknown) => void>();
  const fake = fakeNative({ host: { owner: (id: string) => new Promise((r) => pending.set(id, r)) } });
  installNative(fake);
  const seen: { ownerId: string; known: boolean; refresh: () => void }[] = [];
  const m = await mount(createElement(Probe, { chatId: 'a', seen }));
  assert.equal(seen.at(-1)!.ownerId, 'local');
  assert.equal(seen.at(-1)!.known, false, 'not assumed to be this Mac while main has not answered');
  await m.render(createElement(Probe, { chatId: 'b', seen }));
  await act(async () => pending.get('a')!({ hostId: 'late', epoch: 1 }));
  assert.equal(seen.at(-1)!.ownerId, 'local', 'the answer for the chat that was left is dropped');
  await act(async () => pending.get('b')!({ hostId: 'box', epoch: 3 }));
  assert.equal(seen.at(-1)!.ownerId, 'box');
  assert.equal(seen.at(-1)!.known, true);
  await m.render(createElement(Probe, { chatId: 'a', seen }));
  assert.equal(seen.at(-1)!.ownerId, 'local', 'another chat does not borrow it');
  await act(async () => pending.get('a')!(null));
  assert.equal(seen.at(-1)!.ownerId, 'local', 'no record means this Mac');
  const before = fake.callsTo('host.owner').length;
  await act(async () => seen.at(-1)!.refresh());
  assert.equal(fake.callsTo('host.owner').length, before + 1);
  await m.render(createElement(Probe, { chatId: null, seen }));
  assert.equal(seen.at(-1)!.known, true, "a new chat is this Mac's");
  hostAllowed = false;
  await m.render(createElement(Probe, { chatId: 'a', seen }));
  assert.equal(fake.callsTo('host.owner').length, before + 1, 'no chat or no Host: nothing is read');
  await m.unmount();
  hostAllowed = true;
});

const typeDir = (value: string) =>
  act(async () => {
    const input = $('input[aria-label="Folder on the host"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('the window calls unwrap the answer: a value, or an Error that keeps the refusal code', async () => {
  const fake = fakeNative({
    host: {
      continueChat: async (r: { cwd: string }) =>
        r.cwd === '/bad' ? { error: { message: 'No such folder.', code: 'directory_missing' } } : { value: { hostId: 'box', epoch: 2 } },
      codePlan: async () => ({ value: null }),
    },
  });
  installNative(fake);
  const { hostContinue } = await import('../src/lib/hostContinue.ts');
  const req = { chatId: 'c', targetHostId: 'box', lostHostConfirmed: false };
  assert.deepEqual(await hostContinue.run({ ...req, cwd: '/ok' }), { hostId: 'box', epoch: 2 });
  await assert.rejects(
    hostContinue.run({ ...req, cwd: '/bad' }),
    (e: any) => e.code === 'directory_missing' && e.message === 'No such folder.',
  );
  assert.equal(await hostContinue.plan({ chatId: 'c', targetHostId: 'box', cwd: '/ok' }), null);
});

test('the bridge types load', async () => {
  await import('../src/lib/native/host.ts');
});

test('a new chat draws no footer host chip (it picks in the context bar’s Run on chip); a started chat’s chip remembers the folder under it', async () => {
  hostAllowed = true;
  const { useStore } = await import('../src/store/core.ts');
  installNative(
    fakeNative({
      host: {
        access: async () => true,
        owner: async () => null,
        codePlan: async () => ({ value: null }),
        continueChat: async () => ({ value: { hostId: 'box', epoch: 1 } }),
      },
    }),
  );
  const props = { basic: null, harness: null, goalMode: false, planMode: false, remoteControl: null, onClearGoal() {}, onClearPlan() {} };
  const none = await mount(createElement(ComposerModeChips, { ...props, threadId: null }));
  assert.equal($('button.host-chip'), null, 'a new chat picks its machine in the context bar’s Run on chip');
  await none.unmount();
  useStore.setState({ threads: { c9: { cwd: '/work/c9' } } } as any);
  const m = await mount(createElement(ComposerModeChips, { ...props, threadId: 'c9' }));
  await flush();
  try {
    await click($('button.host-chip'));
    await click($$('[role=menu] [role^=menuitem]').at(-1));
    await typeDir('/srv/c9');
    await click($$('.acct-dialog-actions button')[1]);
    assert.equal(localStorage.getItem(`hostDir:${JSON.stringify(['box', '/work/c9'])}`), '/srv/c9');
  } finally {
    await m.unmount();
    useStore.setState({ threads: {} } as any);
  }
});

test('the composer sends the continue through the bridge and reads the owner again, whatever the outcome', async () => {
  hostAllowed = true;
  let fail: { message: string; code: string } | null = null;
  const fake = fakeNative({
    host: {
      access: async () => true,
      owner: async () => ({ hostId: 'local', epoch: 0 }),
      codePlan: async () => ({ value: null }),
      continueChat: async () => (fail ? { error: fail } : { value: { hostId: 'box', epoch: 1 } }),
    },
  });
  installNative(fake);
  const props = {
    threadId: 'c1',
    basic: null,
    harness: null,
    goalMode: false,
    planMode: false,
    remoteControl: null,
    onClearGoal() {},
    onClearPlan() {},
  };
  const m = await mount(createElement(ComposerModeChips, props));
  await flush();
  const open = async () => {
    await click($('button.host-chip'));
    await click($$('[role=menu] [role^=menuitem]').at(-1));
    assert.equal($('[role=dialog] .switch-host-name').textContent, 'build-box');
  };
  try {
    await open();
    await typeDir('/srv/app');
    fail = { message: 'x', code: 'directory_missing' };
    await click($$('.acct-dialog-actions button')[1]);
    assert.equal($('[role=alert]').textContent, "That folder doesn't exist on build-box.");
    assert.equal(fake.callsTo('host.owner').length, 2, 'a refusal reads the owner again: an unsettled continue may have moved it');
    fail = null;
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(
      fake.callsTo('host.codePlan').at(-1),
      [{ chatId: 'c1', targetHostId: 'box', cwd: '/srv/app' }],
      'the plan is asked first',
    );
    assert.deepEqual(fake.callsTo('host.continueChat').at(-1), [
      { chatId: 'c1', targetHostId: 'box', cwd: '/srv/app', lostHostConfirmed: false },
    ]);
    assert.equal($('[role=dialog]'), null);
    assert.equal(fake.callsTo('host.owner').length, 3);
  } finally {
    await m.unmount();
  }
});

type Owner = { ownerId: string; known: boolean; refresh: () => void };
function TwoReaders({ chatId, a, b }: { chatId: string; a: Owner[]; b: Owner[] }) {
  a.push(useChatOwner(chatId));
  b.push(useChatOwner(chatId));
  return null;
}

test('a continue is seen by every reader of the owner (the chip and the summary machine chip), not only the one that asked', async () => {
  hostAllowed = true;
  let owner = 'box';
  installNative(fakeNative({ host: { owner: async () => ({ hostId: owner, epoch: 1 }) } }));
  const a: Owner[] = [];
  const b: Owner[] = [];
  const m = await mount(createElement(TwoReaders, { chatId: 'c1', a, b }));
  await flush();
  assert.deepEqual([a.at(-1)!.ownerId, b.at(-1)!.ownerId], ['box', 'box']);
  // the chat is switched back to this Mac: the chip's reader refreshes, the card's must follow
  owner = 'local';
  await act(async () => a.at(-1)!.refresh());
  await flush();
  assert.deepEqual([a.at(-1)!.ownerId, b.at(-1)!.ownerId], ['local', 'local']);
  // a reader that is gone is not read for
  await m.unmount();
  const asked = a.length;
  await act(async () => a.at(-1)!.refresh());
  assert.equal(a.length, asked, 'an unmounted reader is not asked again');
});

test('a chat continued to a folder runs there: the thread follows it after the continue, and stays put when the continue is refused', async () => {
  hostAllowed = true;
  const { useStore } = await import('../src/store/core.ts');
  let fail: { message: string; code: string } | null = null;
  installNative(
    fakeNative({
      host: {
        access: async () => true,
        owner: async () => ({ hostId: 'local', epoch: 0 }),
        codePlan: async () => ({ value: null }),
        continueChat: async () => (fail ? { error: fail } : { value: { hostId: 'box', epoch: 1 } }),
      },
    }),
  );
  useStore.setState({ threads: { c1: { id: 'c1', cwd: '/work/c1' } } } as any);
  const props = { basic: null, harness: null, goalMode: false, planMode: false, remoteControl: null, onClearGoal() {}, onClearPlan() {} };
  const m = await mount(createElement(ComposerModeChips, { ...props, threadId: 'c1' }));
  await flush();
  try {
    await click($('button.host-chip'));
    await click($$('[role=menu] [role^=menuitem]').at(-1));
    await typeDir('/srv/c1');
    fail = { message: 'x', code: 'directory_missing' };
    await click($$('.acct-dialog-actions button')[1]);
    assert.equal(useStore.getState().threads.c1.cwd, '/work/c1', 'a refusal leaves the folder as it was');
    fail = null;
    await click($$('.acct-dialog-actions button')[1]);
    assert.equal(useStore.getState().threads.c1.cwd, '/srv/c1');
    // a chat the store does not hold is left alone
    useStore.setState({ threads: {} } as any);
    await click($('button.host-chip'));
    await click($$('[role=menu] [role^=menuitem]').at(-1));
    await typeDir('/srv/other');
    await click($$('.acct-dialog-actions button')[1]);
    assert.deepEqual(useStore.getState().threads, {});
  } finally {
    await m.unmount();
    useStore.setState({ threads: {} } as any);
  }
});

test('IPC host:codePlan: refused when Host is off or the request is incomplete; nothing to plan until main has its chat sessions', async () => {
  let allowed = false;
  const call = ipc({ live: {}, allowed: () => allowed });
  const req = { chatId: 'c1', targetHostId: 'box', cwd: '/srv' };
  assert.equal((await call('host:codePlan', req)).error.code, 'not_allowed');
  allowed = true;
  assert.equal((await call('host:codePlan', { ...req, cwd: '' })).error.code, 'invalid');
  assert.deepEqual(await call('host:codePlan', req), { value: null });
});
