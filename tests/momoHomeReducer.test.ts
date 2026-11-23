// What each user move does to MoMo's home view (src/components/momo/home/homeReducer.ts, homeSeam.ts, homeFixtures.ts): every action, the move's steps, and the fixture seam that answers while no home does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceMove, failMove, reduceHome } from '../src/components/momo/home/homeReducer.ts';
import { fixtureView, scenarioView } from '../src/components/momo/home/homeFixtures.ts';
import { createFixtureSeam, momoHomeSeam, setMomoHomeSeam } from '../src/components/momo/home/homeSeam.ts';
import type { MomoHomeAction } from '../src/components/momo/home/homeActions.ts';

const NOW = 1_000;
const run = (a: MomoHomeAction, v = fixtureView()) => reduceHome(v, a, NOW);
const approval = (v: ReturnType<typeof fixtureView>) => v.chat.flatMap((r) => (r.kind === 'approval' ? [r.approval] : []))[0];

test('setup walks where → read → reach → done and records the choices', () => {
  let v = scenarioView('first-run');
  v = run({ type: 'setup.choose', machineId: 'this-mac' }, v);
  assert.equal(v.home.machineName, 'This Mac');
  assert.deepEqual(
    v.home.machines.filter((m) => m.isHome).map((m) => m.machineId),
    ['this-mac'],
  );
  assert.equal(v.setup.step, 'read');
  for (const step of ['reach', 'done'] as const) {
    v = run({ type: 'setup.next' }, v);
    assert.equal(v.setup.step, step);
  }
  assert.equal(run({ type: 'setup.open' }).setup.step, 'read');
  assert.equal(run({ type: 'setup.google', to: 'waiting' }).setup.google, 'waiting');
  assert.equal(run({ type: 'setup.notifications', to: 'denied' }).setup.notifications, 'denied');
});

test('a move goes through its steps, lands on the target, and can fail, retry, cancel or be dismissed', () => {
  let v = run({ type: 'move.start', machineId: 'this-mac' });
  assert.equal(v.home.state, 'moving');
  assert.equal(v.home.move?.step, 'paused');
  assert.equal(v.home.move?.to.name, 'This Mac');
  v = advanceMove(v, NOW);
  assert.equal(v.home.move?.step, 'sealed');
  const failed = failMove(v, 'Mac stopped answering.', NOW);
  assert.equal(failed.home.move?.failure?.failedAt, 'sealed');
  assert.equal(failed.home.move?.outcome, 'failed');
  assert.equal(run({ type: 'move.retry' }, failed).home.move?.outcome, 'running');
  assert.equal(advanceMove(failed, NOW).home.move?.step, 'sealed');
  assert.equal(run({ type: 'move.retry' }, failed).home.move?.failure, null);
  assert.equal(run({ type: 'move.cancel' }, failed).home.move, null);
  assert.equal(run({ type: 'move.dismiss' }, failed).home.state, 'running');
  for (let i = 0; i < 4; i++) v = advanceMove(v, NOW);
  assert.equal(v.home.move?.step, 'cleaning-up');
  v = advanceMove(v, NOW);
  assert.equal(v.home.move, null);
  assert.equal(v.home.machineName, 'This Mac');
  assert.equal(v.home.homeMachineId, 'this-mac');
  assert.equal(v.home.leaseEpoch, 2);
  assert.equal(v.home.state, 'running');
  // without a move there is nothing to advance, fail or retry
  assert.equal(advanceMove(fixtureView(), NOW).home.move, null);
  assert.equal(failMove(fixtureView(), 'x', NOW).home.move, null);
  assert.equal(run({ type: 'move.retry' }).home.move, null);
});

test('a move that finishes while the old machine is offline keeps its outcome until it is dismissed', () => {
  const v = fixtureView();
  v.home.machines = v.home.machines.map((m) => (m.machineId === 'studio' ? { ...m, status: 'offline' } : m));
  let m = run({ type: 'move.start', machineId: 'this-mac' }, v);
  for (let i = 0; i < 6; i++) m = advanceMove(m, NOW);
  assert.equal(m.home.state, 'running');
  assert.equal(m.home.move?.outcome, 'moved');
  assert.equal(m.home.move?.oldMachineOffline, true);
  assert.equal(run({ type: 'move.dismiss' }, m).home.move, null);
});

