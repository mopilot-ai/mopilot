// What crosses from the main process to MoMo's home surfaces (src/components/momo/home): every payload is parsed (parseView.ts) and a part that is missing, malformed or unknown degrades instead of throwing; user moves become the intents the home serves (homeIntents.ts); the IPC seam passes only the home's answers on (ipcSeam.ts); the store shares unchanged parts between views (useMomoHome.ts).
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

installNativeStub({});
const { parseView, parseViewAnswer, parseIntentAnswer } = await import('../src/components/momo/home/parseView.ts');
const { toIntent } = await import('../src/components/momo/home/homeIntents.ts');
const { createIpcSeam } = await import('../src/components/momo/home/ipcSeam.ts');
const { shareStructure } = await import('../src/components/momo/home/useMomoHome.ts');
const { fixtureView, scenarioView } = await import('../src/components/momo/home/homeFixtures.ts');
const { stampSink, stampOf, believe, currentHomeName, forgetLease } = await import('../src/components/momo/home/stampStore.ts');
const { noteStale, clearStale } = await import('../src/components/momo/home/staleNote.ts');

test('a whole view parses to itself, and anything that is not a view with a home is none', () => {
  const v = fixtureView();
  assert.deepEqual(parseView(JSON.parse(JSON.stringify(v))), v);
  for (const bad of [null, undefined, 'x', 3, [], {}, { home: 'x' }, { home: [] }]) assert.equal(parseView(bad), null);
});

test('a view with parts missing or malformed degrades to empty parts and keeps what it can use', () => {
  const v: any = parseView({
    home: {
      state: 5,
      machines: [{ machineId: 'a' }, { name: 'no id' }, 7],
      sources: 'x',
      move: { from: { machineId: 'a', name: 'A' }, to: null },
      update: 3,
      agentProblem: { fix: 'x' },
    },
    setup: 'x',
    chat: [
      { kind: 'future', id: 'f1' },
      { kind: 'nope' },
      {
        kind: 'approval',
        id: 'r1',
        approval: { id: 3, recipients: 'x', attachments: [1, 'a.pdf'], failure: { fix: 5 }, answeredElsewhere: 'x' },
      },
      { kind: 'approval', id: 'r2' },
      { kind: 'brief', id: 'b1', brief: { attention: 3, offers: [{ id: 'o' }, {}], overnight: 4, leftOut: 'x' } },
      { kind: 'catch-up', id: 'c1', catchUp: { machine: 'x', needsYou: 'x' } },
      { kind: 'waiting', id: 'w1' },
      { kind: 'user', id: 'u1', text: 4 },
      { kind: 'assistant', id: 'a1', text: 4, notNeeded: 3 },
    ],
    tasks: [
      { id: 't1', where: 'x', failure: { fix: { id: 'f', label: 'F' } }, result: { files: [3, 'a'] } },
      { id: 't2', failure: 'x', result: 'x' },
      'x',
    ],
    notes: [{ id: 'n1', lines: [{ id: 'l1', sources: [{ id: 's' }, 4] }, 4], history: 'x', lastChange: 'x' }, 'x'],
    rules: [{ id: 'r1', evidence: [{ at: 1 }, 'x'], inBrief: 'yes' }],
    signals: [{ id: 's1' }, {}],
    settings: { brief: 'x', quietHours: 3, dailyCap: 'x', previews: 'yes' },
    problems: [{ id: 'p1', fix: { id: 'f', label: 'L' } }, { id: 'p2' }],
  });
  assert.equal(v.home.state, 'asleep');
  assert.deepEqual(
    v.home.machines.map((m: any) => [m.machineId, m.name]),
    [['a', 'a']],
  );
  assert.deepEqual(v.home.sources, []);
  assert.equal(v.home.update, null);
  assert.equal(v.home.agentProblem, null);
  assert.equal(v.home.move.to, null);
  assert.equal(v.setup.step, 'done');
  assert.deepEqual(
    v.chat.map((r: any) => r.id),
    ['f1', 'r1', 'r2', 'b1', 'c1', 'w1', 'u1', 'a1'],
  );
  assert.equal(v.chat[1].approval.status, 'unknown');
  assert.deepEqual(v.chat[1].approval.attachments, ['a.pdf']);
  assert.equal(v.chat[1].approval.failure.fix, null);
  assert.equal(v.chat[3].brief.attention, null);
  assert.equal(v.chat[4].catchUp.machine.machineId, '');
  assert.equal(v.chat[5].machine.name, '');
  assert.equal(v.chat[6].delivery, 'not-sure');
  assert.equal(v.tasks.length, 2);
  assert.equal(v.tasks[0].state, 'unknown');
  assert.equal(v.tasks[0].failure.fix.label, 'F');
  assert.deepEqual(v.tasks[0].result.files, ['a']);
  assert.equal(v.tasks[1].failure, null);
  assert.equal(v.notes[0].lines.length, 1);
  assert.equal(v.notes[0].lines[0].sources.length, 1);
  assert.equal(v.rules[0].inBrief, false);
  assert.equal(v.signals.length, 1);
  assert.deepEqual(v.settings, {
    brief: { on: true, time: '08:00' },
    quietHours: { from: '22:00', to: '08:00' },
    dailyCap: 6,
    previews: false,
  });
  assert.deepEqual(
    v.problems.map((p: any) => p.id),
    ['p1'],
  );
  const bare: any = parseView({ home: {}, settings: { brief: { on: false } } });
  assert.equal(bare.settings.brief.on, false);
  assert.deepEqual([bare.chat, bare.tasks, bare.notes, bare.rules], [[], [], [], []]);
  const odd: any = parseView({
    home: { movedAway: { machine: { machineId: 'm' }, at: 'x' }, agentProblem: { agent: 3, fix: { id: 'a', label: 'b' } } },
  });
  assert.deepEqual(odd.home.movedAway, { machine: { machineId: 'm', name: 'm' }, at: 0 });
  assert.equal(odd.home.agentProblem.agent, '');
});

