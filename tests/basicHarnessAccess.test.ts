// Basic (ACP) harnesses' limits and unattended work: a cut-off reply or a usage limit reads as a note (in the chat and
// its notification), a scheduled run or peer delivery that fails says so, and the identity driver's status.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AcpDriver } = require('../electron/identity/drivers/acp.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { AutomationRunner } = require('../electron/platform/automationRun.cjs');
const { Scheduler } = require('../electron/platform/scheduler.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const { acpStop, isLimitError } = await import('../shared/acpStop.mjs');
const { AcpTranslator, buildAcpTurns } = await import('../electron/harness/items/acpTranslator.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-limits-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('B-6: a peer delivery a basic harness refuses for a sign-in fails as login_required, like the gate', async () => {
  const errors = ['Authentication required', 'disk full'];
  const turns = new AcpTurns({
    send: async () => {
      const message = errors.shift();
      throw Object.assign(new Error(message), { code: message === 'disk full' ? -32603 : -32000 });
    },
    rename: () => {},
    readImage: async () => null,
    home: '/home/me',
  });
  const ref = { kind: 'acp:kimi', id: 'k1', key: 'acp:kimi:k1' };
  const item = { text: 'hi', peer: { messageId: 'm1', sourceChatId: 'A' } };
  assert.deepEqual(await turns.startTurn('acp:kimi:k1', ref, item), {
    started: false,
    error: 'Authentication required',
    code: 'login_required',
  });
  assert.deepEqual(await turns.startTurn('acp:kimi:k1', ref, item), { started: false, error: 'disk full' });
  // the journal records the code when there is one, else the error
  const service = new PeerMessageService({
    file: path.join(dir, 'peer', 'journal.json'),
    controller: { state: { get: () => ({ queue: [] }) } },
    exists: () => true,
    authorize: () => true,
    gate: () => null,
    write: () => {},
  });
  const msg = (id: string) => ({ id, sourceChatId: 'A', targetChatId: 'B', delivery: 'submitting', reply: 'notRequested' });
  service.commit({ schemaVersion: 1, messages: [msg('m1'), msg('m2')] });
  service.result({ item: { id: 'm1' }, result: { started: false, error: 'Authentication required', code: 'login_required' } });
  service.result({ item: { id: 'm2' }, result: { started: false, error: 'disk full' } });
  assert.deepEqual(
    ['m1', 'm2'].map((id) => [service.get('A', id).delivery, service.get('A', id).errorCode]),
    [
      ['failed', 'login_required'],
      ['failed', 'disk full'],
    ],
  );
});

test('B-5: a cut-off reply is completed with a note; a usage limit is a note, not the raw error', () => {
  assert.deepEqual(acpStop('cancelled', 'x'), { status: 'interrupted', error: null, note: null });
  assert.deepEqual(acpStop('end_turn', null), { status: 'completed', error: null, note: null });
  assert.equal(acpStop('max_tokens', null).note?.kind, 'cutOff');
  assert.match(String(acpStop('max_tokens', null).note?.text), /output limit/);
  assert.match(String(acpStop('max_turn_requests', null).note?.text), /model requests/);
  assert.equal(acpStop('max_tokens', null).status, 'completed');
  // a refusal is a note the panel's refusal card reads (with the harness's own words when it gave some), not a raw error
  assert.deepEqual(acpStop('refusal', null), {
    status: 'failed',
    error: null,
    note: { kind: 'refusal', text: 'The agent refused to continue' },
  });
  assert.deepEqual(acpStop('refusal', 'Declined by policy').note, { kind: 'refusal', text: 'Declined by policy' });
  assert.deepEqual(acpStop('error', 'disk full'), { status: 'failed', error: 'disk full', note: null });
  assert.deepEqual(acpStop(null, null), { status: 'failed', error: null, note: null });
  const limit = acpStop('error', '  Quota exceeded for quota metric  ');
  assert.deepEqual([limit.status, limit.error, limit.note?.kind], ['failed', null, 'limit']);
  assert.match(String(limit.note?.text), /usage limit \(Quota exceeded for quota metric\)\. It has no other account/);
  for (const text of [
    'Claude AI usage limit reached',
    '429 Too Many Requests',
    'RESOURCE_EXHAUSTED',
    'You have exhausted your daily quota',
    'Rate limit exceeded',
    'exceeded_current_quota_error',
    "You've hit your limit",
    'Your credit balance is too low',
    'insufficient credits',
  ])
    assert.equal(isLimitError(text), true, text);
  for (const text of ['', null, 'context window too long', 'disk full']) assert.equal(isLimitError(text), false, String(text));
  // a reply that finished without error is never a limit, whatever it says
  assert.equal(acpStop('end_turn', 'rate limit').note, null);
});

