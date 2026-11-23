// Controller initial-send and queued-dispatch failures: retired switch ownership, exact visible causes and one caller/main retry owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { identifyInput, clientIdOf, assertInputCurrent } = createRequire(import.meta.url)(
  '../../../electron/session/contract/inputGuard.cjs',
);

export function registerStartFailures(setup: (...args: any[]) => any, tick: () => Promise<unknown>) {
  test('a retired switch stays idle; a non-Error dispatch refusal stays visible with one queued retry', async () => {
    let release!: (v: any) => void;
    const { c, state, log, s } = setup({ switcher: { perform: () => new Promise((r) => (release = r)) } });
    state.patch('cx1', { pendingSwitch: { harness: 'claude' } });
    c.send('cx1', { id: 'm1', text: 'hi' });
    await tick();
    c.end('cx1', { drain: false }); // the user stopped it meanwhile
    release({ ready: true });
    await tick();
    assert.equal(log.length, 0);
    assert.equal(s('cx1').turn, 'idle');
    assert.equal(s('cx1').crashed, null, 'the retired switch cannot publish its failure');

    const t = setup({
      ctl: {
        codex: {
          startTurn: async () => {
            throw 'down';
          },
        },
      },
    });
    const sent = t.c.send('cx1', { text: 'x' });
    await tick();
    assert.equal(t.s('cx1').turn, 'crashed');
    assert.equal(t.s('cx1').crashed, 'down');
    assert.equal(t.s('cx1').activeTurn, null);
    assert.equal(t.s('cx1').queue.length, 1);
    assert.equal(t.s('cx1').queue[0].id, sent.id);
    assert.equal(t.s('cx1').queue[0].text, 'x');
  });

  test('a switch that throws a non-Error or is not ready reports the undispatched item', async () => {
    const results: any[] = [];
    let perform: any = async () => {
      throw 'switch exploded';
    };
    const { c, state, s, log } = setup({
      switcher: { perform: (...a: any[]) => perform(...a) },
      ctl: {
        onDispatchResult: (e: any) => {
          results.push(e.result);
          throw new Error('ack');
        },
      },
    });
    state.patch('cx1', { pendingSwitch: { to: 'claude' } });
    const first = { id: 's1', text: 'x', opts: {} };
    assert.deepEqual(await c.start('cx1', first), { started: false, error: 'switch exploded', retryItem: first });
    assert.deepEqual(results[0], { started: false, error: 'switch exploded' });
    assert.equal(s('cx1').turn, 'crashed');
    assert.equal(s('cx1').crashed, 'switch exploded');
    assert.deepEqual(s('cx1').pendingSwitch, { to: 'claude' }, "a switch that threw is still the user's choice");
    assert.equal(s('cx1').activeTurn, null);
    assert.deepEqual(s('cx1').queue, [], 'start returns retry ownership to its caller');
    perform = async () => null;
    state.patch('cx1', { pendingSwitch: { to: 'claude' } });
    const next = { id: 's2', text: 'x', opts: {} };
    const unsettled = 'The switch did not finish. Your message is kept in the queue.';
    assert.deepEqual(await c.start('cx1', next), { started: false, error: unsettled, retryItem: next });
    assert.deepEqual(results[1], { started: false, error: unsettled });
    assert.equal(s('cx1').turn, 'crashed');
    assert.equal(s('cx1').crashed, unsettled, 'the newer refusal owns the visible failure');
    assert.deepEqual(s('cx1').pendingSwitch, { to: 'claude' }, 'the switch is still chosen: the retry goes through it');
    assert.equal(s('cx1').activeTurn, null);
    assert.deepEqual(s('cx1').queue, [], 'direct start does not duplicate the caller-owned retry');
    assert.equal(log.length, 0);
  });
  test('a switch that settles, or that the user replaced while it ran, is not put back after a failed send', async () => {
    // settled: the chat is on the new harness, so the chip stays gone even when that harness refuses the prompt
    const settled = setup({
      switcher: { perform: async () => ({ ready: true }) },
      ctl: { codex: { startTurn: async () => ({ started: false, error: 'signed out' }) } },
    });
    settled.state.patch('cx1', { pendingSwitch: { to: 'claude' } });
    const sent = settled.c.send('cx1', { text: 'x' });
    await tick();
    assert.equal(settled.s('cx1').pendingSwitch, null);
    assert.equal(settled.s('cx1').queue[0].id, sent.id, 'the refused message waits for a retry');
    // replaced: a choice made while the first switch ran is the user's latest word
    const replaced = setup({
      switcher: {
        perform: async () => {
          replaced.state.patch('cx1', { pendingSwitch: { to: 'codex' } });
          return { ready: false, error: 'no' };
        },
      },
    });
    replaced.state.patch('cx1', { pendingSwitch: { to: 'claude' } });
    replaced.c.send('cx1', { text: 'y' });
    await tick();
    assert.deepEqual(replaced.s('cx1').pendingSwitch, { to: 'codex' });
    assert.equal(replaced.s('cx1').crashed, 'no');
  });

  test('drain retains dispatch exceptions once, honors existing requeues and preserves peer failure ownership', async () => {
    for (const scenario of ['throws', 'already-queued', 'kill-switch', 'peer']) {
      const { c, state, s } = setup({ result: { started: false, error: 'refused' } });
      const q = {
        id: 'drain-q',
        text: 'keep',
        attachments: [],
        opts: {},
        ...(scenario === 'peer' ? { peer: { messageId: 'drain-q' } } : {}),
      };
      if (scenario !== 'peer') identifyInput(q, 'native-drain-retry');
      state.patch('cx1', { queue: [q] });
      if (scenario === 'throws')
        c.codex.startTurn = async () => {
          throw new Error('disconnected');
        };
      else if (scenario === 'kill-switch') c.killed = () => 'disabled';
      else if (scenario === 'already-queued')
        c.beforeDispatch = (delivery: any) => {
          state.patch('cx1', { queue: [delivery.item] });
          throw Object.assign(new Error('retained'), { queuedFallback: true });
        };
      await c.drain('cx1');
      const retained = s('cx1').queue;
      assert.deepEqual(structuredClone(retained), scenario === 'peer' ? [] : [q]);
      if (scenario !== 'peer') {
        assert.equal(clientIdOf(retained[0]), 'native-drain-retry', 'a retained retry keeps its trusted native identity');
        assert.doesNotThrow(() => assertInputCurrent(retained[0]), 'the retired dispatch guard cannot block its retry');
      }
    }
  });
}