test('an answer to view and changed is a view or the home’s own words about why there is none', () => {
  const v = fixtureView();
  const ok = parseViewAnswer({ ok: true, view: v, movedAwayTo: { name: 'x', at: 1 } });
  assert.ok(ok.ok && ok.view.home.state === 'running');
  assert.deepEqual(parseViewAnswer({ ev: 'momo.home.changed', view: v }).ok, true);
  assert.deepEqual(parseViewAnswer({ ok: false, reason: 'unavailable', cause: 'No home.' }), { ok: false, cause: 'No home.' });
  assert.deepEqual(parseViewAnswer({ ok: false }), { ok: false, cause: 'MoMo’s home isn’t available here yet.' });
  assert.deepEqual(parseViewAnswer('garbage'), { ok: false, cause: 'MoMo’s home didn’t answer.' });
  assert.deepEqual(parseViewAnswer({ ok: true, view: 'x' }), { ok: false, cause: 'MoMo’s home didn’t answer.' });
});

test('an answer to an intent is done, or the cause and the fix the home offered; nothing else is trusted', () => {
  const v = fixtureView();
  assert.deepEqual(parseIntentAnswer({ ok: true }), { ok: true });
  assert.deepEqual(parseIntentAnswer({ ok: true, view: 'x' }), { ok: true });
  const withView = parseIntentAnswer({ ok: true, view: v });
  assert.ok(withView.ok && 'view' in withView);
  assert.deepEqual(parseIntentAnswer({ ok: false, cause: 'Studio is asleep.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' }), {
    ok: false,
    cause: 'Studio is asleep.',
    fix: { label: 'Wake Studio', intent: { kind: 'wake' } },
  });
  assert.deepEqual(parseIntentAnswer({ ok: false, cause: 'No.', fixLabel: 'x' }), { ok: false, cause: 'No.' });
  assert.deepEqual(parseIntentAnswer({ ok: false }), { ok: false, cause: 'MoMo’s home didn’t answer.' });
  assert.deepEqual(parseIntentAnswer(null), { ok: false, cause: 'MoMo’s home didn’t answer.' });
  assert.deepEqual(parseIntentAnswer({ ok: 'yes' }), { ok: false, cause: 'MoMo’s home didn’t answer.' });
});