test('B-5: the translator adds the note to the turn, live and on replay, with the same id', () => {
  const out: any[] = [];
  const tr = new AcpTranslator('c1', '/w', (method: string, p: any) => out.push([method, p]));
  tr.beginTurn('t1', { id: 'u', clientId: null, content: [] });
  tr.endTurn('max_tokens', null);
  const note = out.find(([m, p]) => m === 'item/completed' && p.item.type === 'statusNote')[1].item;
  assert.deepEqual(note, { type: 'statusNote', id: 'cutOff-t1', kind: 'cutOff', text: acpStop('max_tokens', null).note?.text });
  assert.equal(out.at(-1)[1].turn.status, 'completed');
  tr.beginTurn('t2', { id: 'u2', clientId: null, content: [] });
  tr.endTurn('error', 'Rate limit exceeded');
  const end = out.at(-1)[1].turn;
  assert.deepEqual([end.status, end.error], ['failed', null]);
  assert.equal(out.at(-2)[1].item.id, 'limit-t2');
  const turns = buildAcpTurns(
    [
      { t: 'user', turnId: 't1', user: { id: 'u', clientId: null, content: [] } },
      { t: 'end', turnId: 't1', stopReason: 'max_tokens' },
    ],
    'c1',
    '/w',
  );
  assert.deepEqual(
    turns[0].items.map((i: any) => i.id),
    ['u', 'cutOff-t1'],
  );
});

