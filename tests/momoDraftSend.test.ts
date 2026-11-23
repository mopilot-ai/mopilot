// Sending a MoMo draft from its card (electron/momo/draftSend.cjs, shared/momoDraftSend.mjs): the mail accounts the chooser lists, a send as the note keeps it (asked, chosen, sent) through the real connector hub and a trust layer that can say no, the stops (not allowed, a double click, a second send, no recipient, no account, paused, read only, denied, a provider failure, a disconnect), and a send the app stopped on read back as unsure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connectorWorld } from './support/momoConnectorWorld.ts';

const require = createRequire(import.meta.url);
const { createDraftSender } = require('../electron/momo/draftSend.cjs');
const { fakeMailConnector, ACCOUNTS } = require('../electron/momo/connectors/fakeMail.cjs');
const { ConnectorError } = require('../electron/momo/connectors/hub.cjs');
const { readSend, sendLines, fromName, isOpen, STATES, WHY, SEND_TOOL } = await import('../shared/momoDraftSend.mjs');

const WORDS = { to: ['sam@example.com', 'lee@example.com'], subject: 'Re: lunch', body: 'Friday works.' };
const HOME = ACCOUNTS[0];
const WORK = ACCOUNTS[1];

/** A hub with the two fake mail accounts (home connected), a MoMo chat holding one draft note, and the sender over them. */
async function rig(o: { decide?: (call: any) => Promise<any>; connect?: string[]; patch?: (n: number) => boolean } = {}) {
  const w = connectorWorld({ decide: o.decide });
  const sent: any[] = [];
  const mail: Record<string, any> = {};
  for (const who of ACCOUNTS) {
    mail[who.id] = fakeMailConnector(who, { now: () => 5, sent });
    w.hub.register(mail[who.id]);
  }
  for (const id of o.connect ?? [HOME.id]) {
    // the work account has no address of its own to show: the chooser names it by its label
    const p = w.hub.connect(id, id === HOME.id ? { account: HOME.account } : {});
    await w.approve();
    await p;
  }
  const records = new Map<string, any>([
    [
      'momo-main',
      {
        meta: {
          momo: 'main',
          notes: [
            { id: 'other', kind: 'nudge' },
            { id: 'd1', kind: 'draft', text: 'Draft · Re: lunch', draft: { ...WORDS } },
          ],
        },
      },
    ],
    ['coding', { meta: { notes: [{ id: 'd1', kind: 'draft', draft: WORDS }] } }],
  ]);
  const events: any[] = [];
  const gate = { allowed: true, patches: 0 };
  const sender = createDraftSender({
    hub: w.hub,
    chats: {
      record: (id: string) => records.get(id),
      patchMeta: (id: string, patch: any) => {
        gate.patches++;
        if (o.patch && !o.patch(gate.patches)) return false;
        Object.assign(records.get(id).meta, patch);
        return true;
      },
    },
    records: () => records.entries(),
    allowed: () => w.s.allowed && gate.allowed,
    isMomoChat: (id: string) => id === 'momo-main',
    changed: (chatId: string, noteId: string, send: any) => void events.push([chatId, noteId, send?.state ?? null]),
    now: () => 77,
  });
  const note = () => records.get('momo-main').meta.notes.find((n: any) => n.id === 'd1');
  const send = (over: any = {}) => sender.send({ chatId: 'momo-main', noteId: 'd1', from: HOME.id, words: WORDS, ...over });
  return { w, sent, mail, records, events, gate, sender, note, send };
}

test('the shared words: a send is read back checked, its lines grow, and an open card is one with no send', () => {
  const good = { state: 'sent' as const, from: { id: 'a', label: 'Mail A', account: 'a@mail.test' }, at: 3 };
  assert.deepEqual(readSend(good), good);
  assert.equal(readSend({ ...good, from: { id: 'a' } })?.from.account, '');
  for (const bad of [
    null,
    [],
    'x',
    {},
    { ...good, state: 'later' },
    { ...good, at: 'now' },
    { ...good, at: NaN },
    { ...good, from: null },
    { ...good, from: { id: '' } },
  ])
    assert.equal(readSend(bad), null, JSON.stringify(bad));
  assert.deepEqual(sendLines(null), []);
  assert.deepEqual(sendLines({ ...good, state: 'asked' }), ['asked']);
  assert.deepEqual(sendLines({ ...good, state: 'chose' }), ['asked', 'chose']);
  assert.deepEqual(sendLines(good), ['asked', 'chose', 'sent']);
  assert.deepEqual(sendLines({ ...good, state: 'unsure' }), ['unsure']);
  assert.equal(fromName(good.from), 'a@mail.test');
  assert.equal(fromName({ id: 'a', label: 'Mail A', account: '' }), 'Mail A');
  assert.equal(fromName({ id: 'a', label: '', account: '' }), 'a');
  assert.ok(isOpen(null) && !isOpen(good));
  assert.equal(SEND_TOOL, 'send_mail');
  assert.equal(Object.keys(STATES).length, 4);
  assert.ok(Object.values(WHY).includes('busy'));
});

