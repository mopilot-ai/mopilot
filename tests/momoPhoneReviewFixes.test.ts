// Review fixes of the phone's own screens and the shared move runner: a card left from one move cannot act on the next, and a refusal's fix is followed only when it is one the phone knows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntentError } from '../shared/momoHomeApi.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createMoveRunner } from '../shared/momoMoveRunner.mjs';
import { world as homeWorld } from './support/momoHomeRealWorld.ts';

const transportPath = '../mobile/src/momoPhone/transport';
const { parseIntentResult, parseHomeView } = await import(transportPath);

/** A runner whose moves end when the test says so: each one gets the next id. */
function world() {
  const side = { call: async () => ({}), status: async () => ({ home: null }) };
  const machines: Record<string, any> = { a: { id: 'a', name: 'Studio', side }, b: { id: 'b', name: 'Mini', side } };
  let release: (r: any) => void = () => undefined;
  let n = 0;
  const runner = createMoveRunner({
    home: () => ({ id: 'a', name: 'Studio' }),
    machine: (id: string) => machines[id] ?? null,
    newId: () => `move-${++n}`.padEnd(12, '0'),
    changed: () => undefined,
    run: () => new Promise((r) => (release = r)),
  });
  return { runner, end: (r: any) => release(r), id: () => runner.view()!.moveId };
}

test('Cancel, Retry, Stay and Got it of a card drawn for one move do nothing to the next move', async () => {
  const w = world();
  await w.runner.start('b');
  const first = w.id();
  // the first move fails and is put away; the owner starts another one
  w.end({ ok: false, step: 'copied', code: 'x', message: 'Mini stopped answering.', rolledBack: true });
  await new Promise((r) => setTimeout(r, 5));
  w.runner.stay({ moveId: first });
  await w.runner.start('b');
  const second = w.id();
  assert.notEqual(first, second);
  // the stale card of the first move is refused on every button, and the second move is untouched
  for (const act of [
    () => w.runner.cancel({ moveId: first }),
    () => w.runner.stay({ moveId: first }),
    () => w.runner.acknowledge({ moveId: first }),
  ])
    assert.throws(act, /That move is over/);
  await assert.rejects(w.runner.retry({ moveId: first }), IntentError);
  assert.equal(w.runner.view()!.moveId, second);
  assert.equal(w.runner.view()!.step, 'paused');
  // the card of the move that is held still works, and so does a client that does not name the move
  assert.doesNotThrow(() => w.runner.cancel({ moveId: second }));
});

test('a client that names no move acts on the move held, as before', async () => {
  const w = world();
  await w.runner.start('b');
  assert.doesNotThrow(() => w.runner.cancel());
});

test('a refusal’s fix is followed only when it is a kind the phone knows; a fix without its id is dropped', () => {
  const refused = (fix: unknown) => parseIntentResult({ ok: false, cause: 'No.', fix, fixLabel: 'Do it' }, 1);
  assert.deepEqual(refused({ kind: 'wake' }).fix, { kind: 'wake' });
  assert.deepEqual(refused({ kind: 'fix', id: 'update-machine:m1', extra: 1 }).fix, { kind: 'fix', id: 'update-machine:m1' });
  assert.equal(refused({ kind: 'fix' }).fix, undefined, 'a fix of the view names its id');
  // anything else a home names is not an intent this phone sends on a tap
  for (const kind of ['note-forget', 'task-stop', 'approval', 'google', 'nonsense']) assert.equal(refused({ kind }).fix, undefined, kind);
});

test('a fix id with a field that cannot be decoded is refused in words, never a TypeError', async (t) => {
  const w = await homeWorld(t, { second: true });
  for (const id of ['use-older:%E0%A4%A', 'delete-older!:%E0%A4%A:studio', 'keep-older:%']) {
    const r = await w.intent({ kind: 'fix', id });
    assert.equal(r.ok, false, id);
    assert.match(r.cause, /not offered|That is not|can’t|cannot/i, id);
  }
});

test('a fresh start waits for the pick in front of it: it does not run while the pick is still being read', async (t) => {
  const w = await homeWorld(t, { second: true });
  // the first look at the Studio is held open; later ones answer at once
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => (open = r));
  let looks = 0;
  w.overrides.set('studio', (method: string) =>
    method === 'host.momoHomeLook' && ++looks === 1 ? gate.then(() => ({ holds: 'none', leaseEpoch: 0, grantLive: true })) : undefined,
  );
  const pick = w.intent({ kind: 'choose-home', machineId: 'studio' });
  await new Promise((r) => setTimeout(r, 20));
  let overDone = false;
  const over = w.real.startOver().then(() => void (overDone = true));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(overDone, false, 'the start waits behind the pick in the same queue');
  open();
  await Promise.all([pick, over]);
  assert.equal(overDone, true);
});