/** A ChatController with one ACP chat whose turn is running, and the notifications it sends. */
function controller() {
  const state = new SessionStore();
  const said: any[] = [];
  const finished: any[] = [];
  const rec = { id: 'acp1', segments: [{ kind: 'acp:kimi', nativeId: 'acp1' }] };
  const c = new ChatController({
    state,
    chats: { record: () => rec, records: new Map([['acp1', rec]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    acp: { send: async () => true, cancel: () => true },
    notify: (kind: string, chatId: string, o: any) => said.push([kind, chatId, o.body]),
    onFinished: (e: any) => void finished.push(e),
  });
  return { c, said, state, finished };
}

test('B-5: the turn notification says what the chat note says, and a failed turn is not "Task complete"', () => {
  const { c, said, state, finished } = controller();
  state.patch('acp1', { plan: false });
  const end = (stopReason: string | null, error: string | null) => {
    c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 't' });
    c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd', turnId: 't', stopReason, error });
    return said.at(-1)[2];
  };
  assert.match(end('max_tokens', null), /^The reply was cut off/);
  assert.match(end('error', 'usage limit reached'), /^The harness reached its usage limit/);
  assert.equal(end('error', 'disk full'), 'The turn ended with an error: disk full');
  assert.equal(end('end_turn', null), 'Task complete');
  assert.equal(c.endBody('last words', 'failed'), 'The turn ended with an error');
  // a cut-off reply is a reply: it completes (a peer gets it), as the chat shows it
  assert.deepEqual(
    finished.map((f: any) => f.completed),
    [true, false, false, true],
  );
});

test('B-6: a scheduled run on a harness that is not usable points a basic harness to Settings, and re-checks unattended', async () => {
  const asked: any[] = [];
  const run = (over: any) =>
    new AutomationRunner({
      prefs: () => ({}),
      usable: async (kind: string, o: any) => (asked.push([kind, o]), false),
      label: () => 'Gemini CLI',
      sessions: { patch: () => {} },
      send: async () => ({}),
      ...over,
    });
  await assert.rejects(
    run({}).run({ id: 'a', harness: 'acp:gemini' }, { unattended: true }),
    /^Error: Gemini CLI isn’t available\. Sign in or install it in Settings → Other agents\.$/,
  );
  await assert.rejects(run({}).run({ id: 'a' }, { unattended: false }), /Codex isn’t available\. Open the harness menu/);
  assert.deepEqual(asked, [
    ['acp:gemini', { unattended: true }],
    ['codex', { unattended: false }],
  ]);
});

test('B-6: a run whose first message does not start fails with its chat; one held or queued does not', async () => {
  const runner = (sent: any) =>
    new AutomationRunner({
      prefs: () => ({}),
      usable: async () => true,
      sessions: { patch: () => {} },
      send: async () => sent,
      codexThread: async () => ({ id: 'th1' }),
      chats: { patchMeta: () => true },
      started: () => {},
      worktree: async () => null,
    });
  const err = await runner({ started: false, error: 'Sign in to Codex first' })
    .run({ id: 'a' }, { unattended: true })
    .catch((e: any) => e);
  assert.equal(err.message, 'The task’s message didn’t start: Sign in to Codex first');
  assert.equal(err.chatId, 'th1');
  const bare = await runner({ started: false })
    .run({ id: 'a' }, { unattended: true })
    .catch((e: any) => e);
  assert.match(bare.message, /the harness refused it/);
  for (const sent of [
    { started: true },
    { started: false, held: true },
    { started: false, discarded: true },
    { action: 'queued' },
    undefined,
  ])
    assert.equal(await runner(sent).run({ id: 'a' }, { unattended: true }), 'th1', JSON.stringify(sent));
});

test('B-6: the scheduler records a failed run with its chat and notifies it; merged failures say so', async (t) => {
  const d = fs.mkdtempSync(path.join(dir, 'sched-'));
  fs.writeFileSync(path.join(d, '.baseline'), '1');
  const { RunLedger } = require('../electron/platform/runLedger.cjs');
  const ledger = new RunLedger({ dir: d });
  const notes: any[] = [];
  const log = mock.fn();
  const s = new Scheduler({
    enabled: () => true,
    list: async () => [
      { id: 'a', name: 'A', status: 'ACTIVE', rrule: 'FREQ=MINUTELY' },
      { id: 'b', name: 'B', status: 'ACTIVE', rrule: 'FREQ=MINUTELY' },
    ],
    run: async (task: any) => {
      throw task.id === 'a' ? Object.assign(new Error('did not start'), { chatId: 'chat-a' }) : 'not usable';
    },
    sessions: { all: () => [], has: () => false, get: () => null, patch: () => {} },
    ledger,
    notify: (...a: any[]) => notes.push(a),
    tickMs: 0,
    log,
  });
  t.after(() => s.stop());
  await s.tick();
  assert.deepEqual(
    notes.map(([chatId, task, o]) => [chatId, task.id, o.error]),
    [
      ['chat-a', 'a', 'did not start'],
      [null, 'b', 'not usable'],
    ],
  );
  const runs = await ledger.list('a', 5);
  assert.deepEqual([runs[0].status, runs[0].reason, runs[0].chatId], ['failed', 'did not start', 'chat-a']);
  assert.equal((await ledger.list('b', 5))[0].chatId, undefined);
  assert.equal(log.mock.callCount(), 2, 'still in the run log');
  // a run that started is not reported as failing when its ledger write fails afterwards
  const started: any[] = [];
  const later = new Scheduler({
    enabled: () => true,
    list: async () => [{ id: 'c', name: 'C', status: 'ACTIVE', rrule: 'FREQ=MINUTELY' }],
    run: async () => 'chat-c',
    sessions: { all: () => [], has: () => false, get: () => null, patch: () => {} },
    ledger: Object.assign(Object.create(ledger), {
      update: async (_id: string, _due: number, p: any) => {
        if (p.status === 'started') throw new Error('disk full');
      },
    }),
    notify: (...a: any[]) => started.push(a),
    tickMs: 0,
    log,
  });
  await later.tick();
  assert.deepEqual(started, [], 'neither started nor failed: the write failure is logged');
  assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /scheduled task c did not start: disk full/);
  const shown: any[] = [];
  const n = new Notifier({ show: (x: any) => (shown.push(x), { close() {} }), getMode: () => 'always' });
  n.notify('scheduled', 'automation:a', { title: "Scheduled task didn't start", body: 'A: x', group: 'failed' });
  n.notify('scheduled', 'automation:b', { title: "Scheduled task didn't start", body: 'B: y', group: 'failed' });
  assert.equal(shown.at(-1).title, "2 scheduled tasks didn't start");
  n.notify('scheduled', 'c1', { title: 'Scheduled task started', body: 'A' });
  n.notify('scheduled', 'c2', { title: 'Scheduled task started', body: 'B' });
  assert.equal(shown.at(-1).title, '2 scheduled tasks started');
});

test('B-8: the ACP driver reports only an admitted harness as ok', () => {
  const list = ['admitted', 'signin', 'checking', 'unsupported', 'off', 'missing'].map((state) => ({ id: state, state }));
  const d = new AcpDriver({ list: () => list });
  assert.deepEqual(
    d.instances().map((i: any) => [i.account, i.status]),
    [
      ['admitted', 'ok'],
      ['signin', 'signedOut'],
      ['checking', 'unavailable'],
      ['unsupported', 'unavailable'],
      ['off', 'unavailable'],
    ],
  );
});