test('each user move is the intent the home serves; a move it does not serve yet goes by its own name', () => {
  const cases: [Parameters<typeof toIntent>[0], unknown][] = [
    [
      { type: 'setup.choose', machineId: 'm' },
      { kind: 'choose-home', machineId: 'm' },
    ],
    [
      { type: 'move.start', machineId: 'm' },
      { kind: 'move', toId: 'm' },
    ],
    [{ type: 'move.cancel' }, { kind: 'move-cancel' }],
    [{ type: 'move.retry' }, { kind: 'move-retry' }],
    [{ type: 'move.stay' }, { kind: 'move-stay' }],
    [{ type: 'move.dismiss' }, { kind: 'move-ack' }],
    [
      { type: 'home.reclaim', moveId: 'mv', toId: 'm' },
      { kind: 'reclaim', moveId: 'mv', toId: 'm' },
    ],
    [{ type: 'home.wake' }, { kind: 'wake' }],
    [
      { type: 'machine.update', machineId: 'm' },
      { kind: 'update-machine', machineId: 'm' },
    ],
    [
      { type: 'machine.setUp', machineId: 'm' },
      { kind: 'set-up-machine', machineId: 'm' },
    ],
    [
      { type: 'chat.send', turnId: 't', text: 'hi' },
      { kind: 'send', turnId: 't', text: 'hi' },
    ],
    [
      { type: 'chat.check', rowId: 't' },
      { kind: 'check-turn', turnId: 't' },
    ],
    [
      { type: 'fix.run', id: 'sign-in-agent:m:a' },
      { kind: 'fix', id: 'sign-in-agent:m:a' },
    ],
    [
      { type: 'task.act', id: 'task-1', fixId: 'review' },
      { kind: 'task.act', id: 'task-1', fixId: 'review' },
    ],
    [{ type: 'intent', intent: { kind: 'wake' } }, { kind: 'wake' }],
    [
      { type: 'approval.send', id: 'c' },
      { kind: 'approval.send', id: 'c' },
    ],
    [
      { type: 'settings.set', patch: { dailyCap: 3 } },
      { kind: 'settings.set', patch: { dailyCap: 3 } },
    ],
  ];
  for (const [a, want] of cases) assert.deepEqual(toIntent(a), want);
});

function bridge(o: { view?: () => Promise<unknown>; intent?: (i: unknown) => Promise<unknown> } = {}) {
  let push: ((p: unknown) => void) | null = null;
  const log = { intents: [] as unknown[], subs: 0, unsubs: 0 };
  return {
    log,
    emit: (p: unknown) => push?.(p),
    api: {
      view: o.view ?? (async () => ({ ok: true, view: fixtureView() })),
      intent: async (i: unknown) => (log.intents.push(i), o.intent ? o.intent(i) : { ok: true }),
      onChanged: (cb: (p: unknown) => void) => {
        log.subs++;
        push = cb;
        return () => void log.unsubs++;
      },
      dev: async () => false,
      devScenario: async () => false,
    },
  };
}