test('the chooser lists the connected mail accounts, with why one can not send now; none while MoMo is off', async () => {
  const r = await rig({ connect: [HOME.id, WORK.id] });
  assert.deepEqual(
    r.sender.accounts().map((a: any) => [a.id, a.account, a.ok, a.why]),
    [
      [HOME.id, HOME.account, true, null],
      [WORK.id, '', true, null],
    ],
  );
  await r.w.hub.setLevel(WORK.id, 'blocked');
  await r.w.hub.setLevel(HOME.id, 'read');
  assert.deepEqual(
    r.sender.accounts().map((a: any) => a.why),
    [WHY.READ_ONLY, WHY.PAUSED],
  );
  r.gate.allowed = false;
  assert.deepEqual(r.sender.accounts(), []);
  // an account that is not connected is not listed, and the test connector has no send tool
  const lone = await rig();
  assert.deepEqual(
    lone.sender.accounts().map((a: any) => a.id),
    [HOME.id],
  );
});

test("a send goes asked, chosen, sent on the person's press with no second card; the note keeps the edited words and the receipt", async () => {
  const r = await rig();
  const result = await r.send({ words: { ...WORDS, subject: 'Re: lunch Friday' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.send, { state: 'sent', from: { id: HOME.id, label: HOME.label, account: HOME.account }, at: 77 });
  assert.deepEqual(
    r.events.map((e: any) => e[2]),
    ['asked', 'chose', 'sent'],
  );
  assert.equal(r.note().send.state, 'sent');
  assert.equal(r.note().draft.subject, 'Re: lunch Friday');
  assert.equal(r.note().text, 'Draft · Re: lunch Friday');
  assert.deepEqual(r.sent, [{ from: HOME.account, to: WORDS.to, subject: 'Re: lunch Friday', body: WORDS.body, at: 5 }]);
  // the press is the approval: the trust layer raised no card, and the audit log says who approved and for which draft
  assert.equal(r.w.decisions.length, 0);
  assert.deepEqual(
    r.w.audits.map((a: any) => [a.tool, a.decision, a.result, a.via, a.draft]),
    [[SEND_TOOL, 'allowed', 'done', 'user-pressed', 'd1']],
  );
  // the other notes are untouched, and a second send of the same note never goes
  assert.equal(r.records.get('momo-main').meta.notes[0].id, 'other');
  assert.deepEqual(await r.send(), { ok: false, reason: WHY.ALREADY, send: result.send });
  assert.equal(r.sent.length, 1);
});

test("the state a window reads: the send, none before it, none for a chat that is not MoMo's or while MoMo is off", async () => {
  const r = await rig();
  assert.equal(r.sender.state('momo-main', 'd1'), null);
  assert.equal(r.sender.state('momo-main', 'gone'), null);
  await r.send();
  assert.equal(r.sender.state('momo-main', 'd1')?.state, 'sent');
  assert.equal(r.sender.state('coding', 'd1'), null);
  assert.equal(r.sender.state(1 as any, 'd1'), null);
  r.gate.allowed = false;
  assert.equal(r.sender.state('momo-main', 'd1'), null);
});

test('a double click, another window or a retry meets the send in flight and does nothing', async () => {
  const r = await rig();
  const first = r.send();
  const second = r.send();
  assert.deepEqual(await second, { ok: false, reason: WHY.BUSY });
  assert.equal((await first).ok, true);
  assert.equal(r.sent.length, 1);
  assert.equal(r.w.decisions.length, 0);
});

test('what stops a send before it starts leaves the note alone', async () => {
  const r = await rig({ connect: [HOME.id, WORK.id] });
  const reason = async (over: any) => (await r.send(over)).reason;
  assert.equal(await reason({ chatId: 'coding' }), WHY.NO_DRAFT);
  assert.equal(await reason({ chatId: 5 }), WHY.NO_DRAFT);
  assert.equal(await reason({ noteId: 'other' }), WHY.NO_DRAFT);
  assert.equal(await reason({ noteId: 'nope' }), WHY.NO_DRAFT);
  assert.equal(await reason({ words: { ...WORDS, to: [] } }), WHY.NO_RECIPIENT);
  assert.equal(await reason({ words: { ...WORDS, to: ['not an address'] } }), 'bad_to');
  assert.equal(await reason({ words: null }), 'bad_body');
  assert.equal(await reason({ from: '' }), WHY.NO_ACCOUNT);
  assert.equal(await reason({ from: 'nobody' }), WHY.NOT_CONNECTED);
  assert.equal(await reason({ from: 'test-account' }), WHY.NOT_CONNECTED);
  await r.w.hub.setLevel(WORK.id, 'blocked');
  assert.equal(await reason({ from: WORK.id }), WHY.PAUSED);
  await r.w.hub.setLevel(WORK.id, 'read');
  assert.equal(await reason({ from: WORK.id }), WHY.READ_ONLY);
  r.gate.allowed = false;
  assert.equal(await reason({}), WHY.NOT_ALLOWED);
  assert.equal(r.note().send, undefined);
  assert.deepEqual(r.events, []);
  assert.equal(r.sent.length, 0);
});

test('the chat is gone before the send is written: nothing is asked', async () => {
  const r = await rig({ patch: () => false });
  assert.deepEqual(await r.send(), { ok: false, reason: WHY.NO_DRAFT });
  assert.equal(r.w.decisions.length, 0);
  // a chat whose notes are gone
  const gone = await rig();
  delete gone.records.get('momo-main').meta.notes;
  assert.equal((await gone.send()).reason, WHY.NO_DRAFT);
});

test('the provider fails: the draft goes back with a reason and a retry sends it once', async () => {
  const r = await rig();
  r.mail[HOME.id].failNext();
  assert.deepEqual(await r.send(), { ok: false, reason: WHY.FAILED });
  assert.equal(r.note().send, undefined);
  assert.equal(r.sent.length, 0);
  assert.equal((await r.send()).ok, true);
  assert.equal(r.sent.length, 1);
  // the failure is audited as a send that did not go
  assert.deepEqual(
    r.w.audits.map((a: any) => a.result),
    ['failed', 'done'],
  );
});

test('the account is disconnected while the mail goes: the provider already did it, so the receipt says sent', async () => {
  // a disconnect during the call itself: the provider already did it
  const during = await rig();
  during.mail[HOME.id].tools[SEND_TOOL].run = async () => {
    await during.w.hub.disconnect(HOME.id);
    return { sent: true };
  };
  const r = await during.send();
  assert.equal(r.ok, true);
  assert.equal(during.note().send.state, 'sent');
});

test("the hub's other errors map to a reason; anything unexpected is a failure", async () => {
  const stub = (error: unknown) => ({
    press: () => 'p',
    list: () => [
      { id: 'm', label: 'M', connected: true, account: 'm@mail.test', level: 'ask', tools: [{ name: SEND_TOOL, kind: 'change' }] },
    ],
    call: async () => {
      throw error;
    },
  });
  const records = new Map([['c', { meta: { notes: [{ id: 'n', kind: 'draft', draft: WORDS }] } }]]);
  const make = (error: unknown) =>
    createDraftSender({
      hub: stub(error),
      chats: {
        record: (id: string) => records.get(id),
        patchMeta: (id: string, p: any) => (Object.assign(records.get(id)!.meta, p), true),
      },
      records: () => records.entries(),
      allowed: () => true,
      isMomoChat: () => true,
      changed: () => undefined,
    });
  const why = async (error: unknown) => (await make(error).send({ chatId: 'c', noteId: 'n', from: 'm', words: WORDS })).reason;
  assert.equal(await why(new ConnectorError('x', 'reconnect')), WHY.RECONNECT);
  assert.equal(await why(new ConnectorError('x', 'not_connected')), WHY.NOT_CONNECTED);
  assert.equal(await why(new ConnectorError('x', 'stale')), WHY.NOT_CONNECTED);
  assert.equal(await why(new ConnectorError('x', 'unknown')), WHY.FAILED);
  assert.equal(await why(new ConnectorError('x', 'refused', 'MoMo is off')), WHY.NOT_ALLOWED);
  assert.equal(await why(new ConnectorError('x', 'refused', 'paused')), WHY.PAUSED);
  assert.equal(await why(new ConnectorError('x', 'refused', 'read only')), WHY.READ_ONLY);
  assert.equal(await why(new ConnectorError('x', 'refused', 'press mismatch')), WHY.FAILED);
  assert.equal(await why(new ConnectorError('x', 'refused')), WHY.DECLINED);
  assert.equal(await why(new Error('boom')), WHY.FAILED);
  // a stale answer after the user's yes means the mail went
  const chose = createDraftSender({
    hub: {
      ...stub(null),
      call: async (c: any) => {
        await c.onAllowed();
        throw new ConnectorError('x', 'stale');
      },
    },
    chats: { record: (id: string) => records.get(id), patchMeta: (id: string, p: any) => (Object.assign(records.get(id)!.meta, p), true) },
    records: () => records.entries(),
    allowed: () => true,
    isMomoChat: () => true,
    changed: () => undefined,
  });
  assert.equal((await chose.send({ chatId: 'c', noteId: 'n', from: 'm', words: WORDS })).ok, true);
});

test('a chat deleted while the mail went still answers sent', async () => {
  const r = await rig();
  r.mail[HOME.id].tools[SEND_TOOL].run = async () => {
    delete r.records.get('momo-main').meta.notes;
    return { sent: true };
  };
  assert.equal((await r.send()).ok, true);
});

test('at start, a send the app stopped on is unsure and never offered again; a sent one and other notes are left', async () => {
  const r = await rig();
  const from = { id: HOME.id, label: HOME.label, account: HOME.account };
  const meta = r.records.get('momo-main').meta;
  meta.notes = [
    { id: 'a', kind: 'draft', draft: WORDS, send: { state: 'asked', from, at: 1 } },
    { id: 'c', kind: 'draft', draft: WORDS, send: { state: 'chose', from, at: 1 } },
    { id: 's', kind: 'draft', draft: WORDS, send: { state: 'sent', from, at: 1 } },
    { id: 'plain', kind: 'draft', draft: WORDS },
    { id: 'n', kind: 'nudge', send: { state: 'asked', from, at: 1 } },
    null,
  ];
  r.records.set('empty', { meta: {} });
  r.records.set('none', null);
  assert.equal(r.sender.settle(), 2);
  assert.deepEqual(
    meta.notes.filter(Boolean).map((n: any) => n.send?.state),
    ['unsure', 'unsure', 'sent', undefined, 'asked'],
  );
  assert.deepEqual(
    r.events.map((e: any) => [e[1], e[2]]),
    [
      ['a', 'unsure'],
      ['c', 'unsure'],
    ],
  );
  // an unsure draft does not send again
  const again = await r.sender.send({ chatId: 'momo-main', noteId: 'a', from: HOME.id, words: WORDS });
  assert.equal(again.reason, WHY.ALREADY);
  assert.equal(again.send.state, 'unsure');
  // a chat that will not take the write is not counted
  const stuck = await rig({ patch: () => false });
  stuck.records.get('momo-main').meta.notes = [{ id: 'a', kind: 'draft', draft: WORDS, send: { state: 'asked', from, at: 1 } }];
  assert.equal(stuck.sender.settle(), 0);
});

const SHOWN = { from: HOME.account, to: WORDS.to, subject: WORDS.subject, body: WORDS.body };

test("a send_mail without the user's press on the card is refused by the hub before the trust layer is asked", async () => {
  const r = await rig();
  const call = (extra: object = {}) => r.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args: SHOWN, ...extra });
  // what a model's or a routine's call looks like: no press at all, a made-up one, and one for another chat or connector
  await assert.rejects(call(), /no press/);
  await assert.rejects(call({ press: 'made-up' }), /no press/);
  const other = r.w.hub.press(HOME.id, 'coding', SHOWN, 'd1');
  await assert.rejects(call({ press: other }), /no press/);
  const wrong = r.w.hub.press(WORK.id, 'momo-main', SHOWN, 'd1');
  await assert.rejects(call({ press: wrong }), /no press/);
  assert.equal(r.w.decisions.length, 0, 'the sentinel was never asked');
  assert.equal(r.sent.length, 0);
  assert.deepEqual(
    r.w.audits.map((a: any) => a.decision),
    ['no-press', 'no-press', 'no-press', 'no-press'],
  );
  // a press works once: the same token again is refused
  const token = r.w.hub.press(HOME.id, 'momo-main', SHOWN, 'd1');
  await call({ press: token });
  assert.equal(r.sent.length, 1);
  await assert.rejects(call({ press: token }), /no press/);
  assert.equal(r.sent.length, 1);
  // and the card's own send still goes
  assert.equal((await r.send()).ok, true);
});

