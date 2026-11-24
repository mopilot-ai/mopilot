// Explicit approval, routing and lifetime of a Remote Run tool call to This Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick } from './support/host-wire-kit.ts';
import { fakeHost, setup } from './support/host/relayIpcKit.ts';

const require = createRequire(import.meta.url);
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { createHostDesktop } = require('../electron/capabilities/hostDesktop.cjs');

test('a Host chat can request a local Chrome read or desktop action, with approval on this Mac each time', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-this-mac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const machine = 'ssh:box';
  const chatId = 'acp:host-codex:chat';
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(chatId, { hostId: machine, ownerHostId: machine, epoch: 2 });
  const registry = new Registry();
  registry.setHostScope(() => ({ iab: true, bu: false, desktop: false }));
  const actions: string[] = [];
  const released: string[] = [];
  const desktop = createHostDesktop({
    ownerOf: () => machine,
    remoteFor: () => assert.fail('a local desktop action reached the Host'),
  });
  registry.register({ name: 'chrome_read_page', policy: 'observe', handler: () => (actions.push('Chrome'), 'Page read') });
  for (const tool of desktop.route([
    { name: 'desktop_open_application', policy: 'observe', handler: () => (actions.push('App'), 'Opened') },
    { name: 'desktop_app_click', policy: 'act', authorizesItself: true, handler: () => (actions.push('Desktop'), 'Clicked') },
  ]))
    registry.register(tool);
  const approvals: any[] = [];
  let allow: (answer: object) => void = () => assert.fail('no approval is pending');
  const opts = setup(
    {
      capabilities: registry,
      sessions: { get: () => ({ activeTurn: { id: 'turn' } }) },
      controller: { ref: () => ({ kind: 'acp:host-codex' }) },
      computerUse: {
        apps: { turnEnded: (chat: string) => released.push(chat) },
        broker: {
          ask: (id: string, kind: string, params: object) => {
            approvals.push({ id, kind, params });
            return new Promise((resolve) => (allow = resolve));
          },
        },
      },
    },
    dir,
    { [machine]: { name: 'box' } },
  );
  const { host, sent, events, states } = fakeHost();
  t.after(opts.onRemoteHost(machine, host));
  const announced = sent[0][1].tools.map((tool: any) => tool.name);
  assert.ok(announced.includes('this_mac_control'));
  assert.ok(!announced.includes('chrome_read_page'));
  assert.ok(!announced.includes('desktop_app_click'));

  const call = (callId: string, tool: string) => {
    for (const fn of events)
      fn({ event: 'tool', chatId, segmentId: 'seg', callId, name: 'this_mac_control', epoch: 2, arguments: { action: 'call', tool } });
  };
  call('read', 'chrome_read_page');
  await tick();
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].params.title, /Chrome on this Mac/i);
  assert.equal(approvals[0].params.macOnly, true);
  assert.deepEqual(actions, []);
  allow({ decision: 'deny' });
  await tick();
  assert.equal(sent.at(-1)[1].error?.code, 'denied');
  assert.deepEqual(actions, []);

  for (const [tool, expected] of [
    ['chrome_read_page', 'Page read'],
    ['desktop_open_application', 'Opened'],
    ['desktop_app_click', 'Clicked'],
  ]) {
    call(tool, tool);
    await tick();
    allow({ decision: 'allow', choice: 'once' });
    await tick();
    assert.deepEqual(sent.at(-1)[1].content, [{ type: 'text', text: expected }]);
  }
  assert.deepEqual(actions, ['Chrome', 'App', 'Desktop']);
  assert.equal(approvals.length, 4);
  for (const fn of states) fn('offline');
  assert.deepEqual(released, [chatId]);
  for (const fn of states) fn('online');
  call('next', 'desktop_app_click');
  await tick();
  allow({ decision: 'allow', choice: 'once' });
  await tick();
  registry.turns.retireTurn(chatId, 'some-other-thread');
  assert.deepEqual(released, [chatId]);
  registry.turns.retire(chatId);
  for (const fn of states) fn('offline');
  assert.deepEqual(released, [chatId, chatId], 'whole-turn retirement releases the apps once');
});