test('a move card that names a move, when no move is held at all, is refused as over', async () => {
  const w = world();
  for (const act of [
    () => w.runner.cancel({ moveId: 'gone' }),
    () => w.runner.stay({ moveId: 'gone' }),
    () => w.runner.acknowledge({ moveId: 'gone' }),
  ])
    assert.throws(act, /That move is over/);
});

/** Every `fix: { kind: '…' }` a Host, the Mac's service or the shared home can put in a refusal, read from their sources. */
function hostFixKinds(): { kind: string; intent?: string }[] {
  const found = new Map<string, { kind: string; intent?: string }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(mjs|cjs)$/.test(name))
        for (const m of readFileSync(file, 'utf8').matchAll(/fix: \{ kind: '([a-z-]+)'(?:, intent: '([a-z-]+)')?/g))
          found.set(`${m[1]}:${m[2] ?? ''}`, { kind: m[1], intent: m[2] });
    }
  };
  for (const dir of ['shared', 'host/src', 'electron/momo']) walk(path.resolve(import.meta.dirname, '..', dir));
  return [...found.values()];
}

test('every fix a Host can offer in a refusal is one the phone follows, so a new Host fix cannot be dropped silently', () => {
  const kinds = hostFixKinds();
  assert.ok(
    kinds.some((k) => k.kind === 'fix') && kinds.some((k) => k.kind === 'google'),
    'the scan sees the shared home’s and the Google lane’s fixes',
  );
  for (const k of kinds) {
    const fix =
      k.kind === 'fix'
        ? { kind: 'fix', id: 'update-machine:m1' }
        : k.kind === 'google'
          ? { kind: 'google', intent: k.intent, client: 'ios' }
          : { kind: k.kind };
    const got = parseIntentResult({ ok: false, cause: 'No.', fix, fixLabel: 'Do it' }, 1);
    assert.ok(got.fix, `${k.kind} ${k.intent ?? ''} is followed`);
  }
  // the Google lane's two, and only the intents the phone can run
  assert.deepEqual(refusedGoogle('reconnect'), { kind: 'google', intent: 'reconnect' });
  assert.deepEqual(refusedGoogle('remove'), { kind: 'google', intent: 'remove' });
  assert.equal(refusedGoogle('explode'), undefined);
});
const refusedGoogle = (intent: string) =>
  parseIntentResult({ ok: false, cause: 'No.', fix: { kind: 'google', intent, client: 'ios' }, fixLabel: 'x' }, 1).fix;

test('a brief from a Host that sends no offers keeps its card, and a list is read only up to a sane size', () => {
  const view = (patch: (v: any) => void) => {
    const v: any = { home: { state: 'running' }, chat: [], tasks: [], notes: [], rules: [], signals: [], problems: [] };
    patch(v);
    return parseHomeView({ view: v }, 1).view;
  };
  const brief = view((v) => v.chat.push({ kind: 'brief', id: 'b', at: 1, brief: { overnight: {}, day: 'd', greeting: 'Hi' } })).chat[0]
    .brief;
  assert.deepEqual(brief.offers, []);
  const offered = view((v) =>
    v.chat.push({
      kind: 'brief',
      id: 'b',
      at: 1,
      brief: { overnight: {}, offers: [{ id: 'o' }, { id: 'o2', title: 'T' }, { id: 'o3', title: 'U', why: 'Because.' }] },
    }),
  ).chat[0].brief;
  assert.deepEqual(offered.offers, [
    { id: 'o2', title: 'T', why: '' },
    { id: 'o3', title: 'U', why: 'Because.' },
  ]);
  // 600 rows: the newest 500 of a chat, the first 500 of a list
  const many = view((v) => {
    v.chat = Array.from({ length: 600 }, (_, i) => ({ kind: 'user', id: `u${i}`, at: i, text: 'x' }));
    v.tasks = Array.from({ length: 600 }, (_, i) => ({ id: `t${i}`, title: 't', state: 'working' }));
  });
  assert.deepEqual([many.chat.length, many.chat[0].id, many.chat.at(-1).id], [500, 'u100', 'u599']);
  assert.equal(many.tasks.length, 500);
});
