// IPC for Settings › MoMo › Routines (electron/momo/routinesIpc.cjs, electron/bridge/momoRoutines.cjs, #2139): every call refused unless MoMo is allowed; the view with the routines MoMo proposed (what each will do and when), the user's routines and the sources they may read; approving a proposal of the version shown, editing, pausing, declining and removing, stored and told to the windows.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, sweep } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { registerRoutinesIpc, proposalsOf, routinesOf, patchOf } = require('../electron/momo/routinesIpc.cjs');
const bridge = require('../electron/bridge/momoRoutines.cjs');
const { invoke, on } = require('../electron/bridge/spec.cjs');

function rig() {
  const w = world();
  const handlers = new Map<string, Function>();
  const told: string[] = [];
  let allowed = true;
  const ipc = registerRoutinesIpc({ handle: (ch: string, fn: Function) => handlers.set(ch, fn) } as any, {
    routines: w.routines,
    service: w.service,
    allowed: () => allowed,
    broadcast: (ch: string) => told.push(ch),
  });
  const ask = (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args);
  return { w, handlers, told, ask, ipc, setAllowed: (v: boolean) => (allowed = v) };
}

test('every call is refused unless MoMo is allowed, and changes nothing', async () => {
  const r = rig();
  r.setAllowed(false);
  for (const ch of ['momoRoutines:view', 'momoRoutines:approve', 'momoRoutines:edit', 'momoRoutines:remove'])
    assert.throws(
      () => r.ask(ch, 'x', 'more'),
      (e: any) => e.code === 'not_allowed' && /not available for this account/.test(e.message),
      ch,
    );
  assert.deepEqual(r.told, []);
});

