// Reset cards refresh on entry and disclosure reopening without losing an in-flight redemption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, StrictMode } from 'react';
import { deferred } from './support/async-scenarios.ts';
import { createUsageRefresher, mergeUsage, usageFetchState, type Usage, type UsageReadResult } from '../src/harness/claudeUsage.ts';
import {
  fixture,
  mount,
  unmount,
  click,
  focus,
  expanded,
  card,
  reply,
  host,
  CodexResetCards,
  ClaudeResetCards,
} from './support/reset-cards-kit.ts';
test('reopening reset cards refreshes without clearing the selected tab or hiding existing cards', async () => {
  const f = fixture();
  await mount();
  await expanded(true);
  await click('History');
  await expanded(false);
  assert.equal(f.reads.length, 2, 'closing does not request another reading');
  const pending = deferred();
  f.read = (id: string) => {
    f.reads.push(id);
    return pending.promise;
  };
  await expanded(true);
  assert.equal(f.reads.length, 3);
  assert.match(host.textContent!, /No reset history/);
  await click('Available 1');
  assert.match(host.textContent!, /Weekly reset/);
  assert.match(host.textContent!, /Refreshing/);
  assert.equal([...host.querySelectorAll('button')].find((b) => b.textContent === 'Use reset')?.disabled, true);
  await focus();
  assert.equal(f.reads.length, 3);
  await act(async () => pending.resolve(reply([card({ title: 'Updated reset' })])));
  assert.match(host.textContent!, /Updated reset/);
  await unmount();
  await mount();
  assert.equal(f.reads.length, 4, 'returning to the page refreshes again');
  await unmount();
});

test('reopening during redemption preserves confirmation and does not overlap its reread', async () => {
  const pending = deferred();
  const f = fixture({ consume: () => pending.promise });
  await mount();
  await click('Use reset');
  await expanded(true);
  await expanded(false);
  await expanded(true);
  assert.equal(f.reads.length, 1);
  assert.match(host.textContent!, /Using reset/);
  await act(async () => pending.reject(new Error('Timeout')));
  assert.equal(f.reads.length, 2);
  await expanded(false);
  await expanded(true);
  assert.match(host.textContent!, /Reset result needs confirmation/);
  f.consume = async () => ({ outcome: 'alreadyRedeemed' });
  await click('Retry reset');
  assert.equal(f.confirmations.length, 1);
  await unmount();
});

test('Claude automatically refreshes on entry and retries a failed reading without a routine refresh button', async () => {
  const f = fixture({
    refreshClaude: async () => {
      f.claudeReads++;
      throw new Error('Offline');
    },
  });
  await mount(ClaudeResetCards);
  assert.equal(f.claudeReads, 1);
  assert.match(host.textContent!, /Could not refresh usage.*Offline/);
  f.refreshClaude = async () => {
    f.claudeReads++;
  };
  await click('Retry');
  assert.equal(f.claudeReads, 2);
  assert.doesNotMatch(host.textContent!, /Offline|Retry/);
  await expanded(true, ClaudeResetCards);
  await expanded(false, ClaudeResetCards);
  await expanded(true, ClaudeResetCards);
  assert.equal(f.claudeReads, 4);
  await focus();
  assert.deepEqual(f.claudeReasons, ['surface', 'now', 'surface', 'surface', 'surface']);
  await unmount();
});

test('entry refresh coalesces Strict Mode setup and ignores Claude failures after leaving', async () => {
  const pending = deferred();
  const f = fixture({
    read: (id: string) => {
      f.reads.push(id);
      return pending.promise;
    },
  });
  await mount(() => createElement(StrictMode, null, createElement(CodexResetCards, { expanded: true })));
  assert.deepEqual(f.reads, ['a']);
  await act(async () => pending.resolve(reply()));
  assert.match(host.textContent!, /Weekly reset/);
  await unmount();
  const refresh = deferred();
  const g = fixture({ refreshClaude: () => refresh.promise });
  await mount(ClaudeResetCards);
  await unmount();
  await act(async () => refresh.reject(new Error('Retired')));
  assert.deepEqual(g.toasts, []);
});

test('a focus read blocks a reset click before the loading state has rendered', async () => {
  const pending = deferred();
  const f = fixture();
  await mount();
  f.read = () => pending.promise;
  const use = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use reset')!;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    use.click();
  });
  assert.deepEqual(f.consumes, []);
  await act(async () => pending.resolve(reply()));
});

test('Claude retry observes the real usage refresher’s resolved failures and unavailable data', async () => {
  for (const failure of [new Error('Network lost'), { state: 'error', error: 'Offline' }, { state: 'success', text: '' }]) {
    const f = fixture();
    let current: Usage = null;
    let answer: any = failure;
    const publish = () => {
      f.claude.usage = current;
    };
    const refresh = createUsageRefresher({
      read: async () => {
        if (answer instanceof Error) throw answer;
        return answer as UsageReadResult;
      },
      current: () => current,
      noteReading: (_id, reading) => {
        current = mergeUsage(current, reading);
        publish();
      },
      noteFetch: (_id, state, error) => {
        current = usageFetchState(current, state, error);
        publish();
      },
    });
    f.refreshClaude = (reason: any) => refresh('c', reason);
    await mount(ClaudeResetCards);
    assert.match(host.textContent!, /Could not refresh usage/);
    answer = { state: 'success', text: 'Current session\n5% used\nCurrent week (all models)\n10% used' };
    await click('Retry');
    assert.doesNotMatch(host.textContent!, /Could not refresh usage|Retry/);
    assert.deepEqual(f.claudeReasons, ['surface', 'now']);
    await unmount();
  }
});

test('Claude account failures without details still provide a retry', async () => {
  fixture({ claude: { id: 'c', email: 'c@test', usage: { fetchState: 'unavailable', fetchError: null } } });
  await mount(ClaudeResetCards);
  assert.match(host.textContent!, /Could not refresh usage.*Usage is unavailable/);
});