test('a fix is addressed by its id: it clears the problem, the agent problem or the failed task that offered it, and nothing else', () => {
  const v = scenarioView('signed-out');
  v.problems = [
    {
      id: 'push:1',
      code: 'notifications_off',
      cause: 'Notifications are off.',
      fix: { id: 'open_settings', label: 'Open Settings' },
      since: null,
    },
  ];
  const fixed = run({ type: 'fix.run', id: 'open_settings' }, v);
  assert.equal(fixed.problems.length, 0);
  assert.equal(fixed.home.state, 'needs-sign-in');
  const signed = run({ type: 'fix.run', id: 'sign-in-agent:studio:Claude Code' }, v);
  assert.equal(signed.home.state, 'running');
  assert.equal(signed.home.agentProblem, null);
  assert.equal(signed.problems.length, 1);
  assert.equal(run({ type: 'fix.run', id: 'nothing' }, v).home.agentProblem?.kind, 'signed-out');
});

test('waking, updating and signing in clear the home’s problem; a machine can be set up or updated', () => {
  for (const type of ['home.wake', 'home.useOtherAgent'] as const) {
    const v = run({ type }, scenarioView('signed-out'));
    assert.equal(v.home.state, 'running');
    assert.equal(v.home.agentProblem, null);
  }
  const v = run({ type: 'machine.update', machineId: 'mac-mini' });
  assert.equal(v.home.machines.find((m) => m.machineId === 'mac-mini')?.status, 'online');
  assert.equal(run({ type: 'machine.setUp', machineId: 'cloud' }).home.machines.find((m) => m.machineId === 'cloud')?.status, 'online');
  assert.equal(run({ type: 'machine.setUp', machineId: 'nope' }).home.machines.length, 4);
  // an unknown machine id is shown as is
  assert.equal(run({ type: 'move.start', machineId: 'ghost' }).home.move?.to.name, 'ghost');
});

test('chat: a message is not sent while the home sleeps; check, brief hide and start', () => {
  assert.equal(
    run({ type: 'chat.send', turnId: 't1', text: 'hi' }).chat.at(-1)?.kind === 'user' &&
      (run({ type: 'chat.send', turnId: 't1', text: 'hi' }).chat.at(-1) as any).delivery,
    'accepted',
  );
  const asleep = run({ type: 'chat.send', turnId: 't2', text: 'later' }, scenarioView('asleep'));
  const row: any = asleep.chat.at(-1);
  assert.equal(row.delivery, 'queued');
  const checked: any = run({ type: 'chat.check', rowId: row.id }, asleep).chat.at(-1);
  assert.equal(checked.delivery, 'accepted');
  const hidden: any = run({ type: 'brief.hide', offerId: 'offer-1' }).chat.find((r) => r.kind === 'brief');
  assert.equal(hidden.brief.offers.length, 0);
  const started = run({ type: 'brief.start', offerId: 'offer-1' });
  assert.equal(started.chat.at(-1)?.kind, 'user');
});

test('approval: send, edit, deny and ask again change only that card; Not needed proposes a rule that Undo takes back', () => {
  assert.equal(approval(run({ type: 'approval.send', id: 'card-1' })).status, 'completed');
  assert.equal(approval(run({ type: 'approval.deny', id: 'card-1' })).status, 'denied');
  assert.equal(approval(run({ type: 'approval.deny', id: 'card-1' })).canAskAgain, true);
  assert.equal(approval(run({ type: 'approval.edit', id: 'card-1', body: 'new' })).body, 'new');
  const denied = run({ type: 'approval.deny', id: 'card-1' });
  assert.equal(approval(run({ type: 'approval.askAgain', id: 'card-1' }, denied)).status, 'pending');
  assert.equal(approval(run({ type: 'approval.send', id: 'other' })).status, 'pending');
  const marked = run({ type: 'row.notNeeded', rowId: 'a2' });
  const row: any = marked.chat.find((r) => r.id === 'a2');
  assert.equal(row.notNeeded.suggestion.ruleId, 'r-deliveries');
  // a row that offers no "Not needed", or another row, stays as it was
  assert.equal((run({ type: 'row.notNeeded', rowId: 'a1' }).chat.find((r) => r.id === 'a1') as any).notNeeded, null);
  assert.equal((run({ type: 'row.notNeeded', rowId: 'zzz' }).chat.find((r) => r.id === 'a2') as any).notNeeded.suggestion, null);
  const undone = run({ type: 'rule.undo', id: 'r-deliveries' }, marked);
  assert.equal(undone.rules.find((r) => r.id === 'r-deliveries')?.state, 'undone');
  assert.equal((undone.chat.find((r) => r.id === 'a2') as any).notNeeded, null);
  // undoing another rule leaves the suggestion alone
  assert.ok((run({ type: 'rule.undo', id: 'r-clients' }, marked).chat.find((r) => r.id === 'a2') as any).notNeeded.suggestion);
});