test('the view: proposals with what they will do and when, the user’s routines with their form parts, and the sources', async () => {
  const r = rig();
  const a = await r.w.routines.add({ ...sweep, sources: ['files'] }, { approved: true });
  const b = await r.w.routines.add({ ...sweep, name: 'Rent', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9' }, { approved: true });
  await r.w.routines.update(b.id, { status: 'PAUSED' });
  const proposed = await r.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  const view = await r.ask('momoRoutines:view');
  // a proposal is never approved blind: what it will do, and when
  assert.deepEqual(view.proposals, [
    { id: proposed.id, name: 'Proposed', prompt: sweep.prompt, schedule: 'Every day at 9', sources: '', rev: 1 },
  ]);
  assert.deepEqual(view.routines, [
    {
      id: a.id,
      name: 'Inbox sweep',
      prompt: sweep.prompt,
      schedule: 'Every day at 9',
      rrule: sweep.rrule,
      parts: { time: '09:00', days: [] },
      sources: ['files'],
      paused: false,
    },
    {
      id: b.id,
      name: 'Rent',
      prompt: sweep.prompt,
      schedule: 'Every month on the 1st at 9',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9',
      parts: null,
      sources: [],
      paused: true,
    },
  ]);
  assert.deepEqual(view.sources, [
    { id: 'calendar', label: 'Calendar' },
    { id: 'reminders', label: 'Reminders' },
    { id: 'files', label: 'Files' },
  ]);
  // what a proposal reads, by name; no cap on how many wait
  const reads = await r.w.routines.add({ ...sweep, name: 'Reads', sources: ['calendar', 'files'] }, { approved: false });
  assert.equal((await r.ask('momoRoutines:view')).proposals.find((p: any) => p.id === reads.id).sources, 'Calendar, Files');
  assert.equal(proposalsOf(Array.from({ length: 12 }, (_, i) => ({ ...sweep, id: `p${i}`, approved: false }))).length, 12);
  // a proposal with no version (kept before versions) reads as 0; one kept before routines named sources reads none
  assert.equal(proposalsOf([{ ...sweep, id: 'p', approved: false }])[0].rev, 0);
  assert.deepEqual(routinesOf([{ ...a, sources: undefined }])[0].sources, []);
});

test('approval names the version shown: none, or a version MoMo changed since, is refused and approves nothing; the windows hear a change', async () => {
  const r = rig();
  const proposed = await r.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  await assert.rejects(r.ask('momoRoutines:approve', proposed.id), (e: any) => e.code === 'bad_args');
  const card = (await r.ask('momoRoutines:view')).proposals[0];
  assert.equal(card.rev, 1);
  await r.w.routines.add({ ...sweep, name: 'Proposed', sources: ['files'] }, { approved: false });
  await assert.rejects(
    r.ask('momoRoutines:approve', proposed.id, card.rev),
    (e: any) => e.code === 'changed' && /“Proposed” changed since you saw it/.test(e.message),
  );
  assert.equal(r.w.routines.get(proposed.id).approved, false);
  assert.deepEqual(r.told, []);
  const approved = await r.ask('momoRoutines:approve', proposed.id, 2);
  assert.equal(approved.approved, true);
  assert.deepEqual((await r.ask('momoRoutines:view')).proposals, []);
  assert.equal(await r.ask('momoRoutines:approve', 'momo.gone', 1), null);
  assert.deepEqual(r.told, ['momoRoutines:changed'], 'a routine that is gone tells nothing');
  r.ipc.changed();
  assert.deepEqual(r.told, ['momoRoutines:changed', 'momoRoutines:changed']);
});

test('Pause, Resume and Edit: the user’s change is kept (a new schedule or a resume counts from now), never an approval; a bad one is refused', async () => {
  const r = rig();
  const a = await r.w.routines.add(sweep, { approved: true });
  r.w.c.t += 1000;
  assert.equal((await r.ask('momoRoutines:edit', a.id, { paused: true })).status, 'PAUSED');
  assert.equal((await r.ask('momoRoutines:view')).routines[0].paused, true);
  r.w.c.t += 1000;
  const resumed = await r.ask('momoRoutines:edit', a.id, { paused: false });
  assert.deepEqual([resumed.status, resumed.scheduleFrom], ['ACTIVE', r.w.c.t]);
  const edited = await r.ask('momoRoutines:edit', a.id, {
    name: 'Weekday sweep',
    prompt: 'Only the urgent ones.',
    time: '07:30',
    days: ['MO', 'FR'],
    sources: ['calendar'],
  });
  assert.deepEqual(
    [edited.name, edited.prompt, edited.rrule, edited.sources, edited.approved],
    ['Weekday sweep', 'Only the urgent ones.', 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=7;BYMINUTE=30;BYSECOND=0', ['calendar'], true],
  );
  assert.equal(
    (await r.ask('momoRoutines:edit', a.id, { rrule: 'FREQ=MONTHLY;BYMONTHDAY=2;BYHOUR=9' })).rrule,
    'FREQ=MONTHLY;BYMONTHDAY=2;BYHOUR=9',
  );
  // an edit is never an approval: a proposal edited stays a proposal
  const p = await r.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  assert.equal((await r.ask('momoRoutines:edit', p.id, { approved: true, name: 'Still proposed' })).approved, false);
  assert.equal(r.told.length, 5);
  await assert.rejects(
    r.ask('momoRoutines:edit', a.id, { time: '25:00' }),
    (e: any) => e.code === 'bad_args' && /Not a time/.test(e.message),
  );
  await assert.rejects(r.ask('momoRoutines:edit', a.id, { sources: ['mail'] }), (e: any) => e.code === 'bad_args');
  await assert.rejects(r.ask('momoRoutines:edit', a.id, { rrule: 'FREQ=MINUTELY' }), (e: any) => e.code === 'bad_args');
  assert.equal(await r.ask('momoRoutines:edit', 'momo.gone', { paused: true }), null);
  assert.equal(r.told.length, 5, 'a refusal or a routine gone tells nothing');
  assert.deepEqual(patchOf(null), {});
  assert.deepEqual(patchOf({ paused: 'yes' }), {}, 'only a yes or no pauses');
  assert.ok(r.told.every((ch: string) => ch === 'momoRoutines:changed'));
});

test('Decline and Remove: the routine and its run history go, and the windows hear it; one gone is false and tells nothing', async () => {
  const r = rig();
  const proposed = await r.w.service.propose({ ...sweep, name: 'Proposed' });
  const approved = await r.w.routines.add({ ...sweep, name: 'Kept' }, { approved: true });
  assert.equal(await r.ask('momoRoutines:remove', proposed.id), true);
  const view = await r.ask('momoRoutines:view');
  assert.deepEqual([view.proposals, view.routines.map((x: any) => x.name)], [[], ['Kept']]);
  assert.equal(await r.ask('momoRoutines:remove', approved.id), true);
  assert.deepEqual((await r.ask('momoRoutines:view')).routines, []);
  assert.deepEqual(r.w.chats, [
    ['forget', proposed.id],
    ['forget', approved.id],
  ]);
  assert.equal(r.told.length, 2);
  assert.equal(await r.ask('momoRoutines:remove', 'momo.gone'), false);
  assert.equal(r.told.length, 2);
});

test('the bridge declares each call with the arguments it forwards', () => {
  assert.deepEqual(bridge, {
    view: invoke('momoRoutines:view'),
    approve: invoke('momoRoutines:approve', 2),
    edit: invoke('momoRoutines:edit', 2),
    runNow: invoke('momoRoutines:runNow', 1),
    history: invoke('momoRoutines:history', 1),
    remove: invoke('momoRoutines:remove', 1),
    onChanged: on('momoRoutines:changed'),
  });
});
