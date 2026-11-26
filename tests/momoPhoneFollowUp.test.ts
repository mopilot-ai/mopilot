// What the store does after an intent whose effect arrives later: a move is read again soon, a machine that does not change in ten seconds says so with Retry, and a failed move that was tried again says when.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const storePath = '../mobile/src/momoPhone/store';
const fxPath = '../mobile/src/momoPhone/fixtures';
const vmPath = '../mobile/src/momoPhone/viewModels';
const { createMomoStore } = await import(storePath);
const { createFixtureTransport, fixtureView } = await import(fxPath);
const vm = await import(vmPath);

type Any = any;
const move = (outcome: string) => ({
  moveId: 'm1',
  from: { machineId: 'studio', name: 'Studio' },
  to: { machineId: 'mini', name: 'Mac mini' },
  step: 'copied',
  outcome,
  finishedAt: null,
  failure: outcome === 'failed' ? { cause: 'Mac mini stopped answering.', failedAt: 'copied' } : null,
  oldMachineOffline: false,
  reclaim: null,
});
function make(edit: (v: Any) => void = () => undefined) {
  const view = fixtureView();
  edit(view.view);
  const transport = createFixtureTransport(view);
  let loads = 0;
  const load = transport.load.bind(transport);
  transport.load = async () => (loads++, load());
  // the home answers ok with no view: only the later reads show what became of it
  transport.send = async () => ({ ok: true });
  const store = createMomoStore(transport, { now: () => view.now });
  return { store, transport, view, loads: () => loads };
}

test('Cancel says Cancelling… at once and until the home says the move has ended', async () => {
  const m = make((v) => Object.assign(v.home, { state: 'moving', move: move('running') }));
  await m.store.load();
  assert.equal(vm.movePanel(m.store.get().view).cancelling, false);
  let answer: (r: Any) => void = () => undefined;
  m.transport.send = async () => new Promise((resolve) => (answer = resolve));
  const pressed = m.store.act({ kind: 'move-cancel' });
  const panel = vm.movePanel(m.store.get().view);
  assert.deepEqual([panel.cancelling, panel.cancel], [true, null]);
  answer({ ok: true });
  await pressed;
  // answered, but the home has not ended the move: it still says Cancelling…
  assert.equal(vm.movePanel(m.store.get().view).cancelling, true);
  m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, state: 'running', move: move('cancelled') } } });
  assert.equal(m.store.get().view.cancelling, undefined);
  // a refusal puts Cancel back
  const refused = make((v) => Object.assign(v.home, { state: 'moving', move: move('running') }));
  await refused.store.load();
  refused.transport.send = async () => ({ ok: false, cause: 'Too late to cancel.' });
  await refused.store.act({ kind: 'move-cancel' });
  assert.equal(vm.movePanel(refused.store.get().view).cancelling, false);
  m.store.dispose();
  refused.store.dispose();
});

test('the store reads the home again when asked, without showing a load', async () => {
  const m = make();
  await m.store.load();
  const before = m.loads();
  m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, state: 'asleep' } } });
  await m.store.refresh();
  assert.equal(m.loads(), before + 1);
  assert.equal(m.store.get().loading, false);
  m.store.dispose();
});

test('a machine that does not change in ten seconds says so with Retry, and one that does says nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const still = make((v) => Object.assign(v.home, { state: 'needs-update' }));
    await still.store.load();
    await still.store.act({ kind: 'update-machine', machineId: 'studio' });
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    const failure = still.store.get().failure;
    assert.equal(failure.cause, "It hasn't changed yet. It may still be working.");
    assert.equal(failure.late, true, 'told on a timer: the screen does not move the page for it');
    assert.deepEqual([failure.fix.label, failure.fix.intent], ['Retry', { kind: 'update-machine', machineId: 'studio' }]);
    still.store.dispose();
    const changed = make((v) => Object.assign(v.home, { state: 'needs-update' }));
    await changed.store.load();
    await changed.store.act({ kind: 'update-machine', machineId: 'studio' });
    changed.transport.emit({ view: { ...changed.view.view, home: { ...changed.view.view.home, state: 'running' } } });
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(changed.store.get().failure, null);
    changed.store.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('a move that was tried again says when, until the move is over; a store that is gone fires nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = make((v) => Object.assign(v.home, { move: move('failed') }));
    await m.store.load();
    assert.equal(vm.movePanel(m.store.get().view).tried, null);
    await m.store.act({ kind: 'move-retry' });
    const panel = vm.movePanel(m.store.get().view);
    assert.match(panel.tried, /^Tried again at \d{1,2}:\d{2} [AP]M$/);
    // it ran and failed again: the time stays on the failed card
    m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, move: { ...move('failed'), step: 'switching' } } } });
    assert.match(vm.movePanel(m.store.get().view).tried, /Tried again at/);
    // the move is over: nothing says it was tried
    m.transport.emit({ view: { ...m.view.view, home: { ...m.view.view.home, move: null } } });
    assert.equal(m.store.get().view.retriedAt, undefined);
    const loads = m.loads();
    m.store.dispose();
    mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(m.loads(), loads);
  } finally {
    mock.timers.reset();
  }
});

test('a machine whose answer already carries the new state says nothing ten seconds later', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = make((v) => Object.assign(v.home, { state: 'asleep' }));
    await m.store.load();
    // the home is awake when it answers, so a later read finds it awake too
    const awake = { view: { ...m.view.view, home: { ...m.view.view.home, state: 'running' } } };
    m.transport.send = async () => (m.transport.emit(awake), { ok: true, view: awake });
    await m.store.act({ kind: 'wake' });
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(m.store.get().failure, null, 'it had already changed when the answer came');
    m.store.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('a store that goes while it waits for a machine to change says nothing afterwards', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = make((v) => Object.assign(v.home, { state: 'needs-update' }));
    await m.store.load();
    await m.store.act({ kind: 'update-machine', machineId: 'studio' });
    m.store.dispose();
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(m.store.get().failure, null);
  } finally {
    mock.timers.reset();
  }
});
