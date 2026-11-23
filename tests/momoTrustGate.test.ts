// MoMo's trust gate (#2139, electron/momo/trustGate.cjs) over a real audit log and sentinel on a scratch folder: refusals audited with their text, the intent on the disk before the action runs, honest receipts, not sent vs uncertain (never retried, and asked again), no action without an audit record; plus the model-facing texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterCrash, auditLog, fakeSafe } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { createTrustGate, outcomeOf, failureOf } = require('../electron/momo/trustGate.cjs');
const { Sentinel, LEVELS } = require('../electron/momo/sentinel.cjs');
const { refusalText, resultText, RECEIPTS, DETAILS, REFUSALS, UNRECORDED } = require('../electron/momo/trustTexts.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');

const send = {
  chatId: 'momo-main',
  tool: 'mail_send',
  source: 'mail',
  kind: 'change',
  account: 'work',
  harness: 'codex',
  args: { to: 'ann@example.com' },
  egress: { recipients: ['ann@example.com'] },
};

function rig(answers: any[] = [], o: { safe?: any; onError?: any } = {}) {
  const queue = [...answers];
  const sentinel = new Sentinel({
    askUser: async () => queue.shift() ?? null,
    allowed: () => true,
    sources: { mail: { level: LEVELS.ASK, private: true }, web: { level: LEVELS.READ } },
  });
  const t = auditLog({ safe: o.safe });
  const errors: string[] = [];
  const gate = createTrustGate({ sentinel, audit: t.log, onError: o.onError ?? ((what: string) => errors.push(what)) });
  const entries = () =>
    fs.existsSync(path.join(t.dir, CURRENT))
      ? fs
          .readFileSync(path.join(t.dir, CURRENT), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { gate, sentinel, queue, entries, errors, ...t };
}

test('a refused call is audited and answered with its text; nothing runs', async () => {
  const { gate, entries } = rig([{ allow: false }]);
  let ran = 0;
  const r = await gate(send, async () => ran++);
  assert.deepEqual(r, { ok: false, reason: 'denied', text: refusalText('denied') });
  assert.match(r.text, /nothing was sent/);
  assert.equal(ran, 0);
  const [e] = entries();
  assert.deepEqual([e.kind, e.decision, e.action, e.chatId], ['refusal', 'denied', 'mail_send', 'momo-main']);
  const blocked = await gate({ ...send, source: 'bank' }, async () => ran++);
  assert.equal(blocked.text, "bank is blocked for MoMo, so nothing ran. Don't try another way; tell the user.");
  // a call that can't even be audited is still refused, and the failure only noted
  const bad = rig();
  assert.equal((await bad.gate(null, async () => ran++)).reason, 'invalid');
  assert.deepEqual(bad.errors, []);
  assert.equal(ran, 0);
});

test('the intent is on the disk before the action runs, and the outcome after; a receipt replaces "Done."', async () => {
  const { gate, entries } = rig([{ allow: true, scope: 'once' }]);
  const r = await gate(send, async () => {
    const before = entries();
    assert.deepEqual(
      before.map((e) => e.kind),
      ['intent'],
    );
    assert.equal(before[0].decision, 'asked:once');
    return { result: 'done', receipt: 'mailAccepted', value: { id: 'm1' } };
  });
  assert.deepEqual(r, { ok: true, result: 'done', value: { id: 'm1' }, text: "Mail accepted this message; delivery can't be confirmed." });
  const [intent, outcome] = entries();
  assert.deepEqual([outcome.kind, outcome.id, outcome.result, outcome.note], ['outcome', intent.id, 'done', 'mailAccepted']);
  // a plain value is done
  const p = rig([{ allow: true, scope: '30d' }]);
  assert.deepEqual(await p.gate(send, async () => 'sent'), { ok: true, result: 'done', value: 'sent', text: 'Done.' });
  assert.equal((await p.gate(send, async () => null)).result, 'done');
  assert.equal(p.entries()[2].decision, 'remembered:30d');
});

test('a read that sends nothing runs without an audit entry; a read that sends somewhere is audited', async () => {
  const { gate, entries, queue } = rig();
  const r = await gate({ chatId: 'momo-main', tool: 'web_search', source: 'web', kind: 'read', args: { q: 'x' } }, async () => ['hit']);
  assert.deepEqual(r, { ok: true, result: 'done', value: ['hit'] });
  assert.deepEqual(entries(), []);
  await gate({ chatId: 'momo-main', tool: 'mail_search', source: 'mail', kind: 'read' }, async () => []);
  queue.push({ allow: true, scope: 'once' });
  const fetch = { chatId: 'momo-main', tool: 'web_fetch', source: 'web', kind: 'read', egress: { hosts: ['evil.example'] } };
  assert.equal((await gate(fetch, async () => 'page')).text, 'Done.');
  assert.deepEqual(
    entries().map((e) => [e.kind, e.decision]),
    [
      ['intent', 'asked:once'],
      ['outcome', undefined],
    ],
  );
  // untainted, the same fetch goes straight through but is still audited (it sends data out)
  const u = rig();
  await u.gate(fetch, async () => 'page');
  assert.deepEqual(
    u.entries().map((e) => [e.kind, e.decision]),
    [
      ['intent', 'read'],
      ['outcome', undefined],
    ],
  );
});

test('not sent only when the action says so; anything else that failed is uncertain, never retried, and the same action asks again', async () => {
  const { gate, entries, queue } = rig([{ allow: true, scope: '30d' }]);
  const notSent = await gate(send, async () => {
    throw Object.assign(new Error('SMTP 550 for ann@example.com'), { notSent: true, detail: 'addressRefused' });
  });
  assert.deepEqual(notSent, {
    ok: false,
    result: 'not sent',
    value: undefined,
    text: 'Nothing was sent. The mail server refused the address.',
  });
  let calls = 0;
  const uncertain = await gate(send, async () => {
    calls++;
    throw new Error('socket hang up');
  });
  assert.deepEqual(uncertain, {
    ok: false,
    result: 'uncertain',
    value: undefined,
    text: "This may or may not have gone through. Don't retry it; tell the user so they can check.",
  });
  assert.equal(calls, 1, 'run once, not again');
  assert.deepEqual(
    entries()
      .filter((e) => e.kind === 'outcome')
      .map((e) => e.result),
    ['not sent', 'uncertain'],
  );
  assert.equal(entries().filter((e) => e.kind === 'intent').length, 2);
  // the remembered approval doesn't cover the next try: it asks
  assert.equal((await gate(send, async () => calls++)).reason, 'no-answer');
  queue.push({ allow: true, scope: 'once' });
  assert.equal((await gate(send, async () => ({ result: 'done' }))).result, 'done');
  assert.equal((await gate(send, async () => ({ result: 'done' }))).result, 'done', 'remembered again after it went through');
  // an action that says something the gate doesn't know is uncertain
  assert.equal((await gate(send, async () => ({ result: 'probably' }))).result, 'uncertain');
  queue.push({ allow: true, scope: 'once' });
  assert.equal((await gate(send, async () => ({ result: 'not sent' }))).text, 'Nothing was sent.');
});

test('no audit record, no action: without encryption the call is refused before it runs', async () => {
  const safe = fakeSafe();
  safe.available = false;
  const { gate, sentinel } = rig([{ allow: true, scope: 'once' }], { safe });
  let cards = 0;
  const ask = sentinel.askUser;
  sentinel.askUser = (...a: any[]) => (cards++, (ask as any)(...a));
  let ran = 0;
  const r = await gate(send, async () => ran++);
  assert.deepEqual(r, { ok: false, reason: 'audit', text: refusalText('audit') });
  assert.equal(ran, 0);
  assert.equal(cards, 0, 'no card for what could not be recorded anyway');
});

test('a call stopped while its intent was written does not run and is recorded as not sent', async () => {
  const ctl = new AbortController();
  const { gate, entries, log } = rig([{ allow: true, scope: 'once' }]);
  const intent = log.intent.bind(log);
  log.intent = async (f: any) => {
    const r = await intent(f);
    ctl.abort();
    return r;
  };
  let ran = 0;
  const r = await gate(send, async () => ran++, { signal: ctl.signal });
  assert.equal(r.result, 'not sent');
  assert.equal(ran, 0);
  assert.equal(entries().at(-1).result, 'not sent');
});

test('an outcome that cannot be recorded after the action ran is noted, and the result still reaches the model', async () => {
  const { gate, log, errors } = rig([{ allow: true, scope: 'once' }]);
  log.outcome = async () => {
    throw new Error('disk full');
  };
  const ran = await gate(send, async () => 'ok');
  assert.deepEqual([ran.result, ran.text], ['done', `Done. ${UNRECORDED}`], 'never a plain "Done." for what the log does not hold');
  assert.deepEqual(errors, ['record how a MoMo action ended']);
  const r = rig([], { onError: undefined });
  r.log.refusal = async () => {
    throw new Error('disk full');
  };
  // the default onError notes it without throwing
  const quiet = createTrustGate({ sentinel: r.sentinel, audit: r.log });
  assert.equal((await quiet(send, async () => 'x')).reason, 'no-answer');
});

test('an account MoMo is not allowed for leaves nothing on the disk; an audit failure ends the running mark', async () => {
  const t = auditLog();
  const sentinel = new Sentinel({ askUser: async () => ({ allow: true, scope: '30d' }), sources: { mail: { level: 'ask' } } });
  const gate = createTrustGate({ sentinel, audit: t.log });
  assert.equal((await gate(send, async () => 'x')).reason, 'not-allowed');
  assert.equal(fs.existsSync(t.dir), false);

  const safe = fakeSafe();
  const r = rig([{ allow: true, scope: '30d' }], { safe });
  safe.available = false;
  assert.equal((await r.gate(send, async () => 'x')).reason, 'audit');
  safe.available = true;
  assert.equal((await r.gate(send, async () => 'sent')).result, 'done', 'remembered, and not left marked as running');
});

test('two identical calls at once: the second asks while the first still runs', async () => {
  const { gate } = rig([{ allow: true, scope: '30d' }]);
  await gate(send, async () => 'first');
  let finish: (v: unknown) => void = () => {};
  const running = gate(send, () => new Promise((r) => (finish = r)));
  await new Promise((r) => setImmediate(r));
  assert.equal((await gate(send, async () => 'again')).reason, 'no-answer');
  finish('ok');
  assert.equal((await running).result, 'done');
});

test('outcomes and failures map to the three results', () => {
  assert.deepEqual(outcomeOf(['a']), { result: 'done', value: ['a'] });
  // only keys of the known sets: an action's own text (a subject line, an address) never reaches the model or the log
  assert.deepEqual(outcomeOf({ result: 'uncertain', receipt: 7, detail: 'offline' }), {
    result: 'uncertain',
    receipt: undefined,
    detail: 'offline',
    value: undefined,
  });
  assert.deepEqual(outcomeOf({ result: 'done', receipt: 'Sent "Q3 layoffs" to ann@example.com', detail: 'toString' }), {
    result: 'done',
    receipt: undefined,
    detail: undefined,
    value: undefined,
  });
  assert.deepEqual(failureOf(undefined), { result: 'uncertain' });
  assert.deepEqual(failureOf({ notSent: true, detail: 3 }), { result: 'not sent', detail: undefined });
  assert.deepEqual(failureOf({ notSent: true, detail: 'tooLarge' }), { result: 'not sent', detail: 'tooLarge' });
});

test('the texts: each refusal, an unknown reason, the default source name, and each result', () => {
  for (const reason of Object.keys(REFUSALS)) assert.ok(refusalText(reason, { source: 'Mail' }).length < 120, reason);
  assert.equal(refusalText('something new'), refusalText('invalid'));
  assert.equal(refusalText('read-only'), 'This source is read only for MoMo, so nothing was changed. Tell the user if it needs changing.');
  assert.match(refusalText('denied', { kind: 'read' }), /so nothing was read\./, 'a read says read, not sent');
  assert.match(refusalText('no-answer', { kind: 'change' }), /so nothing was sent\./);
  assert.equal(resultText('done'), 'Done.');
  assert.equal(resultText('done', { receipt: 'messageQueued' }), RECEIPTS.messageQueued);
  assert.equal(resultText('done', { receipt: 'hasOwnProperty' }), 'Done.', "only the set's own keys");
  assert.equal(resultText('not sent', { receipt: 'saved' }), 'Nothing was sent.', 'a receipt never dresses up a failure');
  assert.equal(resultText('not sent', { detail: 'offline' }), `Nothing was sent. ${DETAILS.offline}`);
  assert.equal(resultText('uncertain', { receipt: 'saved' }), resultText('uncertain'));
  assert.equal(resultText('done', { recorded: false }), `Done. ${UNRECORDED}`);
});

test('intents a quit left open are settled as uncertain before the first side effect; a failed settle refuses and is tried again', async () => {
  const before = auditLog();
  await before.log.intent({ action: 'mail_send', chatId: 'momo-main', decision: 'asked:once' });
  const sentinel = new Sentinel({
    askUser: async () => ({ allow: true, scope: 'once' }),
    allowed: () => true,
    sources: { mail: { level: 'ask', name: 'Mail' } },
  });
  const next = afterCrash({ dir: before.dir, safe: before.safe });
  const settle = next.log.settleUnfinished.bind(next.log);
  let fail = true;
  next.log.settleUnfinished = async () => (fail ? Promise.reject(new Error('EIO')) : settle());
  const gate = createTrustGate({ sentinel, audit: next.log });
  assert.equal((await gate(send, async () => 'x')).reason, 'audit');
  fail = false;
  assert.equal((await gate(send, async () => 'x')).result, 'done');
  const kinds = fs
    .readFileSync(path.join(before.dir, CURRENT), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((e) => [e.kind, e.result]);
  assert.deepEqual(kinds, [
    ['intent', undefined],
    ['outcome', 'uncertain'],
    ['intent', undefined],
    ['outcome', 'done'],
  ]);
  // the source's own name in a refusal
  sentinel.setSource('mail', { level: 'read', name: 'Mail' });
  assert.match((await gate(send, async () => 'x')).text, /^Mail is read only for MoMo/);
});

test('execute() runs only after the sentinel wrote the run and the audit wrote the intent', async () => {
  const events: string[] = [];
  const storage = { read: async () => null, write: async () => void events.push('run stored') };
  const sentinel = new Sentinel({
    askUser: async () => ({ allow: true, scope: 'once' }),
    allowed: () => true,
    sources: { mail: { level: 'ask' } },
    storage,
  });
  const t = auditLog();
  const intent = t.log.intent.bind(t.log);
  t.log.intent = async (f: any) => {
    const r = await intent(f);
    events.push('intent on disk');
    return r;
  };
  const gate = createTrustGate({ sentinel, audit: t.log });
  await gate(send, async () => void events.push('execute'));
  assert.deepEqual(events.slice(0, 3), ['run stored', 'intent on disk', 'execute']);
  // a run that can't be stored: refused with its own text, nothing runs
  const failing = new Sentinel({
    askUser: async () => ({ allow: true, scope: 'once' }),
    allowed: () => true,
    sources: { mail: { level: 'ask' } },
    storage: { read: async () => null, write: async () => Promise.reject(new Error('disk full')) },
  });
  let ran = 0;
  const r = await createTrustGate({ sentinel: failing, audit: auditLog().log })(send, async () => ran++);
  assert.deepEqual([r.reason, ran], ['storage', 0]);
  assert.match(r.text, /can't save what it is about to do/);
});
