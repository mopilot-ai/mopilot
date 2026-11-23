// The draft card's Send in main (electron/app/momoDraftSend.cjs) and the fake mail accounts behind it: three IPC calls refused while MoMo is not allowed, the words coerced before the sender sees them, every change of a note's send broadcast, and the fake accounts keeping mail in memory and failing on request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerDraftSendIpc, openMomoDraftSend, CHANNELS, NOT_ALLOWED } = require('../electron/app/momoDraftSend.cjs');
const { fakeMailConnector, ACCOUNTS } = require('../electron/momo/connectors/fakeMail.cjs');
const { ConnectorError } = require('../electron/momo/connectors/hub.cjs');
const { connectorAudit } = require('../electron/momo/sourceTrust.cjs');

function ipc() {
  const handlers = new Map<string, (...a: any[]) => any>();
  return {
    handlers,
    ipcMain: { handle: (c: string, fn: any) => void handlers.set(c, fn), removeHandler: (c: string) => void handlers.delete(c) },
    call: (c: string, input?: any) => handlers.get(c)!({}, input),
  };
}

test('the three calls are refused while MoMo is not allowed, and route to the sender while it is', async () => {
  const i = ipc();
  const gate = { allowed: false };
  const seen: any[] = [];
  const sender = {
    accounts: () => [{ id: 'm' }],
    state: (...a: any[]) => (seen.push(['state', ...a]), null),
    send: async (o: any) => (seen.push(['send', o]), { ok: true }),
  };
  const off = registerDraftSendIpc(i.ipcMain, { sender: sender as any, allowed: () => gate.allowed });
  assert.deepEqual([...i.handlers.keys()], [...CHANNELS]);
  for (const c of CHANNELS) assert.deepEqual(await i.call(c, {}), NOT_ALLOWED, c);
  assert.deepEqual(seen, []);
  gate.allowed = true;
  assert.deepEqual(await i.call('momoDraft:accounts'), { ok: true, accounts: [{ id: 'm' }] });
  assert.deepEqual(await i.call('momoDraft:state', { chatId: 'c', noteId: 'n' }), { ok: true, send: null });
  assert.deepEqual(await i.call('momoDraft:state'), { ok: true, send: null });
  await i.call('momoDraft:send', {
    chatId: 'c',
    noteId: 'n',
    from: 'm',
    to: ['a@b.co'],
    subject: 's',
    body: 'b',
    url: 'https://x.example',
    tool: 'x',
  });
  await i.call('momoDraft:send', { chatId: 5, noteId: {}, from: null });
  await i.call('momoDraft:send');
  assert.deepEqual(seen, [
    ['state', 'c', 'n'],
    ['state', '', ''],
    ['send', { chatId: 'c', noteId: 'n', from: 'm', words: { to: ['a@b.co'], subject: 's', body: 'b' } }],
    ['send', { chatId: '', noteId: '', from: '', words: { to: undefined, subject: undefined, body: undefined } }],
    ['send', { chatId: '', noteId: '', from: '', words: { to: undefined, subject: undefined, body: undefined } }],
  ]);
  off();
  assert.equal(i.handlers.size, 0);
});

test('main builds the sender over the hub and the chat store, settles stopped sends at start and broadcasts every change', async () => {
  const i = ipc();
  const sent: any[] = [];
  const notes = [
    {
      id: 'd1',
      kind: 'draft',
      draft: { to: ['a@b.co'], subject: '', body: 'hi' },
      send: { state: 'asked', from: { id: 'm', label: 'M', account: '' }, at: 1 },
    },
  ];
  const chat = { meta: { notes } };
  const live: any = {
    chats: {
      records: new Map([['c', chat]]),
      record: (id: string) => (id === 'c' ? chat : undefined),
      patchMeta: (_id: string, patch: any) => (Object.assign(chat.meta, patch), true),
      get: (id: string) => ({ id, meta: chat.meta }),
    },
  };
  const hub = { list: () => [], call: async () => ({}) };
  const { sender, off } = openMomoDraftSend({
    ipcMain: i.ipcMain,
    hub,
    live,
    broadcastAll: (channel: string, payload: any) =>
      void sent.push([channel, payload.chatId ?? payload.id, payload.noteId ?? null, payload.send?.state ?? null]),
    allowed: () => true,
    isMomoChat: () => true,
  });
  // the send the app stopped on was settled before anything is asked
  assert.deepEqual(sent, [
    ['momoDraft:state', 'c', 'd1', 'unsure'],
    ['chats:changed', 'c', null, null],
  ]);
  assert.equal(sender.state('c', 'd1')?.state, 'unsure');
  assert.deepEqual([...i.handlers.keys()], [...CHANNELS]);
  off();
  assert.equal(i.handlers.size, 0);
  // a store with no records to list settles nothing
  const bare = openMomoDraftSend({
    ipcMain: ipc().ipcMain,
    hub,
    live: { chats: { record: () => undefined, patchMeta: () => false, get: () => null } },
    broadcastAll: () => undefined,
    allowed: () => true,
    isMomoChat: () => true,
  });
  assert.equal(bare.sender.settle(), 0);
  const none = openMomoDraftSend({
    ipcMain: ipc().ipcMain,
    hub,
    live: {},
    broadcastAll: () => undefined,
    allowed: () => true,
    isMomoChat: () => true,
  });
  assert.equal(none.sender.settle(), 0);
});