test('the IPC seam reads the view, passes only the home’s changes on, and never turns an answer into a success', async () => {
  const b = bridge({
    intent: async (i: any) =>
      i.kind === 'wake'
        ? { ok: true, view: scenarioView('asleep') }
        : i.kind === 'boom'
          ? Promise.reject(new Error('x'))
          : { ok: false, cause: 'Studio is offline.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' },
  });
  const seam = createIpcSeam(b.api as any);
  const first = await seam.read();
  assert.ok(first.ok && first.view.home.state === 'running');
  const seen: string[] = [];
  const stop = seam.subscribe((v) => seen.push(v.home.state));
  const stop2 = seam.subscribe(() => undefined);
  assert.equal(b.log.subs, 1);
  b.emit({ ev: 'momo.home.changed', view: scenarioView('needs-update') });
  b.emit('garbage');
  assert.deepEqual(seen, ['needs-update']);
  assert.deepEqual(await seam.act({ type: 'home.wake' }), { ok: true });
  assert.deepEqual(seen, ['needs-update', 'asleep']);
  const refused = await seam.act({ type: 'move.cancel' });
  assert.deepEqual(refused, { ok: false, cause: 'Studio is offline.', fix: { label: 'Wake Studio', intent: { kind: 'wake' } } });
  assert.equal(seen.length, 2, 'a refusal changes nothing');
  assert.deepEqual(await seam.act({ type: 'intent', intent: { kind: 'boom' } }), { ok: false, cause: 'MoMo’s home didn’t answer.' });
  stop();
  assert.equal(b.log.unsubs, 0);
  stop2();
  assert.equal(b.log.unsubs, 1);
  assert.deepEqual(b.log.intents[0], { kind: 'wake' });
});

test('the IPC seam says why there is no view, and survives a bridge that throws', async () => {
  const none = createIpcSeam(bridge({ view: async () => ({ ok: false, cause: 'MoMo’s home isn’t available here yet.' }) }).api as any);
  assert.deepEqual(await none.read(), { ok: false, cause: 'MoMo’s home isn’t available here yet.' });
  const broken = createIpcSeam(bridge({ view: () => Promise.reject(new Error('x')) }).api as any);
  assert.deepEqual(await broken.read(), { ok: false, cause: 'MoMo’s home didn’t answer.' });
});