test('tasks: stop, retry, run elsewhere, fix the agent, stop watching', () => {
  const t = (v: ReturnType<typeof fixtureView>, id: string) => v.tasks.find((x) => x.id === id);
  assert.equal(t(run({ type: 'task.stop', id: 't-quote' }), 't-quote')?.state, 'stopped');
  assert.equal(t(run({ type: 'task.retry', id: 't-failed' }), 't-failed')?.failure, null);
  const moved = t(run({ type: 'task.runElsewhere', id: 't-failed', machineId: 'studio' }), 't-failed');
  assert.equal(moved?.where.machine.name, 'Studio');
  assert.equal(t(run({ type: 'fix.run', id: 'install-agent:mac-mini:Codex' }), 't-missing')?.state, 'working');
  assert.equal(t(run({ type: 'task.stopWatching', id: 't-aws' }), 't-aws'), undefined);
  assert.equal(t(run({ type: 'task.stop', id: 'nope' }), 't-quote')?.state, 'working');
});

test('notes: edit becomes Confirmed, Undo and Restore drop the change, Forget deletes, a written note is Confirmed, sources reconnect or go', () => {
  const edited = run({ type: 'note.edit', noteId: 'n-acme', lineId: 'l-2', text: 'Due Friday' });
  const line = edited.notes[0].lines.find((l) => l.id === 'l-2');
  assert.equal(line?.status, 'confirmed');
  assert.equal(line?.text, 'Due Friday');
  assert.equal(edited.notes[0].lines[0].status, 'learned');
  assert.equal(run({ type: 'note.undo', noteId: 'n-acme', changeId: 'c-1' }).notes[0].lastChange, null);
  const other = run({ type: 'note.undo', noteId: 'n-acme', changeId: 'c-2' }).notes[0];
  assert.ok(other.lastChange);
  assert.equal(other.history.length, 1);
  const restored = run({ type: 'note.restore', noteId: 'n-acme' }).notes[0];
  assert.equal(restored.lastChange, null);
  assert.equal(restored.history.length, 1);
  assert.equal(run({ type: 'note.restore', noteId: 'n-dana' }).notes[1].history.length, 0);
  assert.equal(run({ type: 'note.forget', noteId: 'n-acme' }).notes.length, 2);
  const written = run({ type: 'note.write', title: 'Plans', text: 'Move in March' }).notes.at(-1);
  assert.equal(written?.lines[0].status, 'confirmed');
  const gone = scenarioView('source-gone');
  assert.equal(run({ type: 'source.reconnect', id: 'gmail' }, gone).home.sources[0].status, 'ok');
  assert.equal(run({ type: 'source.remove', id: 'gmail' }, gone).home.sources.length, 1);
});

test('rules: add, edit marks it yours, turn off and on, signals become rules or go', () => {
  const added = run({ type: 'rule.add', text: 'Invoices → ask me', effect: 'ask_first' }).rules.at(-1);
  assert.equal(added?.origin, 'yours');
  assert.equal(added?.kind, 'does-more');
  assert.equal(run({ type: 'rule.add', text: 'x', effect: 'stay_quiet' }).rules.at(-1)?.kind, 'quieter');
  const edited = run({ type: 'rule.edit', id: 'r-deliveries', text: 'Shop mail → tell me', effect: 'tell_now', inBrief: false }).rules.find(
    (r) => r.id === 'r-deliveries',
  );
  assert.deepEqual([edited?.origin, edited?.kind, edited?.effect, edited?.inBrief], ['yours', 'does-more', 'tell_now', false]);
  assert.equal(
    run({ type: 'rule.edit', id: 'r-deliveries', text: 'q', effect: 'stay_quiet', inBrief: true }).rules.find(
      (r) => r.id === 'r-deliveries',
    )?.kind,
    'quieter',
  );
  const off = run({ type: 'rule.turnOff', id: 'r-clients' });
  assert.equal(off.rules.find((r) => r.id === 'r-clients')?.state, 'off');
  assert.equal(run({ type: 'rule.accept', id: 'r-clients' }, off).rules.find((r) => r.id === 'r-clients')?.state, 'on');
  const made = run({ type: 'signal.make', id: 'sig-1' });
  assert.equal(made.signals.length, 0);
  assert.equal(made.rules.length, 5);
  assert.equal(run({ type: 'signal.make', id: 'nope' }).rules.length, 4);
  assert.equal(run({ type: 'signal.ignore', id: 'sig-1' }).rules.length, 4);
  assert.equal(run({ type: 'signal.ignore', id: 'sig-1' }).signals.length, 0);
});

