// MoMo's notices on a Host, through the real parts: `momoHomeFor` loads the notice service from host/src/momoServices/, the scheduler's tick runs the collector over a fake Google reader and reading model, the daily clock builds and delivers the brief from the seams the service gave, tell-nows go through the home's push, and the wire method answers a granted client. Nothing here is a self-built world: removing the service file, the tick hook or the seams makes these fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createNoticeModel } from '../host/src/momoNoticeModel.mjs';
// @ts-ignore
import { createMomoHidden, momoHomeFor, momoRunsFor } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { createMemoryVersionStore } from '../shared/momoNotice/memoryStore.ts';
import { servedHost } from './support/hostClientsWorld.ts';

const MOMO = ['momo'];
const start = { homeId: 'home-aaaa-1111', name: 'Studio' };
const authPass = { 'Authentication-Results': 'mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=acme.com' };

const mailOf = (threadId: string, subject: string, body: string, over: object = {}) => ({
  id: `m-${threadId}`,
  threadId,
  from: 'Ana <ana@acme.com>',
  to: ['maya@x.com'],
  cc: [],
  subject,
  date: new Date().toISOString(),
  headers: authPass,
  labels: ['INBOX'],
  body,
  ...over,
});

async function world(t: any, mode: string | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') };
  const reports: string[] = [];
  const records = new Map<string, any>();
  const sessions: any = {
    chats: { records, patchMeta: (id: string, patch: object) => records.set(id, { meta: { ...records.get(id)?.meta, ...patch } }) },
    isolated: () => true,
    isolate: () => undefined,
  };
  const home: any = momoHomeFor({
    hostId: start.homeId,
    paths,
    report: (m: string) => reports.push(m),
    sessions,
    epochs: { current: () => 0 },
    hidden: createMomoHidden(),
    env: { ...(mode ? { MOMO_NOTICE_MODE: mode } : {}), MOMO_NOTICE_EVERY_MS: '0' },
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(start);
  // one UTC day, no quiet hours: what the test sees does not depend on the time it runs
  await home.prefs.change({ quietHours: null, brief: { on: true, zone: 'UTC', time: new Date().toISOString().slice(11, 16) } });

  const threads: Record<string, any> = {};
  const calls = { listThreads: 0, getMail: 0 };
  const versions = createMemoryVersionStore();
  const client = {
    listThreads: async () => (calls.listThreads++, { threadIds: Object.keys(threads) }),
    getThreadMeta: async (id: string) => ({ id, messages: [{ id: threads[id].id, internalDate: String(Date.parse(threads[id].date)) }] }),
    getMail: async (id: string) => (calls.getMail++, threads[id] ?? null),
    listEvents: async () => ({ events: [] }),
    calendarEtag: async () => 'etag-1',
  };
  home.provide('google', {
    reader: async () => ({ client, versions }),
    status: async () => ({ kind: 'connected_read_only', email: 'maya@x.com', connectedAt: 1 }),
  });
  const told: any[] = [];
  home.push = { tell: async (item: any) => (told.push(item), { status: 'sent' }) };
  const prompts: string[] = [];
  const answers: string[] = [];
  home.service('notice').setModel({
    name: 'fake',
    complete: async (prompt: string) => (prompts.push(prompt), answers.shift() ?? 'no answer'),
  });
  const answer = (verdict: string, reason = 'It needs you.') => JSON.stringify({ verdict, reason, matterKey: 'gmail:x' });
  return { dir, home, reports, threads, calls, told, prompts, answers, answer, notice: () => home.service('notice') };
}

test('the service is loaded by the real loader, and off means nothing is read', async (t) => {
  const w = await world(t, undefined);
  assert.equal(typeof w.notice().tick, 'function');
  w.threads.t1 = mailOf('t1', 'Contract', 'Please sign by Friday.');
  await w.home.scheduler.tick();
  assert.deepEqual(await w.notice().tick(), { idle: 'off' });
  assert.equal(w.calls.listThreads, 0);
  assert.deepEqual(w.told, []);
});

test('the scheduler tick runs the collector: the first connect pushes nothing, a later tell-now goes through the home push, and the views say why', async (t) => {
  const w = await world(t, 'tell_now');
  w.threads.t1 = mailOf('t1', 'Old contract', 'Please sign by Friday.');
  w.answers.push(w.answer('tell_now', 'A contract waits for your signature.'));
  // the real clock path: the scheduler's tick calls the hook the service registered
  await w.home.scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.calls.listThreads, 1, 'the tick hook ran the pass');
  assert.deepEqual(w.told, [], 'the first connect waits for the brief');
  const first = w.notice().decisions();
  assert.deepEqual([first[0].outcome, first[0].matter.first], ['tell_now', true]);
  assert.ok(
    first[0].checks.some((c: string) => /first connect|already in your inbox/i.test(c)) ||
      first[0].checks.some((c: string) => /Held/.test(c)),
  );

  // a new mail after the first pass is told once, and asked again it is not
  w.threads.t2 = mailOf('t2', 'Payment failed', 'Update billing by Friday.', { date: new Date(Date.now() + 1000).toISOString() });
  w.answers.push(w.answer('tell_now', 'A payment failed.'));
  assert.equal((await w.notice().tick()).decisions, 1);
  assert.equal(w.told.length, 1);
  assert.match((w.told as any[])[0].key, /^notice:gmail:t2:/);
  assert.equal((w.told as any[])[0].kind, 'reply');
  assert.equal((await w.notice().tick()).decisions, 0);
  assert.equal(w.told.length, 1);
  // the prompt wraps the mail as untrusted data
  assert.match(w.prompts.at(-1) as string, /EXTERNAL_UNTRUSTED_CONTENT|UNTRUSTED/i);
});

test('brief mode reads and keeps matters but pushes no tell-now; a model that is not set up reads nothing and says so', async (t) => {
  const w = await world(t, 'brief');
  w.home.service('notice').setModel(null);
  w.threads.t1 = mailOf('t1', 'Contract', 'Sign.');
  assert.deepEqual(await w.notice().tick(), { idle: 'no-model' });
  assert.equal(w.calls.getMail, 0);
  assert.match(JSON.stringify(w.notice().state().gaps), /No reading model/);
  w.home.service('notice').setModel({ name: 'fake', complete: async () => w.answer('tell_now') });
  await w.notice().tick();
  w.threads.t2 = mailOf('t2', 'Invoice', 'Pay now.', { date: new Date(Date.now() + 1000).toISOString() });
  await w.notice().tick();
  assert.deepEqual(w.told, []);
  assert.equal(w.notice().decisions().length, 2);
});

test('the daily clock builds and delivers the brief from the seams the service gave, claimed once', async (t) => {
  const w = await world(t, 'brief');
  w.threads.t1 = mailOf('t1', 'Contract', 'Please sign by Friday.');
  w.answers.push(w.answer('tell_now', 'A contract waits for your signature.'));
  await w.notice().tick();
  const first = await w.home.daily.tick();
  assert.deepEqual(first.did, ['brief:delivered']);
  assert.equal(w.told.at(-1)?.kind, 'brief');
  const cards = w.notice().cards();
  assert.equal(cards.length, 1);
  assert.match(cards[0].key, /^brief:\d{4}-\d{2}-\d{2}$/);
  assert.match(cards[0].view.text, /Needs you:\n- Contract: A contract waits/);
  assert.equal(cards[0].view.attention.source, 'Gmail');
  // the matter the brief carried counts as told, and the day is not briefed twice
  const again = await w.home.daily.tick();
  assert.deepEqual(again.did, []);
  assert.equal(w.told.filter((x) => x.kind === 'brief').length, 1);
});

test('the wire method answers a granted client and is unknown to a stranger; snooze and dismiss change a matter', async (t) => {
  const w = await world(t, 'brief');
  w.threads.t1 = mailOf('t1', 'Contract', 'Please sign by Friday.');
  w.answers.push(w.answer('track', 'Waiting on legal.'));
  await w.notice().tick();
  // a Host with no MoMo home does not know the method at all
  const bare = await servedHost(t);
  assert.match(JSON.stringify(await bare.line().call('host.momoNotice', { op: 'state' })), /Unknown request/);
  const served = await servedHost(t, { momo: w.home });
  assert.match(JSON.stringify(await served.line().call('host.momoNotice', { op: 'state' })), /Unknown request/);
  const client = (await served.paired('mac', 'Mac')).conn;
  await client.request('host.momoGrant', { account: 'a1', features: MOMO });
  await client.call('host.hello', helloParams());
  const watching = (await client.request('host.momoNotice', { op: 'watching' })) as any;
  assert.deepEqual(
    [watching.tasks[0].state, watching.tasks[0].watch.why, watching.tasks[0].watch.told],
    ['watching', 'Waiting on legal.', false],
  );
  assert.equal(watching.tasks[0].watch.decision.outcome, 'watch');
  const decisions = (await client.request('host.momoNotice', { op: 'decisions', matterKey: 'gmail:t1' })) as any;
  assert.equal(decisions.decisions.length, 1);
  assert.deepEqual(((await client.request('host.momoNotice', { op: 'state' })) as any).mode, 'brief');
  const byId = (await client.request('host.momoNotice', { op: 'decisions', ids: ['gmail:t1'], limit: 5 })) as any;
  assert.deepEqual(
    byId.decisions.map((d: any) => d.id),
    ['gmail:t1'],
  );
  assert.equal(((await client.request('host.momoNotice', { op: 'cards' })) as any).cards.length, 0);
  assert.deepEqual(await client.request('host.momoNotice', { op: 'snooze', matterKey: 'gmail:t1', until: Date.now() + 3_600_000 }), {
    done: true,
  });
  assert.deepEqual(await client.request('host.momoNotice', { op: 'dismiss', matterKey: 'gmail:t1' }), { done: true });
  assert.deepEqual(await client.request('host.momoNotice', { op: 'dismiss', matterKey: 'gmail:none' }), { done: false });
  assert.deepEqual(await client.request('host.momoNotice', { op: 'retry' }), { done: true });
  assert.deepEqual(await client.request('host.momoNotice', { op: 'moreReads' }), { done: true });
  for (const bad of [
    { op: 'zzz' },
    { op: 'snooze', matterKey: 'gmail:t1', until: -1 },
    { op: 'dismiss', matterKey: 'a b' },
    { op: 'decisions', limit: 0 },
    { op: 'decisions', limit: 201 },
    { op: 'decisions', limit: 1.5 },
    { op: 'decisions', ids: 'gmail:t1' },
    { op: 'decisions', ids: Array(101).fill('gmail:t1') },
    { op: 'decisions', ids: ['a b'] },
    { op: 'decisions', matterKey: 'a b' },
  ])
    await assert.rejects(client.request('host.momoNotice', bad as any));
});

test('momoRunsFor gives the notice service its reading model, and does nothing when the service is absent', async (t) => {
  const w = await world(t, 'brief');
  const parts: any = {
    protocol: { startScheduled: async () => undefined, asHost: async () => undefined },
    events: new EventEmitter(),
    state: { has: () => false, get: () => null },
    harnesses: async () => [],
    report: () => undefined,
  };
  let given: any;
  w.home.provide('notice', { setModel: (m: any) => (given = m) });
  momoRunsFor(w.home, parts);
  assert.equal(given.name, 'momo-background');
  w.home.provide('notice', undefined);
  momoRunsFor(w.home, parts);
});

test('the reading turn runs in a chat of MoMo the real chats made: tagged, hidden from the coding side, isolated by the same rule, and removed', async (t) => {
  const w = await world(t, 'brief');
  const events = new EventEmitter();
  const seen: string[] = [];
  const removed: string[] = [];
  const model = createNoticeModel({
    chats: {
      main: () => ({ chatId: 'claude:main', harness: 'claude' }),
      startBackground: (h: string, tag: string) => w.home.chats.startBackground(h, tag),
      workspace: w.home.chats.workspace,
    },
    protocol: {
      startScheduled: async ({ chatId }: any) => {
        seen.push(chatId);
        events.emit('event', { key: chatId, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } });
        events.emit('event', { key: chatId, kind: 'turnEnd', stopReason: 'end_turn' });
      },
      asHost: async (method: string, p: any) => void (method === 'chat.remove' && removed.push(p.chatId)),
    },
    events,
  });
  assert.equal(await model.complete('p'), 'ok');
  assert.equal(seen.length, 1);
  assert.equal(w.home.chats.isMomoChat(seen[0]), true, 'the isolation rule that keeps MoMo chats apart applies to it');
  assert.equal(w.home.chats.isHidden(seen[0]), true);
  assert.deepEqual(removed, seen);
});