test('This Mac refuses unavailable tools and retires approvals on cancel, disconnect, turn end, and Host change', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-this-mac-lifetime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chatId = 'acp:host-claude:chat';
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const bind = (epoch: number) => store.set(chatId, { hostId: 'ssh:box', ownerHostId: 'ssh:box', epoch });
  bind(2);
  const registry = new Registry();
  let acts = 0;
  let pendingRead: Promise<string> | null = null;
  const handler = () => (acts++, pendingRead ?? acts);
  registry.register({ name: 'chrome_navigate', policy: 'act', authorizesItself: true, handler });
  registry.register({ name: 'chrome_browser_batch', policy: 'act', handler });
  registry.register({ name: 'desktop_request_access', policy: 'observe', handler });
  registry.register({ name: 'desktop_app_key', policy: 'act', handler });
  let finishBrowser: (result: string) => void = () => assert.fail('no Host browser call is pending');
  registry.register({
    name: 'browser_read_page',
    policy: 'observe',
    handler: () => new Promise<string>((finish) => (finishBrowser = finish)),
  });
  let separate = false;
  registry.setChatScope(
    () => false,
    () => separate,
  );
  let turn: string | null = 'turn1';
  const cards: { details: string[]; answer: (answer: any) => void; signal: AbortSignal }[] = [];
  let mirror = Promise.resolve();
  let brokerFailure: Error | null = null;
  const live = {
    capabilities: registry,
    sessions: { get: () => ({ activeTurn: turn ? { id: turn } : null }) },
    computerUse: {
      broker: {
        ask: (_chat: string, _kind: string, params: { details: string[] }, { signal }: { signal: AbortSignal }) => {
          if (brokerFailure) return Promise.reject(brokerFailure);
          return new Promise((answer) => cards.push({ ...params, answer, signal }));
        },
      },
    },
    remoteChats: () => ({ settled: () => mirror }),
  };
  const opts = setup(live, dir);
  // The app's Host IPC register normally installs the real remote chat mirror.
  live.remoteChats = () => ({ settled: () => mirror });
  const { host, events, sent, states } = fakeHost();
  t.after(opts.onRemoteHost('ssh:box', host));
  const call = (input: object, epoch = 2, callId = crypto.randomUUID()) => {
    for (const fn of events) fn({ event: 'tool', chatId, segmentId: 'seg', callId, name: 'this_mac_control', epoch, arguments: input });
    return callId;
  };
  const last = () => sent.at(-1)[1];
  const run = {
    action: 'call',
    tool: 'chrome_navigate',
    arguments: { url: 'https://secret:password@example.test/page?token=secret', tabId: 17, ref: 'ref1', app: {} },
  };
  call({ action: 'list' });
  await tick();
  assert.deepEqual(
    JSON.parse(last().content[0].text).tools.map((tool: any) => tool.name),
    ['chrome_navigate', 'desktop_request_access', 'desktop_app_key'],
  );
  separate = true;
  call({ action: 'list' });
  await tick();
  assert.equal(last().error.code, 'unavailable');
  separate = false;
  for (const [input, epoch, error] of [
    [run, 1, 'unavailable'],
    [{ action: 'call', tool: 'chrome_browser_batch' }, 2, 'unavailable'],
    [{ action: 'unknown' }, 2, 'unavailable'],
    [{ action: 'call', tool: 42 }, 2, 'unavailable'],
    [{ ...run, arguments: [] }, 2, 'bad_args'],
    [{ ...run, arguments: true }, 2, 'bad_args'],
    [{ action: 'call', tool: 'desktop_request_access', arguments: { screenControl: true } }, 2, 'bad_args'],
  ] as const) {
    call(input, epoch);
    await tick();
    assert.equal(last().error.code, error);
  }
  assert.equal(cards.length, 0);
  turn = null;
  call(run);
  await tick();
  assert.equal(last().error.code, 'stale_turn');
  turn = 'turn1';

  const allow = { decision: 'allow', choice: 'once' };
  for (const [retire, error] of [
    [() => (turn = 'turn2'), 'stale_turn'],
    [() => bind(3), 'unavailable'],
  ] as const) {
    call(run);
    await tick();
    assert.deepEqual(cards.at(-1)?.details, ['chrome_navigate', 'url: https://example.test', 'tabId: 17', 'ref: ref1']);
    retire();
    cards.at(-1)!.answer(allow);
    await tick();
    assert.equal(last().error.code, error);
  }
  for (const cancel of [
    (callId: string) => {
      for (const fn of events) fn({ event: 'toolCancel', chatId, callId, epoch: 3 });
    },
    () => {
      for (const fn of states) fn('offline');
    },
  ]) {
    const callId = call(run, 3);
    await tick();
    cancel(callId);
    const card = cards.at(-1)!;
    assert.equal(card.signal.aborted, true);
    const answers = sent.length;
    card.answer(allow);
    await tick();
    assert.equal(sent.length, answers);
  }
  assert.equal(acts, 0);

  for (const fn of states) fn('online');
  const hostCallId = 'host-browser';
  for (const fn of events) fn({ event: 'tool', chatId, segmentId: 'seg', callId: hostCallId, name: 'browser_read_page', epoch: 3 });
  const cancelled = call(run, 3);
  await tick();
  for (const fn of events) fn({ event: 'toolCancel', chatId, callId: cancelled, epoch: 3 });
  assert.ok(cards.at(-1)?.signal.aborted);
  cards.at(-1)!.answer(allow);
  finishBrowser('Host page');
  await tick();
  assert.equal(last().callId, hostCallId);
  assert.deepEqual(last().content, [{ type: 'text', text: 'Host page' }]);
  assert.equal(acts, 0);

  for (const answer of [null, { decision: 'allow', choice: 'always' }, allow]) {
    call(run, 3);
    await tick();
    cards.at(-1)!.answer(answer);
    await tick();
    assert.equal(last().ok, answer === allow);
  }
  assert.equal(acts, 1);

  call(
    {
      action: 'call',
      tool: 'desktop_request_access',
      arguments: { apps: ['Notes', 'Preview'], coordinate: [10, 20], start_coordinate: [0, 0] },
    },
    3,
  );
  await tick();
  assert.deepEqual(cards.at(-1)?.details, [
    'desktop_request_access',
    'coordinate: 10, 20',
    'start_coordinate: 0, 0',
    'apps: Notes, Preview',
  ]);
  cards.at(-1)!.answer({ decision: 'deny' });
  await tick();
  const apps = ['Notes', 'Preview', 'Calendar', 'Reminders', 'Maps', 'Mail', 'Photos', 'TextEdit', 'Finder'];
  for (const [tool, args, details] of [
    ['desktop_app_key', { app: 'Notes', combo: 'cmd+a' }, ['app: Notes', 'combo: cmd+a']],
    ['desktop_request_access', { apps }, [`apps: ${apps.slice(0, 8).join(', ')} (+1 more)`]],
    ['chrome_navigate', { url: 'ftp://example.test/file' }, []],
    ['chrome_navigate', { url: 'a.test/page#private' }, ['url: https://a.test']],
  ] as const) {
    call({ action: 'call', tool, arguments: args }, 3);
    await tick();
    assert.deepEqual(cards.at(-1)?.details, [tool, ...details]);
    cards.at(-1)!.answer({ decision: 'deny' });
    await tick();
  }

  // The Host could send the first call in the same batch as the turn-start frame.
  turn = null;
  let applyStart: () => void = () => assert.fail('no turn start is pending');
  mirror = new Promise((resolve) => {
    applyStart = () => {
      turn = 'turn3';
      resolve();
    };
  });
  const approvals = cards.length;
  const rapid = call({ ...run, arguments: { url: 'back' } }, 3);
  await tick();
  assert.notEqual(last().callId, rapid, 'the call should wait for the queued start');
  assert.equal(cards.length, approvals);
  applyStart();
  await tick();
  assert.deepEqual(cards.at(-1)?.details, ['chrome_navigate', 'url: back']);

  // The answer can likewise race a queued turn end. It must not resume the retired call.
  let applyEnd: () => void = () => assert.fail('no turn end is pending');
  mirror = new Promise((resolve) => {
    applyEnd = () => {
      turn = null;
      resolve();
    };
  });
  cards.at(-1)!.answer(allow);
  await tick();
  assert.notEqual(last().callId, rapid, 'the approval should wait for the queued end');
  assert.equal(acts, 1);
  applyEnd();
  await tick();
  assert.equal(last().callId, rapid);
  assert.equal(last().error.code, 'stale_turn');
  assert.equal(acts, 1);

  turn = 'turn4';
  const otherHostCallId = 'other-host-browser';
  for (const fn of events) fn({ event: 'tool', chatId, segmentId: 'seg', callId: otherHostCallId, name: 'browser_read_page', epoch: 3 });
  await tick();
  for (const fn of events) fn({ event: 'toolCancel', chatId, callId: otherHostCallId, epoch: 3 });
  assert.equal(registry.running.has(chatId), false, 'a canceled Host tool still ends the Host browser work');

  brokerFailure = new Error('mock broker transport failure');
  call(run, 3);
  await tick();
  assert.deepEqual(last().error, { code: 'failed', message: 'MoPilot could not run this action on this Mac.' });

  brokerFailure = null;
  let finishRead: (value: string) => void = () => assert.fail('no result is pending');
  pendingRead = new Promise((resolve) => (finishRead = resolve));
  const late = call(run, 3);
  await tick();
  cards.at(-1)!.answer(allow);
  await tick();
  assert.equal(acts, 2);
  turn = 'turn5';
  finishRead('private content');
  await tick();
  assert.equal(last().callId, late);
  assert.equal(last().ok, false);
  assert.deepEqual(last().content, []);
});