test('settings: a patch changes only the fields it names', () => {
  const v = run({
    type: 'settings.set',
    patch: { briefOn: false, briefTime: '7:00 AM', quietFrom: '9:00 PM', quietTo: '7:00 AM', dailyCap: 3, previews: true },
  });
  assert.deepEqual(v.settings, {
    brief: { on: false, time: '7:00 AM' },
    quietHours: { from: '9:00 PM', to: '7:00 AM' },
    dailyCap: 3,
    previews: true,
  });
  assert.deepEqual(run({ type: 'settings.set', patch: {} }).settings, fixtureView().settings);
});

test('every named scenario is a distinct view', () => {
  const names = [
    'first-run',
    'asleep',
    'needs-update',
    'signed-out',
    'not-installed',
    'move-failed',
    'empty',
    'source-gone',
    null,
    'unknown',
  ];
  const states = names.map((n) => JSON.stringify(scenarioView(n)));
  assert.equal(new Set(states).size, 9);
  assert.equal(scenarioView(null).setup.step, 'done');
});

test('the fixture seam answers moves, tells subscribers, plays the home’s own steps, and an installed seam is the one used', async () => {
  const seam = createFixtureSeam(fixtureView(), () => 7);
  const seen: string[] = [];
  const stop = seam.subscribe((v) => seen.push(v.home.state));
  assert.deepEqual(await seam.act({ type: 'move.start', machineId: 'this-mac' }), { ok: true });
  assert.deepEqual(seen, ['moving']);
  const first = await seam.read();
  assert.ok(first.ok && first.view.home.state === 'moving');
  seam.script((v, now) => advanceMove(v, now));
  assert.equal(seen.length, 2);
  stop();
  await seam.act({ type: 'move.cancel' });
  assert.equal(seen.length, 2);
  const mine = createFixtureSeam();
  setMomoHomeSeam(mine);
  assert.equal(await momoHomeSeam(), mine);
  setMomoHomeSeam(null);
});

test('reclaiming takes the home back at a higher lease and ends the move', () => {
  const failed = failMove(run({ type: 'move.start', machineId: 'this-mac' }), 'Studio stopped answering.', NOW);
  const back = run({ type: 'home.reclaim', moveId: 'm', toId: 'this-mac' }, failed);
  assert.equal(back.home.state, 'running');
  assert.equal(back.home.move, null);
  assert.equal(back.home.homeMachineId, 'studio');
  assert.equal(back.home.leaseEpoch, 2);
  assert.deepEqual(
    back.home.machines.filter((m) => m.isHome).map((m) => m.machineId),
    ['studio'],
  );
  // with no move the home stays where it is, at a higher lease
  const same = run({ type: 'home.reclaim', moveId: 'm', toId: 'x' });
  assert.equal(same.home.homeMachineId, 'studio');
  assert.equal(same.home.leaseEpoch, 2);
});

test('a scripted home with no lease yet counts from zero, and a raw intent changes nothing', () => {
  const bare = fixtureView();
  bare.home.leaseEpoch = null;
  bare.home.homeMachineId = null;
  bare.home.machineName = null;
  const started = run({ type: 'move.start', machineId: 'this-mac' }, bare);
  assert.deepEqual(started.home.move?.from, { machineId: '', name: '' });
  let done = started;
  for (let i = 0; i < 6; i++) done = advanceMove(done, NOW);
  assert.equal(done.home.leaseEpoch, 1);
  assert.equal(run({ type: 'home.reclaim', moveId: 'm', toId: 'x' }, bare).home.leaseEpoch, 1);
  const v = fixtureView();
  assert.equal(run({ type: 'intent', intent: { kind: 'wake' } }, v), v);
});
