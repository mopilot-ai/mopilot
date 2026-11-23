// A harness switch confirmed in the switch sheet (src/components/harnessPicker/applySwitch.ts) on a chat that runs on a machine is refused with a reason, never recorded: main drops it for that chat, and a stale one could start a session on this Mac in the machine's folder.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const toasts: any[][] = [];
const recorded: any[][] = [];
mock.module('../src/store/core.ts', { namedExports: { get: () => ({ runtime: {} }), toast: (...a: any[]) => toasts.push(a) } });
mock.module('../src/store/send.ts', { namedExports: { giveBackToComposer: () => undefined, removeQueued: async () => true } });
mock.module('../src/store/actions.ts', { namedExports: { pauseGoal: async () => undefined } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: { sessionOf: () => ({ goal: null, queue: [] }), setSession: async (...a: any[]) => void recorded.push(a) },
});
mock.module('../shared/model/session.d.ts', { namedExports: { turnBusy: () => false } });
mock.module('../src/session/harness/select.ts', { namedExports: { harnessModels: () => [], selectionFor: () => ({ model: '' }) } });

let gate = true;
mock.module('../src/lib/host.ts', { namedExports: { hostAllowedNow: () => gate } });

let owner: { hostId: string; epoch: number } | null | 'throws' = null;
const reads: string[] = [];
installNative(
  fakeNative({
    host: {
      owner: async (id: string) => {
        reads.push(id);
        if (owner === 'throws') throw new Error('main is not answering');
        return owner;
      },
    },
  }),
);
const { applySwitch } = await import('../src/components/harnessPicker/applySwitch.ts');

const model = { id: '', label: '', efforts: [], defaultEffort: null, fast: false } as any;
const choices = { queued: 'keep', effort: null, mode: null, goal: null, multiAgent: false } as any;
const run = (id = 'acp:host-claude:u1') => applySwitch(id, { target: 'codex', model }, choices, () => undefined);

beforeEach(() => {
  toasts.length = 0;
  recorded.length = 0;
  reads.length = 0;
  gate = true;
});

test('a chat on a machine is not switched: the user is told to continue it here, and nothing is recorded', async () => {
  owner = { hostId: 'ssh:box', epoch: 1 };
  await run();
  assert.deepEqual(toasts, [['This chat runs on another machine. Continue it on this Mac to switch agents.', 'error']]);
  assert.deepEqual(recorded, []);
});

test('a chat on this Mac, one no machine claims, and one whose owner cannot be read are switched as before', async () => {
  for (const o of [{ hostId: 'local', epoch: 0 }, null, 'throws'] as const) {
    owner = o;
    await run();
  }
  assert.equal(recorded.length, 3);
  assert.deepEqual(toasts, []);
});

test('without Host access, or for a chat that is not ACP-kind, a switch makes no owner read and never takes the machine branch', async () => {
  owner = { hostId: 'ssh:box', epoch: 1 };
  gate = false;
  await run('acp:kimi:u1');
  await run('claude:u1');
  gate = true;
  await run('codex:u1');
  await run('019e0000-0000-7000-8000-000000000000');
  assert.deepEqual(reads, [], 'no IPC for an account without Host or an id no machine can hold');
  assert.equal(recorded.length, 4, 'all four are recorded as before');
  assert.deepEqual(toasts, []);
  await run('acp:kimi:u1');
  assert.deepEqual(reads, ['acp:kimi:u1'], 'an ACP chat of an account with Host is still looked up');
});
