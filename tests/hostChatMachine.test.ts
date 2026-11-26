// A chat on a machine (src/lib/chatMachine.ts): its folder is read nowhere on this Mac, the composer says when the machine is offline and that its permission mode can't be changed here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import './support/dom.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

type Chats = { owners: Map<string, string>; status: 'unknown' | 'ready' | 'failed'; answered: boolean };
const LOCAL: Chats = { owners: new Map(), status: 'ready', answered: true };
const ON_BOX = (id: string): Chats => ({ owners: new Map([['chat', id]]), status: 'ready', answered: true });
let chats: Chats = LOCAL;
let machines: { id: string; name: string; status: string; [k: string]: unknown }[] = [];
mockSource('src/lib/hostChats.ts', {
  useHostChats: () => chats,
  // the real one is tested in tests/hostChats.test.ts
  machineOfChat: (c: Chats, id: string | null) => (!id ? '' : c.status === 'unknown' || !c.answered ? null : (c.owners.get(id) ?? '')),
});
mockSource('src/store/core.ts', { useStore: (sel: (s: object) => unknown) => sel({ threadOrder: [] }), toast: () => undefined });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
const { useChatMachine, useLocalFolder, useRemoteFolderValue, usePullRequestFolder } = await import('../src/lib/chatMachine.ts');
const { MachineFolderNote } = await import('../src/components/panels/MachineFolderNote.tsx');
const { HostAwayStrip } = await import('../src/components/composer/HostAwayStrip.tsx');
const { HostModeChip } = await import('../src/components/composer/HostModeChip.tsx');

const BOX = { id: 'ssh:me@box', name: 'box', status: 'online' };
beforeEach(() => {
  chats = LOCAL;
  machines = [];
});

/** Prints what the hooks answer for a chat whose folder is /srv/app. */
function Probe() {
  const m = useChatMachine('chat');
  const f = useLocalFolder('chat', '/srv/app');
  return h('i', { 'data-out': JSON.stringify([m, f]) });
}
const out = (host: HTMLElement) => JSON.parse(one(host, 'i').getAttribute('data-out')!);

test('a chat on this Mac reads its own folder', async () => {
  const r = await render(h(Probe));
  assert.deepEqual(out(r.host), [
    { machine: null, pending: false },
    { cwd: '/srv/app', machine: null, pending: false },
  ]);
  await r.unmount();
});

test('a scoped reader waits through lookup failure unless the chat already has a known Host', async () => {
  const StrictFolder = () => h('i', { 'data-out': JSON.stringify(useLocalFolder('chat', '/srv/app', true)) });
  chats = { ...LOCAL, status: 'failed' };
  const r = await render(h(StrictFolder));
  assert.deepEqual(out(r.host), { cwd: '', machine: null, pending: true, ownerUnavailable: true });
  chats = LOCAL;
  await r.rerender(h(StrictFolder));
  assert.deepEqual(out(r.host), { cwd: '/srv/app', machine: null, pending: false });
  chats = { ...ON_BOX(BOX.id), status: 'failed' };
  await r.rerender(h(StrictFolder));
  assert.deepEqual(out(r.host), { cwd: '', machine: { id: BOX.id, name: BOX.id, away: false }, pending: false });
  await r.unmount();
});

test('a chat whose owner is not known yet reads no folder, and one on a machine reads none and names it', async () => {
  chats = { ...LOCAL, status: 'unknown' };
  const r = await render(h(Probe));
  assert.deepEqual(out(r.host), [
    { machine: null, pending: true },
    { cwd: '', machine: null, pending: true },
  ]);
  chats = ON_BOX(BOX.id);
  machines = [BOX];
  await r.rerender(h(Probe));
  const want = { id: BOX.id, name: 'box', away: false, row: BOX };
  assert.deepEqual(out(r.host), [
    { machine: want, pending: false },
    { cwd: '', machine: want, pending: false },
  ]);
  machines = [{ ...BOX, status: 'offline' }];
  await r.rerender(h(Probe));
  assert.equal(out(r.host)[0].machine.away, true);
  machines = [];
  await r.rerender(h(Probe));
  assert.deepEqual(out(r.host)[0].machine, { id: BOX.id, name: BOX.id, away: false }, 'a machine that is not listed is named by its id');
  await r.unmount();
});