test('structural sharing keeps the identity of every part that did not change', () => {
  const a = {
    x: [
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ],
    y: { z: 1 },
    n: null,
  };
  const same = shareStructure(a, JSON.parse(JSON.stringify(a)));
  assert.equal(same, a);
  const next = shareStructure(a, {
    x: [
      { id: 1, v: 'a' },
      { id: 2, v: 'changed' },
    ],
    y: { z: 1 },
    n: null,
  });
  assert.notEqual(next, a);
  assert.equal(next.x[0], a.x[0]);
  assert.notEqual(next.x[1], a.x[1]);
  assert.equal(next.y, a.y);
  assert.deepEqual(shareStructure([1, 2], [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(shareStructure([1, 2, 3], [1, 2]), [1, 2]);
  assert.deepEqual(shareStructure({ a: 1 }, { a: 1, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(shareStructure({ a: 1, b: 2 }, { a: 1 }), { a: 1 });
  assert.equal(shareStructure([1], { a: 1 } as any) instanceof Array, false);
  assert.equal(shareStructure(null, 5), 5);
  assert.deepEqual(shareStructure({ a: 1 }, [1]), [1]);
});

const at = (homeMachineId: string | null, leaseEpoch: number | null, machineName = 'Studio') => {
  const v = fixtureView();
  v.home.homeMachineId = homeMachineId;
  v.home.leaseEpoch = leaseEpoch;
  v.home.machineName = machineName;
  return v;
};

test('a view, change or answer from an older lease than the newest seen is dropped; a newer one replaces it and is remembered', async () => {
  const store = (globalThis as any).localStorage;
  forgetLease();
  const b = bridge({ view: async () => ({ ok: true, view: at('studio', 2) }) });
  const seam = createIpcSeam(b.api as any);
  const seen: string[] = [];
  seam.subscribe((v) => seen.push(`${v.home.machineName}@${v.home.leaseEpoch}`));
  assert.ok((await seam.read()).ok);
  assert.deepEqual(stampSink.newest(), { homeId: 'studio', leaseEpoch: 2, name: 'Studio', createdAt: null });
  // the owner reclaims at a higher epoch: the new home's view is believed
  b.emit({ ev: 'momo.home.changed', view: at('mac', 3, 'This Mac') });
  assert.deepEqual(seen, ['This Mac@3']);
  // the old home's late change and late read are refused, and the page is told where MoMo runs now
  b.emit({ ev: 'momo.home.changed', view: at('studio', 2) });
  assert.deepEqual(seen, ['This Mac@3']);
  const late = await seam.read();
  assert.deepEqual(late, { ok: false, cause: 'MoMo runs on This Mac now.' });
  assert.equal(currentHomeName(), 'This Mac');
  // another machine claiming the same lease is not trusted either
  b.emit({ ev: 'momo.home.changed', view: at('mini', 3, 'Mac mini') });
  assert.deepEqual(seen, ['This Mac@3']);
  // an answer that carries a view is held to the same rule
  const answered = createIpcSeam(bridge({ intent: async () => ({ ok: true, view: at('studio', 1) }) }).api as any);
  const got: string[] = [];
  answered.subscribe((v) => got.push(v.home.machineName ?? ''));
  assert.deepEqual(await answered.act({ type: 'home.wake' }), { ok: false, cause: 'MoMo runs on This Mac now.' });
  assert.deepEqual(got, [], 'a stale answer changes nothing');
  // the newest lease is kept where a restart reads it
  assert.deepEqual(JSON.parse(store.getItem('momo.home.newestLease')), { homeId: 'mac', leaseEpoch: 3, name: 'This Mac', createdAt: null });
  // a view with no stamp is not believed once a home was seen, unless it is this machine's tombstone or the first-run choice
  assert.equal(believe(at(null, null)), null);
  const tomb = at(null, null);
  tomb.home.movedAway = { machine: { machineId: 'mac', name: 'This Mac' }, at: 1 };
  assert.ok(believe(tomb));
  const first = scenarioView('first-run');
  first.home.homeMachineId = null;
  first.home.leaseEpoch = null;
  assert.ok(believe(first));
  assert.equal(stampOf(at('studio', null)), null);
  forgetLease();
});

test('the stamp store survives storage that cannot be read or written, and the note names where MoMo runs now until the next accepted view', async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => {
      throw new Error('blocked');
    },
    configurable: true,
  });
  assert.equal(believe(at('studio', 5)) !== null, true, 'kept in memory when storage is blocked');
  assert.equal(believe(at('studio', 4)), null);
  forgetLease();
  assert.ok(believe(at('studio', 5)), 'forgetting works with storage blocked too');
  Object.defineProperty(globalThis, 'localStorage', real);
  (globalThis as any).localStorage.setItem('momo.home.newestLease', 'not json');
  assert.deepEqual(stampSink.newest(), { homeId: 'studio', leaseEpoch: 5, name: 'Studio', createdAt: null });
  forgetLease();
  noteStale();
  clearStale();
  clearStale();
});

test('an answer whose view was refused as stale is a failure that says where MoMo runs; choosing a home forgets the lease, and the name is kept with it', async () => {
  const store = (globalThis as any).localStorage;
  forgetLease();
  const b = bridge({ intent: async () => ({ ok: true, view: at('studio', 1, 'Studio') }) });
  const seam = createIpcSeam(b.api as any);
  assert.ok(believe(at('mac', 4, 'This Mac')));
  assert.deepEqual(await seam.act({ type: 'chat.send', turnId: 't', text: 'hi' }), { ok: false, cause: 'MoMo runs on This Mac now.' });
  assert.equal(
    JSON.parse(store.getItem('momo.home.newestLease')).name,
    'This Mac',
    'the name is kept with the lease, so a restart can still say it',
  );
  // an explicit new home starts again at its first lease
  assert.deepEqual(await seam.act({ type: 'setup.choose', machineId: 'studio' }), { ok: true });
  assert.equal(
    store.getItem('momo.home.newestLease') === null || JSON.parse(store.getItem('momo.home.newestLease')).leaseEpoch === 1,
    true,
  );
  assert.ok(believe(at('studio', 1, 'Studio')));
  // an answer with no view, and a refusal, pass through untouched
  const plain = createIpcSeam(bridge({ intent: async () => ({ ok: false, cause: 'No.' }) }).api as any);
  assert.deepEqual(await plain.act({ type: 'home.wake' }), { ok: false, cause: 'No.' });
  forgetLease();
});

test('a home made anew on the same machine starts again; a move to another machine does not drop the old lease', () => {
  forgetLease();
  const made = (homeId: string, leaseEpoch: number, createdAt: number | null) => {
    const v = at(homeId, leaseEpoch, homeId);
    v.home.createdAt = createdAt;
    return v;
  };
  assert.ok(believe(made('studio', 5, 100)));
  assert.equal(believe(made('studio', 1, 100)), null, 'the same home at an older lease is stale');
  assert.ok(believe(made('studio', 1, 200)), 'Reset → Start fresh: a new record at the first lease');
  assert.deepEqual(stampSink.newest(), { homeId: 'studio', leaseEpoch: 1, name: 'studio', createdAt: 200 });
  assert.ok(believe(made('mini', 2, 300)), 'a move: the other machine at a higher lease');
  assert.equal(believe(made('studio', 1, 400)), null, 'the old machine is not believed again for having a new start time');
  assert.ok(believe(made('mini', 3, null)), 'no start time: nothing to scope by');
  forgetLease();
});

test('a lease kept by an older version (no name, no start time) still binds, and a home with no name is called another machine', async () => {
  const store = (globalThis as any).localStorage;
  forgetLease();
  store.setItem('momo.home.newestLease', JSON.stringify({ homeId: 'studio', leaseEpoch: 4 }));
  assert.deepEqual(stampSink.newest(), { homeId: 'studio', leaseEpoch: 4, name: null, createdAt: null });
  const made = at('studio', 5, 'Studio');
  made.home.createdAt = 900;
  assert.ok(believe(made), 'a start time against a kept lease that has none changes nothing');
  assert.equal((stampSink.newest() as any)?.createdAt, 900);
  forgetLease();
  const nameless = at('mac', 9, 'x');
  nameless.home.machineName = null;
  assert.ok(believe(nameless));
  const seam = createIpcSeam(bridge({ intent: async () => ({ ok: true, view: at('studio', 1, 'Studio') }) }).api as any);
  assert.deepEqual(await seam.act({ type: 'home.wake' }), { ok: false, cause: 'MoMo runs on another machine now.' });
  forgetLease();
});

test('a stamp that is not one is refused; a view that names no machine keeps the last name; the action vocabulary loads', async () => {
  const { stampSink: sink, believe: trust } = await import('../src/components/momo/home/stampStore.ts');
  assert.deepEqual(sink.accept('x'), { ok: false, reason: 'not-a-stamp', newest: sink.newest() });
  forgetLease();
  assert.ok(trust(at('studio', 7, 'Studio')));
  assert.ok(trust({ ...at('studio', 8), home: { ...at('studio', 8).home, machineName: null } }));
  assert.equal((await import('../src/components/momo/home/stampStore.ts')).currentHomeName(), 'Studio');
  assert.ok(await import('../src/components/momo/home/homeActions.ts'));
  forgetLease();
});

test('a move, an answered-elsewhere card and a source in progress keep what they carry', () => {
  const v = fixtureView();
  (v.chat.find((r) => r.kind === 'approval') as any).approval.answeredElsewhere = { device: 'iPhone', at: 1, outcome: 'approved' };
  v.home.move = {
    moveId: 'm',
    from: { machineId: 'a', name: 'A' },
    to: { machineId: 'b', name: 'B' },
    step: 'copied',
    outcome: 'failed',
    finishedAt: 1,
    failure: { cause: 'x', failedAt: 'copied' },
    oldMachineOffline: false,
  };
  v.home.sources[0].progress = { done: 1, total: 2 };
  const parsed: any = parseView(JSON.parse(JSON.stringify(v)));
  assert.deepEqual(parsed.chat.find((r: any) => r.kind === 'approval').approval.answeredElsewhere, {
    device: 'iPhone',
    at: 1,
    outcome: 'approved',
  });
  assert.deepEqual(parsed.home.move.failure, { cause: 'x', failedAt: 'copied' });
  assert.deepEqual(parsed.home.sources[0].progress, { done: 1, total: 2 });
});
