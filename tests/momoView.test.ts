// MoMo's view contract helpers (shared/momoView.ts): task grouping, the home pill's tone, when a move can be cancelled, card expiry and answerability, and delivery; each with a value a newer Host may send that this client does not know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMO_MOVE_STEPS,
  groupMomoTasks,
  isKnown,
  momoApprovalAnswerable,
  momoApprovalStatus,
  momoDeliveryNeedsCheck,
  momoHomeTone,
  momoMoveCancellable,
  type MomoHomeView,
  type MomoTaskView,
} from '../shared/momoView.ts';

const studio = { machineId: 'm-studio', name: 'Studio' };
const task = (id: string, state: MomoTaskView['state']): MomoTaskView => ({
  id,
  title: id,
  doneMeans: '',
  state,
  origin: 'asked',
  where: { machine: studio, agent: 'Codex' },
  startedAt: 0,
  attempts: 1,
  attemptCap: 3,
  step: null,
  nextCheck: null,
  failure: null,
  result: null,
});

test('tasks group in the design order, empty groups are left out, and an unknown state is still listed', () => {
  const groups = groupMomoTasks([
    task('a', 'done'),
    task('b', 'working'),
    task('c', 'needs_you'),
    task('d', 'failed'),
    task('e', 'stopped'),
    task('f', 'paused-by-a-newer-host'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.tasks.map((t) => t.id)]),
    [
      ['needs-you', ['c']],
      ['working', ['b']],
      ['done', ['a', 'd', 'e']],
      ['other', ['f']],
    ],
  );
  assert.deepEqual(groupMomoTasks([]), []);
  assert.equal(groupMomoTasks([task('w', 'watching')])[0].id, 'watching');
});

test('the pill is green when running, blue while moving, amber otherwise, including a state it does not know', () => {
  assert.equal(momoHomeTone('running'), 'ok');
  assert.equal(momoHomeTone('moving'), 'busy');
  for (const s of ['asleep', 'needs-update', 'needs-sign-in', 'rebooting'] as const) assert.equal(momoHomeTone(s), 'warn');
});

test('a move can be cancelled only before the switch; an unknown step cannot be cancelled', () => {
  assert.deepEqual(MOMO_MOVE_STEPS.map(momoMoveCancellable), [true, true, true, false, false, false]);
  assert.equal(momoMoveCancellable('verifying'), false);
  assert.equal(momoMoveCancellable(''), false);
});

test('a moving home with a failed move carries the step it failed at, and a move that finished late keeps its outcome', () => {
  const home: Pick<MomoHomeView, 'state' | 'move'> = {
    state: 'moving',
    move: {
      moveId: 'm1',
      from: studio,
      to: { machineId: 'm-mini', name: 'Mac mini' },
      step: 'copied',
      outcome: 'failed',
      finishedAt: 5,
      failure: { cause: 'Mac mini stopped answering.', failedAt: 'copied' },
      oldMachineOffline: false,
    },
  };
  assert.equal(momoHomeTone(home.state), 'busy');
  assert.equal(home.move?.failure?.failedAt, 'copied');
  assert.equal(momoMoveCancellable(home.move!.step), true);
  assert.equal(momoMoveCancellable({ ...home.move!, step: 'cleaning-up', outcome: 'moved', failure: null }.step), false);
});

test('a pending card past its expiry reads as expired; others keep their status, unknown ones included', () => {
  assert.equal(momoApprovalStatus({ status: 'pending', expiresAt: 100 }, 100), 'expired');
  assert.equal(momoApprovalStatus({ status: 'pending', expiresAt: 101 }, 100), 'pending');
  assert.equal(momoApprovalStatus({ status: 'pending', expiresAt: null }, 100), 'pending');
  assert.equal(momoApprovalStatus({ status: 'completed', expiresAt: 1 }, 100), 'completed');
  assert.equal(momoApprovalStatus({ status: 'rerouted', expiresAt: 1 }, 100), 'rerouted');
});

test('only a pending card that has not expired can be answered; an unknown status offers nothing', () => {
  assert.equal(momoApprovalAnswerable({ status: 'pending', expiresAt: null }, 100), true);
  assert.equal(momoApprovalAnswerable({ status: 'pending', expiresAt: 100 }, 100), false);
  for (const status of [
    'approved',
    'denied',
    'expired',
    'answered-elsewhere',
    'consumed',
    'completed',
    'failed',
    'uncertain',
    'rerouted',
  ]) {
    assert.equal(momoApprovalAnswerable({ status, expiresAt: null }, 100), false, status);
  }
});

test('a message needs a check when the home never got it, nobody knows, or the state is unknown; the rest are settled', () => {
  for (const d of ['never-got-it', 'not-sure', 'lost-in-space']) assert.equal(momoDeliveryNeedsCheck(d), true, d);
  for (const d of ['queued', 'accepted', 'completed', 'failed', 'cancelled', 'interrupted'])
    assert.equal(momoDeliveryNeedsCheck(d), false, d);
});

test('isKnown narrows to the values a client knows', () => {
  assert.equal(isKnown(['a', 'b'], 'a'), true);
  assert.equal(isKnown(['a', 'b'], 'c'), false);
});