test('the notice intents, registered the way the home registers a lane: a reaction is derived from the log, settings reach the prefs, and bad arguments are refused', async (t) => {
  const w = await world(t, 'brief');
  w.threads.t1 = mailOf('t1', 'Contract', 'Please sign by Friday.');
  w.answers.push(w.answer('tell_now', 'A contract waits for your signature.'));
  await w.notice().tick();
  // the Host's own registry, made from each lane service's `intents` map (host/src/momoWiring.mjs)
  const registry = w.home.intentRegistry();
  const run = async (intent: object) => (registry.intents() as any)[(intent as any).kind](intent);
  assert.deepEqual(
    registry
      .registered()
      .filter((k: string) => ['brief.hide', 'row.notNeeded', 'settings.set', 'signal.ignore', 'signal.make'].includes(k)),
    ['brief.hide', 'row.notNeeded', 'settings.set', 'signal.ignore', 'signal.make'],
  );

  // "Not needed": the reaction carries what the home knew, not what the client says; the matter is let go
  const shown = (await w.notice().decisions({ ids: ['gmail:t1'] }))[0];
  await run({ kind: 'row.notNeeded', rowId: 'gmail:t1', decisionId: shown.decisionId });
  const [reaction] = w.home.service('notice').reactions();
  assert.deepEqual(
    [reaction.kind, reaction.matterKey, reaction.decidedBy, reaction.fromDomain],
    ['not_needed', 'gmail:t1', 'model:fake', 'acme.com'],
  );
  assert.equal((await w.notice().watching()).length, 0);
  await assert.rejects(run({ kind: 'row.notNeeded', rowId: 'gmail:nope' }), /no longer has that notice/);
  w.home.service('learning').view = () => ({
    rules: [],
    signals: [
      { id: 's1', text: 'a' },
      { id: 's2', text: 'b' },
    ],
  });
  await run({ kind: 'signal.make', id: 's1' });
  await run({ kind: 'signal.ignore', id: 's2' });
  await run({ kind: 'signal.ignore', id: 's1' }); // the first choice stands
  for (let i = 0; i < 600; i++) await assert.rejects(run({ kind: 'signal.ignore', id: `junk${i}` }), /no longer has that notice/);
  await assert.rejects(run({ kind: 'brief.hide', offerId: 'o1' }), /no longer has that notice/);
  await run({ kind: 'row.notNeeded', rowId: 'gmail:t1' }); // a second device's tap: no second reaction
  assert.deepEqual(
    w.home
      .service('notice')
      .reactions()
      .map((r: any) => [r.kind, r.rowId]),
    [
      ['not_needed', 'gmail:t1'],
      ['signal_make', 's1'],
      ['signal_ignore', 's2'],
    ],
  );
  // the registry itself checks argument types
  await assert.rejects(run({ kind: 'signal.make', id: 5 }), /not something MoMo can do/);

  // settings reach MoMo's prefs through the real prefs store
  await run({
    kind: 'settings.set',
    patch: { briefOn: true, briefTime: '09:30', quietFrom: '23:00', quietTo: '07:00', dailyCap: 3, previews: true },
  });
  const prefs = w.home.prefs.get();
  assert.deepEqual([prefs.brief.on, prefs.brief.time, prefs.notify.tellNowMax, prefs.notify.previews], [true, '09:30', 3, true]);
  assert.deepEqual(w.home.prefs.forRoutines().momo.routines.quietHours, { start: '23:00', end: '07:00' });
  for (const patch of [
    null,
    [],
    { dailyCap: 0 },
    { dailyCap: 1.5 },
    { briefTime: '25:00' },
    { quietFrom: '22:00' },
    { nonsense: true },
    { briefOn: 'yes' },
  ])
    await assert.rejects(run({ kind: 'settings.set', patch }), /MoMo can|both a start/, JSON.stringify(patch));
  await run({ kind: 'settings.set', patch: { dailyCap: 4 } });
  await run({ kind: 'settings.set', patch: { previews: false } });
  assert.deepEqual([w.home.prefs.get().notify.tellNowMax, w.home.prefs.get().notify.previews], [4, false]);
  await assert.rejects(run({ kind: 'row.notNeeded', rowId: '' }), /not something MoMo can do/);
  await run({ kind: 'settings.set', patch: { briefOn: false } });
  assert.equal(w.home.prefs.get().brief.on, false);
});

test('the offers on a shown brief are readable by id for the tasks lane, until the owner hides them; the service bound them at start', async (t) => {
  const w = await world(t, 'brief');
  const bound: any[] = [];
  w.home.service('tasks').bind = (next: any) => void bound.push(next);
  await w.home.lifecycle('start');
  assert.equal(await bound.at(-1).offers.get('o1'), null);
  const view = { offers: [{ id: 'o1', title: 'Reply to Ana', why: 'She asked twice.' }], text: 't' };
  await w.notice().seams.deliver({ id: 'brief:2026-11-24', day: '2026-11-24', text: 't', built: { view }, stamp: w.home.stamp() });
  assert.deepEqual(await bound.at(-1).offers.get('o1'), { title: 'Reply to Ana', why: 'She asked twice.' });
  assert.equal(w.notice().offer('nope'), null);
  await w.notice().intents['brief.hide']({ kind: 'brief.hide', offerId: 'o1' });
  assert.equal(await bound.at(-1).offers.get('o1'), null);
});