test('a fake mail account keeps the mail in memory, names its send for the card, and fails once on request', async () => {
  const sent: any[] = [];
  const mail = fakeMailConnector(ACCOUNTS[1], { now: () => 9, sent });
  const tool = mail.tools.send_mail;
  assert.equal(mail.id, 'test-mail-work');
  assert.deepEqual(mail.scopes, ['mail.send']);
  assert.equal(tool.summary({ subject: 'Hi' }), 'Send “Hi” from work@mail.test');
  assert.equal(tool.summary(undefined), 'Send “No subject” from work@mail.test');
  assert.deepEqual(await tool.run({ to: ['a@b.co'], subject: 'Hi', body: 'x' }, { accessToken: 't', signal: null }), { sent: true });
  await tool.run(undefined, { accessToken: 't', signal: null });
  assert.deepEqual(sent, [
    { from: 'work@mail.test', to: ['a@b.co'], subject: 'Hi', body: 'x', at: 9 },
    { from: 'work@mail.test', to: [], subject: '', body: '', at: 9 },
  ]);
  mail.failNext();
  await assert.rejects(tool.run({}, { accessToken: 't', signal: null }), /test provider refused/);
  const own = new Error('mine');
  mail.failNext(own);
  await assert.rejects(tool.run({}, { accessToken: 't', signal: null }), own);
  // it fails once only
  assert.deepEqual(await tool.run({}, { accessToken: 't', signal: null }), { sent: true });
  // a default clock and list work too
  const plain = fakeMailConnector(ACCOUNTS[0]);
  await plain.tools.send_mail.run({ to: ['a@b.co'] }, { accessToken: 't', signal: null });
  // the sign-in's own token endpoint is in-process
  const issued = await plain.flow.exchangeCode();
  assert.deepEqual(issued.scopes, ['mail.send']);
  assert.match(issued.accessToken, /^test-/);
});

test('a refusal carries its own word, and only a refusal does', () => {
  assert.equal(new ConnectorError('x', 'refused', 'paused').reason, 'paused');
  assert.equal('reason' in new ConnectorError('x', 'failed'), false);
});

test('the audit log records a send the person pressed as user-pressed, with the draft id, and a refused press as a refusal', async () => {
  const log: any[] = [];
  const audit = {
    refusal: async (f: any) => void log.push(['refusal', f.decision, f.args]),
    intent: async (f: any) => (log.push(['intent', f.decision, f.args]), { id: 'e1' }),
    outcome: async (id: string, o: any) => void log.push(['outcome', id, o]),
  };
  const a = connectorAudit(audit);
  const base = { connector: 'm', tool: 'send_mail', chatId: 'c', args: { to: ['a@b.co'] } };
  await a.append({ ...base, decision: 'allowed', via: 'user-pressed', draft: 'd1', result: 'done' });
  await a.append({ ...base, decision: 'press-mismatch', draft: 'd1' });
  await a.append({ ...base, decision: 'allowed', result: 'done' });
  assert.deepEqual(log[0], ['intent', 'allowed:user-pressed', { action: 'send_mail', args: base.args, draft: 'd1' }]);
  assert.deepEqual(log[2], ['refusal', 'press-mismatch', { action: 'send_mail', args: base.args, draft: 'd1' }]);
  assert.deepEqual(log[3], ['intent', 'allowed', { action: 'send_mail', args: base.args }]);
});
