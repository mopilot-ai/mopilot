// MoMo's routine tool in the capability registry (electron/momo/routineTools.cjs, #2285): momo_routine_propose only for MoMo's main chat while MoMo is allowed (not a routine's run or a coding chat; a segment its chat doesn't own is refused in the handler), on every harness family alike; a time with days or an RRULE becomes the routine's schedule; the proposal waits unapproved in Settings › MoMo › Routines and the result tells the model the user approves it there; each refusal reaches the model by its code.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, FAMILIES, chatIdOf } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerRoutineTools, proposedText } = require('../electron/momo/routineTools.cjs');
const { RoutineError } = require('../shared/momoRoutine.mjs');

const ASK = { name: 'Files check', prompt: 'Tell me if anything in my Files folder changed.', time: '09:00', sources: ['files'] };

function setup(o: { routines?: any; owner?: (ctx: any) => string | null; connected?: string[] } = {}) {
  const w = world();
  const meta = new Map<string, any>([
    ['momo-main', { momo: 'main' }],
    ['run1', { momo: 'routine', routineId: 'momo.r1' }],
    ['previous', { momo: 'previous' }],
  ]);
  let allowed = true;
  const told: string[] = [];
  const registry = new Registry();
  registry.register({ name: 'other_tool', policy: 'observe', handler: () => 'other' });
  const off = registerRoutineTools(registry, {
    routines: o.routines ?? w.service,
    allowed: () => allowed,
    chatMeta: (id: string) => meta.get(id) ?? null,
    owner: o.owner ?? ((ctx: any) => ctx.chatId),
    connected: () => o.connected ?? [],
    changed: () => told.push('changed'),
  });
  const call = (args: any, chatId = 'momo-main', segmentId = 'claude:s1') =>
    registry.invoke(chatId, segmentId, 'momo_routine_propose', args);
  const text = (r: any) => r.content.map((c: any) => c.text).join('');
  return { w, meta, registry, off, call, text, told, setAllowed: (v: boolean) => (allowed = v) };
}

test('only MoMo’s main chat sees it, only while MoMo is allowed; it acts without a card, since Settings’ Approve is the approval', async () => {
  const { registry, setAllowed, off } = setup();
  const names = (chatId: string | null) => registry.list({ chatId }).map((t: any) => t.name);
  assert.deepEqual(names('momo-main'), ['other_tool', 'momo_routine_propose']);
  for (const chat of ['run1', 'previous', 'coding', null]) assert.deepEqual(names(chat), ['other_tool'], String(chat));
  setAllowed(false);
  assert.deepEqual(names('momo-main'), ['other_tool']);
  const [tool] = registry.list({ all: true }).filter((t: any) => t.name === 'momo_routine_propose');
  assert.equal(tool.policy, 'act');
  assert.match(tool.description, /waits in Settings › MoMo › Routines until the user approves it there/);
  assert.deepEqual(Object.keys(tool.inputSchema?.properties ?? tool.schema.properties), [
    'name',
    'prompt',
    'time',
    'days',
    'rrule',
    'sources',
  ]);
  off();
  assert.deepEqual(
    registry.list({ all: true }).map((t: any) => t.name),
    ['other_tool'],
  );
  // registered without a way to tell a call's chat: no call runs
  const bare = new Registry();
  registerRoutineTools(bare, {
    routines: { propose: () => assert.fail('proposed') },
    allowed: () => true,
    chatMeta: () => ({ momo: 'main' }),
    connected: () => [],
    changed: () => assert.fail('told'),
  });
  assert.equal((await bare.invoke('momo-main', 'claude:s1', 'momo_routine_propose', ASK)).error.code, 'unavailable');
});

