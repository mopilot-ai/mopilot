// Computer use's unattended check with the VM-only bench switch (MOPILOT_BENCH_ATTENDED=1, #1600): the user counts as
// present, and every other reason to refuse stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rig } = await import('./support/computer-use-setup-rig.ts');

test('unattended: the VM-only bench switch counts the user as present, and only that (#1600)', async () => {
  // the switch on (MOPILOT_BENCH_ATTENDED=1 inside a VM): an hour of no input is no reason, and the helper isn't asked
  const asked: string[] = [];
  const r = rig({ kind: 'acp:opencode', benchAttended: () => true });
  const { cu, helper } = r.runtime;
  helper.idleSeconds = async () => (asked.push('idle'), 3600);
  r.states.set('c', { activeTurn: { human: true } });
  assert.equal(await cu.unattended('c', { callId: 'x' }), null);
  assert.deepEqual(asked, []);
  // every other reason stays: a sub-agent, a scheduled task, a call outside a prompt, a turn MoPilot started
  assert.equal(await cu.unattended('c', { callId: 'sub' }), 'a sub-agent');
  r.states.set('s', { scheduled: { unattended: true } });
  assert.equal(await cu.unattended('s'), 'a scheduled task');
  r.states.set('n', {});
  assert.equal(await cu.unattended('n'), 'a tool call outside a prompt');
  const claude = rig({ kind: 'claude', benchAttended: () => true });
  claude.states.set('m', { activeTurn: { human: false } });
  assert.equal(await claude.runtime.cu.unattended('m'), 'a turn MoPilot started');

  // the switch off (a host, or unset): the helper's idle time decides as before
  const off = rig({ kind: 'acp:opencode', benchAttended: () => false });
  off.runtime.helper.idleSeconds = async () => 3600;
  off.states.set('c', { activeTurn: { human: true } });
  assert.equal(await off.runtime.cu.unattended('c'), 'no input for 10 minutes');
});

test('attendance: without an injected switch it reads the VM-only bench switch, which is off outside a bench VM', async () => {
  const { attendance } = await import('../electron/capabilities/computerAttendance.cjs');
  const saved = process.env.MOPILOT_BENCH_ATTENDED;
  delete process.env.MOPILOT_BENCH_ATTENDED;
  try {
    const check = attendance({
      helper: { idleSeconds: async () => 3600 },
      sessions: { get: () => ({ activeTurn: { human: true } }) },
      controller: { isSubagentCall: () => false },
      kindOf: () => 'codex',
    });
    assert.equal(await check('c', undefined), 'no input for 10 minutes');
  } finally {
    if (saved !== undefined) process.env.MOPILOT_BENCH_ATTENDED = saved;
  }
});

test('attendance: a bench switch that can’t be read counts as off; the helper’s idle time decides', async () => {
  const { attendance } = await import('../electron/capabilities/computerAttendance.cjs');
  const check = attendance({
    helper: { idleSeconds: async () => 3600 },
    sessions: { get: () => ({ activeTurn: { human: true } }) },
    controller: { isSubagentCall: () => false },
    kindOf: () => 'acp:opencode',
    benchAttended: async () => {
      throw new Error('probe failed');
    },
  });
  assert.equal(await check('c', undefined), 'no input for 10 minutes');
});