test('before main says whether Host exists a chat reads no folder here, and a chat with no id has nothing to wait for', async () => {
  chats = { ...LOCAL, answered: false };
  const r = await render(h(Probe));
  assert.deepEqual(out(r.host), [
    { machine: null, pending: true },
    { cwd: '', machine: null, pending: true },
  ]);
  await r.unmount();
  function NoChat() {
    return h('i', { 'data-out': JSON.stringify(useChatMachine(null)) });
  }
  const none = await render(h(NoChat));
  assert.deepEqual(out(none.host), { machine: null, pending: false });
  await none.unmount();
});

test('the folder note says whether the machine is online or offline', async () => {
  let r = await render(h(MachineFolderNote, { machine: { id: 'b', name: 'box', away: false }, what: 'Files' }));
  assert.equal(r.host.textContent, "Files aren't shown for a folder on box.");
  await r.unmount();
  r = await render(h(MachineFolderNote, { machine: { id: 'b', name: 'box', away: true }, what: 'Files' }));
  assert.equal(r.host.textContent, "Files aren't available while box is offline.");
  await r.unmount();
});

test('the offline strip shows only for a chat whose machine is offline', async () => {
  chats = ON_BOX(BOX.id);
  machines = [BOX];
  const r = await render(h(HostAwayStrip, { threadId: 'chat' }));
  assert.equal(r.host.textContent, '', 'online: nothing');
  machines = [
    { ...BOX, status: 'offline', note: '', waitingForLogin: null, agents: [], installable: [], lastSeen: null, localNetwork: '' },
  ];
  await r.rerender(h(HostAwayStrip, { threadId: 'chat' }));
  assert.equal(r.host.textContent, 'box · OfflineCheck again', 'the machine row’s own line, with its one action');
  chats = LOCAL;
  await r.rerender(h(HostAwayStrip, { threadId: 'chat' }));
  assert.equal(r.host.textContent, '', 'this Mac: nothing');
  await r.unmount();
});

test('the strip says what the machine row says for each state that does not answer, and its action only where the row has one (audit chat:C21)', async () => {
  chats = ON_BOX(BOX.id);
  const away = {
    ...BOX,
    status: 'offline',
    note: '',
    waitingForLogin: null,
    agents: [],
    installable: [],
    lastSeen: null,
    localNetwork: '',
  };
  const words = async (over: object) => {
    machines = [{ ...away, ...over }];
    const r = await render(h(HostAwayStrip, { threadId: 'chat' }));
    const out = {
      text: r.host.querySelector('.fa-title')?.textContent,
      hint: r.host.querySelector('.fa-hint')?.textContent ?? null,
      button: r.host.querySelector('button')?.textContent ?? null,
    };
    await r.unmount();
    return out;
  };
  assert.deepEqual(await words({ waitingForLogin: 'locked', note: 'Disk is locked.' }), {
    text: 'box · Restarted · disk locked',
    hint: 'Disk is locked.',
    button: null,
  });
  assert.deepEqual(await words({ waitingForLogin: 'restarted', platform: 'linux' }), {
    text: 'box · Restarted · waiting for sign-in',
    hint: null,
    button: null,
  });
  const off = await words({ note: 'Unreachable: ssh: connect to host box port 22: Connection refused', platform: 'darwin' });
  assert.equal(off.text, 'box · Offline · Remote Login is off');
  assert.equal(off.hint, 'Turn it on: System Settings → General → Sharing → Remote Login.');
  assert.equal(off.button, 'Check again');
});