test('a proposal from MoMo’s main chat on each harness family waits unapproved, and the model is told the user approves it in Settings', async () => {
  for (const harness of FAMILIES) {
    const { w, meta, call, text, told } = setup({ connected: ['files'] });
    // the main chat by its own harness's chat id, its call from that harness's segment
    const chatId = chatIdOf(harness, 1);
    meta.set(chatId, { momo: 'main' });
    const r = await call(ASK, chatId, `${harness}:segment-1`);
    assert.equal(r.ok, true, harness);
    const [routine] = w.routines.list();
    assert.deepEqual(
      [routine.name, routine.rrule, routine.sources, routine.approved],
      ['Files check', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', ['files'], false],
    );
    assert.equal((await w.service.list()).find((t: any) => t.id === routine.id).status, 'PAUSED', 'it doesn’t run before Approve');
    assert.equal(
      text(r),
      `Proposed the routine “Files check” (Every day at 9; reads Files). It waits in Settings › MoMo › Routines and runs only after the user approves it there. Tell the user in a line; don't ask them to approve it in this chat.`,
    );
    assert.deepEqual(told, ['changed'], 'Settings reads again');
    // asked again (a retried or corrected call): the one waiting takes it, and the model is told what now waits
    assert.match(text(await call({ ...ASK, time: '10:30' })), /\(Every day at 10:30; reads Files\)/);
    assert.deepEqual(
      w.routines.list().map((x: any) => x.rrule),
      ['FREQ=DAILY;BYHOUR=10;BYMINUTE=30;BYSECOND=0'],
    );
  }
});

test('the schedule: days make it weekly, all seven daily, an RRULE as given; sources not connected yet are said', async () => {
  const { w, call, text } = setup({ connected: ['calendar'] });
  const weekly = await call({ ...ASK, name: 'Weekdays', days: ['FR', 'monday', 'Wednesday'], sources: ['calendar', 'reminders', 'files'] });
  assert.match(text(weekly), /Reminders, Files aren't connected yet: the user connects them in Settings › MoMo › Sources\./);
  const one = await call({ ...ASK, name: 'One', sources: ['files'] });
  assert.match(text(one), / Files isn't connected yet: the user connects it in Settings › MoMo › Sources\. Tell the user/);
  await call({ name: 'All week', prompt: 'p', time: '7:05', days: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] });
  await call({ name: 'Monthly', prompt: 'p', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9', days: [] });
  assert.match(text(await call({ name: 'Bare', prompt: 'p', time: '08:00' })), /^Proposed the routine “Bare” \(Every day at 8\)\./);
  assert.deepEqual(
    w.routines.list().map((r: any) => [r.name, r.rrule, r.sources]),
    [
      ['Weekdays', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0', ['calendar', 'reminders', 'files']],
      ['One', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', ['files']],
      ['All week', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=5;BYSECOND=0', []],
      ['Monthly', 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9', []],
      ['Bare', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0', []],
    ],
  );
});

test('what can’t be a routine is refused by its code and keeps nothing: the schedule, the store’s checks, a chat that isn’t MoMo’s main one', async () => {
  const { w, call, told } = setup({ owner: (ctx: any) => (ctx.segmentId === 'claude:stale' ? null : ctx.chatId) });
  const refused = async (args: any, pattern: RegExp, code = 'bad_args', chatId?: string, segmentId?: string) => {
    const r = await call(args, chatId, segmentId);
    assert.deepEqual([r.ok, r.error.code], [false, code], pattern.source);
    assert.match(r.error.message, pattern);
  };
  await refused({ name: 'x', prompt: 'p' }, /Give the schedule: a time \("09:00"\)/);
  await refused({ name: 'x', prompt: 'p', rrule: 'FREQ=DAILY', time: '09:00' }, /either an RRULE or a time with days, not both/);
  await refused({ name: 'x', prompt: 'p', rrule: 'FREQ=DAILY', days: ['MO'] }, /not both/);
  await refused({ name: 'x', prompt: 'p', time: '25:00' }, /Not a time: 25:00\. Use 24-hour HH:MM\./);
  await refused({ name: 'x', prompt: 'p', time: '09:00', days: ['someday'] }, /Days are MO, TU, WE, TH, FR, SA, SU\./);
  await refused({ name: 'x', prompt: 'p', rrule: 'FREQ=MINUTELY' }, /at most hourly/);
  await refused({ name: '', prompt: 'p', time: '09:00' }, /name is 1 to 80/);
  await refused({ ...ASK, sources: ['mail'] }, /sources are some of/);
  await refused(ASK, /momo_routine_propose is unavailable in this chat/, 'unavailable', 'run1');
  await refused(ASK, /only in MoMo’s main chat/, 'unavailable', 'momo-main', 'claude:stale');
  assert.deepEqual([w.routines.list(), told], [[], []]);
});

test('a service refusal reaches the model by its code: MoMo turned off meanwhile, encryption unavailable, anything else as failed', async () => {
  const thrown: any[] = [
    Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' }),
    Object.assign(new Error('Encryption is unavailable'), { code: 'unavailable' }),
    new RoutineError('MoMo keeps at most 50 routines', 'full'),
    new Error('disk full'),
  ];
  const { call } = setup({ routines: { propose: async () => Promise.reject(thrown.shift()) } });
  const errors: any[] = [];
  for (let i = 0; i < 4; i++) errors.push((await call(ASK)).error);
  assert.deepEqual(errors, [
    { code: 'not_allowed', message: 'MoMo is not available for this account.' },
    { code: 'unavailable', message: 'Encryption is unavailable.' },
    { code: 'full', message: 'MoMo keeps at most 50 routines' },
    { code: 'failed', message: 'The routine could not be proposed: Disk full.' },
  ]);
});

test('the result text names the schedule and sources it was given', async () => {
  const text = `Proposed the routine “R” (Every week on Monday at 9). It waits in Settings › MoMo › Routines and runs only after the user approves it there. Tell the user in a line; don't ask them to approve it in this chat.`;
  assert.equal(proposedText({ name: 'R', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9' }, []), text);
  // the one waiting under that name was kept before routines named sources: none are said
  const old = setup({ routines: { propose: async () => ({ name: 'R', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9' }) } });
  assert.equal(old.text(await old.call({ ...ASK, name: 'R' })), text);
});