test('a send whose content differs from what the person was shown is refused, audited with the draft, and nothing is sent', async () => {
  const r = await rig();
  const changed: [string, any][] = [
    ['a recipient', { ...SHOWN, to: [...WORDS.to, 'eve@example.com'] }],
    ['the subject', { ...SHOWN, subject: 'Something else' }],
    ['the body', { ...SHOWN, body: 'Send me the files.' }],
    ['the account', { ...SHOWN, from: WORK.account }],
  ];
  for (const [what, args] of changed) {
    const token = r.w.hub.press(HOME.id, 'momo-main', SHOWN, 'd1');
    await assert.rejects(
      r.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args, press: token }),
      /not what was shown/,
      what,
    );
  }
  assert.equal(r.sent.length, 0);
  assert.equal(r.w.decisions.length, 0);
  assert.deepEqual(
    r.w.audits.map((a: any) => [a.decision, a.draft]),
    changed.map(() => ['press-mismatch', 'd1']),
  );
  // the same content in another key order is the same content, and the press is used up by a refusal
  const token = r.w.hub.press(HOME.id, 'momo-main', SHOWN, 'd1');
  const reordered = { body: SHOWN.body, to: SHOWN.to, from: SHOWN.from, subject: SHOWN.subject };
  await r.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args: reordered, press: token });
  assert.equal(r.sent.length, 1);
  const spent = r.w.hub.press(HOME.id, 'momo-main', SHOWN, 'd1');
  await assert.rejects(
    r.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args: { ...SHOWN, body: 'x' }, press: spent }),
    /not what was shown/,
  );
  await assert.rejects(r.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args: SHOWN, press: spent }), /no press/);
});

