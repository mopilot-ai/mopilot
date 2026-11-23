// MoMo's page lists the machines (P7, #4947): this Mac and its Hosts as Settings › Computers words them, the cards waiting on each, Check again and Add a computer; a machine opens its page and the pairing flow starts, both leaving MoMo; without the entry points the section is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useEffect, useState } from 'react';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { momoRuntime, snapshotOf } from './support/phone/momo-kit';
import { fakeDraft } from './support/phone/drafts';

const sectionPath = '../mobile/src/screens/MomoComputers';
const routePath = '../mobile/src/remote/useSettingsRoute';
const momoPath = '../mobile/src/screens/Momo';
const linkPath = '../mobile/src/macLink';
const { MomoComputers, checkedWord, computerLine, recheck } = await import(sectionPath);
const { momoComputers } = await import(routePath);
const { Momo } = await import(momoPath);
const { MacLinkProvider } = await import(linkPath);

const machine = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  status: 'online',
  line: 'Online',
  tone: 'ok',
  keepRunning: null,
  agents: [],
  ...over,
});
const MACHINES = [
  machine('local', 'This Mac', { line: 'Connected', keepRunning: true }),
  machine('h1', 'Studio', { line: 'Online · Claude Code', keepRunning: true, waiting: 1 }),
  machine('h2', 'Build box', { line: 'Offline', tone: 'off', status: 'offline', waiting: 3 }),
  machine('h3', 'Quiet box'),
];

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a machine row says its state, that it keeps running with the Mac away (a Host only), and how many cards wait on it', () => {
  assert.equal(computerLine(MACHINES[0]), 'Connected', 'this Mac: its own line only');
  assert.equal(computerLine(MACHINES[1]), 'Online · Claude Code · Keeps running while your Mac is away');
  assert.equal(computerLine(MACHINES[3]), 'Online');
  assert.match(checkedWord(Date.UTC(2026, 10, 17, 15, 5)), /^Checked at \d{1,2}:05/);
});

test('the section lists this Mac without a page and each Host with its page; the waiting count reads right; a Host opens and Add a computer starts pairing', async () => {
  const opened: string[] = [];
  let paired = 0;
  const v = await mount(
    createElement(MomoComputers, {
      machines: MACHINES,
      open: (id: string) => opened.push(id),
      pair: () => void paired++,
      check: async () => undefined,
    }),
  );
  const text = v.host.textContent!;
  assert.match(text, /Computers/);
  assert.match(text, /This Mac.*Connected/s);
  assert.match(text, /Studio.*1 needs input/s, 'one card waiting');
  assert.match(text, /Build box.*3 need input/s, 'several');
  assert.doesNotMatch(text.split('Quiet box')[1] ?? '', /need/, 'a machine with nothing waiting says nothing');
  await assert.rejects(click('This Mac'), /button This Mac/, 'this Mac has no page here');
  await click('Studio');
  await click('Add a computer');
  assert.deepEqual([opened, paired], [['h1'], 1]);
  await v.done();
});

test('Check again re-reads the machines once at a time, then says when; a failure says why and can be tried again', async () => {
  let calls = 0;
  let release!: () => void;
  let fail = true;
  const check = () => {
    calls++;
    if (calls === 2 && fail) return Promise.reject(new Error('The Hosts did not answer.'));
    return calls === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  };
  const v = await mount(
    createElement(MomoComputers, { machines: MACHINES, open: () => {}, pair: () => {}, check, now: () => Date.UTC(2026, 10, 17, 15, 5) }),
  );
  await click('Check again');
  assert.match(v.host.textContent!, /Checking…/);
  await assert.rejects(click('Checking…'), /button Checking/, 'a second press while it runs is not offered');
  await act(async () => release());
  await flush();
  assert.match(v.host.textContent!, /Check again.*Checked at \d{1,2}:05/s);
  fail = true;
  await click('Check again');
  assert.match(v.host.textContent!, /The Hosts did not answer\./);
  assert.doesNotMatch(v.host.textContent!, /Checking…/);
  fail = false;
  await click('Check again');
  assert.equal(calls, 3);
  assert.doesNotMatch(v.host.textContent!, /did not answer/, 'a new try clears the old failure');
  await v.done();
});

test('Check again reads the phone’s own paths to the Hosts when it has them, and finishes when it has none', async () => {
  const probed: string[] = [];
  await recheck({ direct: { probe: async () => void probed.push('probe') } });
  await recheck({});
  assert.deepEqual(probed, ['probe']);
});

test('leaving MoMo for a machine or for pairing closes MoMo first', () => {
  const log: string[] = [];
  const route = momoComputers(
    (open: null) => log.push(`momo ${open}`),
    (id: string) => log.push(`machine ${id}`),
    (on: boolean) => log.push(`pairing ${on}`),
  );
  route.open('h1');
  route.pair();
  assert.deepEqual(log, ['momo null', 'machine h1', 'momo null', 'pairing true']);
});

async function mountMomoWithMachines(extra: Record<string, unknown>) {
  const m = momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: { momo: true, machines: true, methods: ['momo.state.get'], permissionCeiling: 'auto-review' },
    }),
    'machines.list': () => ({ machines: MACHINES }),
    'momo.chat.follow': () => snapshotOf([]),
    'momo.chat.unfollow': () => ({}),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0 }),
  });
  function Harness() {
    const [snap, setSnap] = useState(m.runtime.snapshot());
    useEffect(() => m.runtime.subscribe(() => setSnap(m.runtime.snapshot())), []);
    return createElement(
      MacLinkProvider,
      { state: snap, runtime: m.runtime },
      createElement(Momo, {
        runtime: m.runtime,
        state: snap,
        back: () => {},
        drafts: fakeDraft(''),
        ...extra,
      }),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await flush();
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('MoMo’s page shows the section only when the app gives it the entry points and there are machines; Check again probes the phone’s own paths', async () => {
  const probed: string[] = [];
  const runtimeWithoutDirect = await mountMomoWithMachines({});
  await click('Mo, MoMo’s page');
  assert.doesNotMatch(runtimeWithoutDirect.host.textContent!, /Add a computer/, 'no entry points: no section');
  await runtimeWithoutDirect.done();
  const opened: string[] = [];
  const v = await mountMomoWithMachines({ computers: { open: (id: string) => opened.push(id), pair: () => probed.push('pair') } });
  await click('Mo, MoMo’s page');
  assert.match(v.host.textContent!, /Computers/);
  assert.match(v.host.textContent!, /Studio/);
  await click('Studio');
  assert.deepEqual(opened, ['h1']);
  await click('Check again');
  assert.match(v.host.textContent!, /Checked at/, 'a phone with no direct paths has nothing to probe and the check still finishes');
  await v.done();
});