test('Check again asks the machines now, and a refusal is a toast, never a thrown error', async () => {
  chats = ON_BOX(BOX.id);
  machines = [
    { ...BOX, status: 'offline', note: '', waitingForLogin: null, agents: [], installable: [], lastSeen: null, localNetwork: '' },
  ];
  let asked = 0;
  let refuse = false;
  installNative(
    fakeNative({
      host: {
        check: async () => {
          asked++;
          if (refuse) throw new Error('no ssh');
        },
      },
    }),
  );
  const r = await render(h(HostAwayStrip, { threadId: 'chat' }));
  await act(async () => (one(r.host, 'button') as HTMLButtonElement).click());
  assert.equal(asked, 1);
  refuse = true;
  await act(async () => (one(r.host, 'button') as HTMLButtonElement).click());
  assert.equal(asked, 2);
  assert.equal(one(r.host, 'button').textContent, 'Check again', 'the button is back after a refusal');
  await r.unmount();
});

test('the permission chip of a chat on a machine is there and cannot be opened', async () => {
  const r = await render(h(HostModeChip, { machine: 'box' }));
  const chip = one(r.host, 'button') as HTMLButtonElement;
  assert.equal(chip.disabled, true);
  assert.equal(chip.textContent, 'Set on box');
  assert.equal(chip.getAttribute('aria-label'), 'Permissions are set on box');
  await r.unmount();
});

test('the folder the chat’s links read: none on this Mac, the machine’s, and an empty machine while it is not known', async () => {
  const seen: unknown[] = [];
  const Probe = () => (seen.push(useRemoteFolderValue('chat', '/srv/app')), null);
  let v = await render(h(Probe));
  await v.unmount();
  chats = ON_BOX(BOX.id);
  v = await render(h(Probe));
  await v.unmount();
  chats = { ...LOCAL, status: 'unknown' };
  v = await render(h(Probe));
  await v.unmount();
  assert.deepEqual(seen, [null, { machineId: BOX.id, folder: '/srv/app' }, { machineId: '', folder: '/srv/app' }]);
});

test("the folder a PR read goes by: this Mac's own, a machine's as a machine key, and none while unknown, offline or without a folder", async () => {
  let folder = '/srv/app';
  function PrProbe() {
    return h('i', { 'data-out': JSON.stringify(usePullRequestFolder('chat', folder)) });
  }
  const r = await render(h(PrProbe));
  assert.equal(out(r.host), '/srv/app');
  chats = { ...LOCAL, status: 'unknown' };
  await r.rerender(h(PrProbe));
  assert.equal(out(r.host), '');
  chats = ON_BOX(BOX.id);
  machines = [BOX];
  await r.rerender(h(PrProbe));
  assert.equal(out(r.host), `${BOX.id}\0/srv/app`);
  machines = [{ ...BOX, status: 'offline' }];
  await r.rerender(h(PrProbe));
  assert.equal(out(r.host), '');
  machines = [BOX];
  folder = '';
  await r.rerender(h(PrProbe));
  assert.equal(out(r.host), '');
  await r.unmount();
});

test('a machine whose Host is not running offers Start Host in the strip, and a failed start is a toast, never a thrown error', async () => {
  chats = ON_BOX(BOX.id);
  machines = [
    {
      ...BOX,
      status: 'offline',
      note: 'The machine answers over ssh, but its Host does not.',
      hostStopped: true,
      waitingForLogin: null,
      agents: [],
      installable: [],
      lastSeen: null,
      localNetwork: '',
    },
  ];
  const started: string[] = [];
  let refuse = false;
  installNative(
    fakeNative({
      host: {
        startHost: async (id: string) => {
          started.push(id);
          if (refuse) throw new Error('no ssh');
        },
      },
    }),
  );
  const r = await render(h(HostAwayStrip, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('.fa-title')?.textContent, 'box · Offline · Its Host isn’t running');
  const button = one(r.host, 'button') as HTMLButtonElement;
  assert.equal(button.textContent, 'Start Host');
  await act(async () => button.click());
  assert.deepEqual(started, [BOX.id]);
  refuse = true;
  await act(async () => (one(r.host, 'button') as HTMLButtonElement).click());
  assert.equal(started.length, 2);
  assert.equal((one(r.host, 'button') as HTMLButtonElement).textContent, 'Start Host', 'ready to try again');
  await r.unmount();
});