test('a pressed send raises no approval card, though the trust layer would refuse it; a paused account still stops it', async () => {
  // a trust layer that would ask (and the person would be asked twice): it must never be consulted for the pressed send
  const r = await rig({ decide: async () => ({ allow: false, reason: 'would-ask' }) });
  assert.equal((await r.send()).ok, true);
  assert.equal(r.w.decisions.length, 0);
  assert.equal(r.sent.length, 1);
  // a change with no press still reaches the trust layer (the test connector's own tool is no send_mail)
  await r.w.connect();
  await assert.rejects(r.w.hub.call({ connector: 'test-account', tool: 'add', chatId: 'momo-main', args: { text: 'x' } }), /would-ask/);
  assert.equal(r.w.decisions.length, 1);
  // the account's level still gates a pressed send
  const p = await rig();
  await p.w.hub.setLevel(HOME.id, 'blocked');
  const token = p.w.hub.press(HOME.id, 'momo-main', SHOWN, 'd1');
  await assert.rejects(p.w.hub.call({ connector: HOME.id, tool: SEND_TOOL, chatId: 'momo-main', args: SHOWN, press: token }), /paused/);
});

test('with no connector that can send, the card has nothing to send from', async () => {
  // only the test connector is connected: it has no send_mail tool
  const w = connectorWorld();
  await w.connect();
  const sender = createDraftSender({
    hub: w.hub,
    chats: { record: () => undefined, patchMeta: () => false },
    records: () => [],
    allowed: () => true,
    isMomoChat: () => true,
    changed: () => undefined,
  });
  assert.deepEqual(sender.accounts(), []);
  const result = await sender.send({ chatId: 'c', noteId: 'n', from: 'test-account', words: WORDS });
  assert.equal(result.ok, false);
});
