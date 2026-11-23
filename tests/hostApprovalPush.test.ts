// A Host chat's approval while this Mac is online, end to end through the real parts: the Host's stream (electron/host/remoteChats.cjs) → the controller's needs-you state → the Notifier → a push per paired phone (electron/remote/pushBridge.cjs), on every family; and the answer from a phone or the side panel (electron/app/chromePanel.cjs) reaches the Host, as the window's does.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeItems, createRemoteChats, fakeHost } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushBridge } = require('../electron/remote/pushBridge.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-host-push-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const settle = () => new Promise((r) => setImmediate(r));

/** The Mac with one chat that runs on machine m1, a paired phone, and the side panel's answer route (the one a phone's card.answer takes). */
function mac(chatId: string, kind: string) {
  const records = new Map([[chatId, { id: chatId, segments: [{ kind, nativeId: chatId }], meta: {} }]]);
  const state = new SessionStore();
  const pushes: any[] = [];
  const shown: any[] = [];
  const closed: string[] = [];
  const bridge = createPushBridge({
    remote: () => ({
      devices: { list: () => [{ pairId: 'phone-1' }] },
      pushRequest: (r: any) => (pushes.push(r), Promise.resolve('sent')),
    }),
  });
  const notifier = new Notifier({
    getMode: () => 'always',
    show: (m: any) => (shown.push(m), { close: () => closed.push(m.title) }),
    onBanner: bridge.onBanner,
  });
  const controller = new ChatController({
    state,
    chats: { record: (id: string) => records.get(id), records },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    notify: (k: string, id: string, o: any) => notifier.notify(k, id, o),
    retract: (id: string) => notifier.retract(id),
  });
  state.patch(chatId, { turn: 'running' });
  const host = fakeHost();
  const local: any[] = [];
  const chats = createRemoteChats({
    items: new FakeItems(),
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: any) => controller.onAcpEvent(e),
    report: (e: Error) => assert.fail(e),
  });
  const live: any = {
    chats: { records },
    controller,
    remoteChats: () => chats,
    acpAdmission: { list: () => [{ id: 'kimi', label: 'Kimi' }], admitted: () => true },
    peerRuntime: {
      readReference: async () => ({ turns: [], earlierContentOmitted: false }),
      readHistory: async () => ({ turns: [], earlierContentOmitted: false }),
    },
    acpHost: { permission: (id: string, o: unknown) => (local.push([id, o]), true) },
    codex: { chatName: () => null },
  };
  const panel = createChromePanel({
    live,
    claude: {},
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({}),
    usable: async () => true,
    starter: { prefs: () => ({}), chats: { patchMeta: () => undefined }, started: () => undefined },
    send: async () => undefined,
    open: () => undefined,
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  return { controller, state, chats, host, pushes, shown, closed, local, ask };
}

const card = (family: string, requestId: string) => ({
  t: 'event',
  family,
  event: {
    kind: 'permission',
    requestId,
    turnId: 't1',
    toolCall: { title: 'Run make' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  },
});

for (const [family, chatId, kind] of [
  ['acp', 'acp:kimi:h1', 'acp:kimi'],
  ['codex', 'host-codex-1', 'codex'],
  ['claude', 'host-claude-1', 'claude'],
] as const)
  test(`${family}: a Host chat's approval needs the user here and pushes "needs you" to the phone; the phone's answer reaches the Host and clears it`, async () => {
    const m = mac(chatId, kind);
    m.chats.follow(chatId);
    await m.chats.settled(chatId);
    m.host.fire.patch(chatId, 1, card(family, 'p1'));
    await m.chats.settled(chatId);
    // needs you: the card is in the chat's state, the Mac shows its banner, and the paired phone gets one push with an opaque ref
    assert.deepEqual(
      m.state.get(chatId).approvals.map((a: any) => a.id),
      [`${chatId}|p1`],
    );
    assert.equal(m.shown.length, 1);
    assert.deepEqual(
      m.pushes.map((p) => [p.pair, p.kind]),
      [['phone-1', 'needsYou']],
    );
    assert.ok(!m.pushes[0].ref.includes(chatId));
    // the phone answers through the side panel's route (card.answer → ops.answer)
    const answers: any[] = [];
    m.host.answer = async (p: any) => (answers.push(p), { answered: true });
    const cards = (await m.ask('read', { chatId })).result.approvals;
    const res = await m.ask('answer', { chatId, approvalId: `${chatId}|p1`, choice: 'o0', version: cards[0].version });
    assert.deepEqual(res.result, { answered: true });
    assert.deepEqual(answers, [{ chatId, requestId: 'p1', optionId: 'yes' }]);
    assert.deepEqual(m.local, []);
    // answered: no card, the Mac's banner withdrawn
    assert.deepEqual(m.state.get(chatId).approvals, []);
    assert.equal(m.closed.length, 1);
    // the Host's record that closes the card changes nothing more, and no second push went
    m.host.fire.patch(chatId, 2, { t: 'event', family, event: { kind: 'permissionCancelled', requestId: 'p1' } });
    await m.chats.settled(chatId);
    assert.equal(m.pushes.length, 1);
  });

test('an answer the Host cannot take keeps the card (and its needs-you) to answer again; a card the Host no longer had leaves', async () => {
  const chatId = 'acp:kimi:h2';
  const m = mac(chatId, 'acp:kimi');
  m.chats.follow(chatId);
  await m.chats.settled(chatId);
  m.host.fire.patch(chatId, 1, card('acp', 'p1'));
  await m.chats.settled(chatId);
  m.host.answer = async () => {
    throw new Error('Can’t reach the machine.');
  };
  const [c] = (await m.ask('read', { chatId })).result.approvals;
  const failed = await m.ask('answer', { chatId, approvalId: `${chatId}|p1`, choice: 'deny', version: c.version });
  assert.match(String(failed.error?.message ?? failed.error), /reach the machine/);
  assert.deepEqual(
    m.state.get(chatId).approvals.map((a: any) => a.id),
    [`${chatId}|p1`],
  );
  assert.equal(m.closed.length, 0);
  // back online, but the Host had closed the card meanwhile: it leaves here too
  m.host.answer = async () => ({ answered: false });
  const [again] = (await m.ask('read', { chatId })).result.approvals;
  const stale = await m.ask('answer', { chatId, approvalId: `${chatId}|p1`, choice: 'deny', version: again.version });
  // the panel says the card was answered already
  assert.equal(stale.result, undefined);
  assert.ok(stale.error);
  assert.deepEqual(m.state.get(chatId).approvals, []);
  await settle();
});

test("this Mac's own ACP card is still answered by the local ACP host", async () => {
  const m = mac('acp:kimi:local', 'acp:kimi');
  m.controller.onAcpEvent({ ...card('acp', 'l1').event, key: 'acp:kimi:local' });
  const [c] = (await m.ask('read', { chatId: 'acp:kimi:local' })).result.approvals;
  const res = await m.ask('answer', { chatId: 'acp:kimi:local', approvalId: 'l1', choice: 'o0', version: c.version });
  assert.deepEqual(res.result, { answered: true });
  assert.deepEqual(m.local, [['l1', 'yes']]);
  assert.deepEqual(m.state.get('acp:kimi:local').approvals, []);
  // a Deny the agent offers no reject for is sent as dismissed (no option)
  m.controller.onAcpEvent({
    ...card('acp', 'l2').event,
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    key: 'acp:kimi:local',
  });
  const [d] = (await m.ask('read', { chatId: 'acp:kimi:local' })).result.approvals;
  await m.ask('answer', { chatId: 'acp:kimi:local', approvalId: 'l2', choice: 'deny', version: d.version });
  assert.deepEqual(m.local.at(-1), ['l2', null]);
});
