// Reset-card rendering and safe, account-scoped redemption behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { deferred } from './support/async-scenarios.ts';
import {
  fixture,
  mount,
  unmount,
  click,
  focus,
  expanded,
  card,
  reply,
  root,
  host,
  CodexResetCards,
  ClaudeResetCards,
} from './support/reset-cards-kit.ts';
test('Codex reset cards require a subscription account', async () => {
  for (const active of [null, { id: 'key', kind: 'apiKey' }]) {
    fixture({ codex: active });
    await mount();
    assert.equal(host.textContent, '');
    await unmount();
  }
});

test('cards show account, offer, expiry, history and official usage navigation', async () => {
  const f = fixture({
    reply: reply([
      card(),
      card({ id: 'used', status: 'redeemed', expiresAt: null }),
      card({ id: 'expired', expiresAt: 1 }),
      card({ id: 'pending', status: 'redeeming' }),
      card({ id: 'unknown', status: 'unknown' }),
    ]),
  });
  await mount();
  assert.match(host.textContent!, /a@test.*Restore the weekly limit.*Expires/);
  assert.deepEqual(f.reads, ['a']);
  assert.equal(f.updates.length, 1);
  await click('Open Codex Usage');
  assert.deepEqual(f.opened, ['https://chatgpt.com/codex/settings/usage']);
  await click('History');
  assert.match(host.textContent!, /Used/);
  assert.match(host.textContent!, /Expired/);
  assert.match(host.textContent!, /Redemption in progress/);
  assert.match(host.textContent!, /Status unavailable/);
  await click('Available 1');
  assert.equal(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Refresh'),
    false,
  );
  assert.equal(host.querySelector('.usage-reset-expiry')?.textContent?.startsWith('Expires'), true);
  await expanded(true);
  await focus();
  assert.equal(f.reads.length, 3);
  await unmount();
});

test('count-only and capped card lists offer a next-card action without inventing details', async () => {
  for (const cards of [null, [], [card({ expiresAt: null, title: null, description: null })]]) {
    const f = fixture({ reply: reply(cards, 2) });
    await mount();
    assert.match(host.textContent!, /More resets available/);
    await click('Use next reset');
    assert.deepEqual(f.consumes, [['a', null]]);
    assert.match(f.confirmations[0], /a@test.*cannot be undone/);
    await unmount();
  }
});

test('null summary, empty availability and absent history are distinct', async () => {
  for (const response of [{}, { rateLimitResetCredits: null }, reply([], 0), reply([], 'unknown')]) {
    fixture({ reply: response });
    await mount();
    assert.match(host.textContent!, /information is not available|No resets available/);
    await unmount();
  }
  fixture({ reply: reply([], 0) });
  await mount();
  await click('History');
  assert.match(host.textContent!, /No reset history was returned/);
  await unmount();
});

test('loading and errors do not claim an empty wallet; refreshing recovers', async () => {
  const pending = deferred(),
    f = fixture({ read: () => pending.promise });
  await mount();
  assert.match(host.textContent!, /Loading reset cards/);
  await act(async () => pending.reject('Offline'));
  assert.match(host.textContent!, /Could not load reset cards.*Offline/);
  assert.doesNotMatch(host.textContent!, /No resets available/);
  f.read = async () => f.reply;
  await click('Retry');
  assert.match(host.textContent!, /Weekly reset/);
  await unmount();
});

test('known redemption outcomes show the actual result and refresh cards and quota', async () => {
  for (const [outcome, message] of [
    ['reset', 'Usage limits reset'],
    ['nothingToReset', 'do not need a reset'],
    ['noCredit', 'No reset is available'],
    ['alreadyRedeemed', 'already redeemed'],
  ]) {
    const f = fixture({ outcome });
    await mount();
    await click('Use reset');
    assert.match(f.toasts[0][0], new RegExp(message));
    assert.equal(f.toasts[0][1] === 'success', outcome === 'reset');
    assert.equal(f.reads.length, 2);
    await unmount();
  }
});

test('cancel, expired accounts and expired cards never redeem', async () => {
  const f = fixture({ confirmed: false });
  await mount();
  await click('Use reset');
  assert.equal(f.consumes.length, 0);
  await unmount();
  const expired = fixture({ state: { accounts: { active: 'a', accounts: [{ id: 'a', status: 'expired' }] } } });
  await mount();
  await click('Use reset');
  assert.equal(expired.consumes.length, 0);
  await unmount();
  fixture({ reply: reply([card({ expiresAt: 1 })], 0) });
  await mount();
  assert.doesNotMatch(host.textContent!, /Use reset/);
  await unmount();
});

test('a redemption in progress blocks repeat clicks and focus refresh', async () => {
  const pending = deferred(),
    f = fixture({
      consume: (...args: any[]) => {
        f.consumes.push(args);
        return pending.promise;
      },
    });
  await mount();
  await click('Use reset');
  assert.match(host.textContent!, /Using reset/);
  await focus();
  assert.equal(f.reads.length, 1);
  assert.equal(f.consumes.length, 1);
  await act(async () => pending.resolve({ outcome: 'reset' }));
  assert.equal(f.reads.length, 2);
  await unmount();
});

test('ambiguous failures and unknown outcomes offer retry without another confirmation', async () => {
  for (const failure of [new Error('Timeout'), 'Timeout', { outcome: 'future' }]) {
    const f = fixture({
      consume: async (...args: any[]) => {
        f.consumes.push(args);
        if (f.consumes.length === 1) {
          if ('outcome' in Object(failure)) return failure;
          throw failure;
        }
        return { outcome: 'alreadyRedeemed' };
      },
    });
    await mount();
    await click('Use reset');
    assert.match(host.textContent!, /Reset result needs confirmation/);
    assert.match(f.toasts[0][0], /Retry/);
    await click('Retry reset');
    assert.deepEqual(f.consumes, [
      ['a', 'card'],
      ['a', 'card'],
    ]);
    assert.equal(f.confirmations.length, 1);
    assert.doesNotMatch(host.textContent!, /needs confirmation/);
    await unmount();
  }
});

test('missing card titles use a neutral label and do not promise a full reset', async () => {
  const f = fixture({ reply: reply([card({ title: null, description: null, expiresAt: null })]) });
  await mount();
  await click('Use reset');
  assert.match(f.confirmations[0], /Usage limit reset/);
  assert.doesNotMatch(host.textContent!, /Full reset/);
  await unmount();
});

test('slow reads and redemptions ignore unmounted components or a newly selected account', async () => {
  const pending = deferred(),
    f = fixture({ read: () => pending.promise });
  await mount();
  await unmount();
  await act(async () => pending.resolve(reply()));
  assert.equal(f.updates.length, 0);
  const redeem = deferred(),
    g = fixture({ consume: () => redeem.promise });
  await mount();
  await click('Use reset');
  await unmount();
  await act(async () => redeem.resolve({ outcome: 'reset' }));
  assert.equal(g.reads.length, 1);
  const read = deferred(),
    h = fixture({ read: () => read.promise });
  await mount();
  h.state.accounts.active = 'b';
  await act(async () => read.resolve(reply()));
  assert.equal(h.updates.length, 0);
  await unmount();
});

test('Claude opens official redemption for the selected email and refreshes on return', async () => {
  const f = fixture();
  await mount(ClaudeResetCards);
  assert.match(host.textContent!, /c@test/);
  await click('Open Claude Usage');
  assert.deepEqual(f.opened, ['https://claude.ai/settings/usage']);
  await focus();
  await expanded(true, ClaudeResetCards);
  assert.equal(f.claudeReads, 3);
  assert.doesNotMatch(host.textContent!, /Refresh after using a reset|Refresh usage/);
  await unmount();
  fixture({ claude: null });
  await mount(ClaudeResetCards);
  assert.match(host.textContent!, /your Claude Code account/);
  await unmount();
});

test('Claude refresh blocks overlap and surfaces refresh errors', async () => {
  const pending = deferred(),
    f = fixture({
      refreshClaude: () => {
        f.claudeReads++;
        return pending.promise;
      },
    });
  await mount(ClaudeResetCards);
  await focus();
  assert.equal(f.claudeReads, 1);
  assert.match(host.textContent!, /Refreshing/);
  await act(async () => pending.reject(new Error('Offline')));
  assert.match(host.textContent!, /Could not refresh usage.*Offline/);
  await unmount();
});

test('focus during a pending read is deduplicated and read errors after unmount are ignored', async () => {
  const pending = deferred(),
    f = fixture({
      read: (id: string) => {
        f.reads.push(id);
        return pending.promise;
      },
    });
  await mount();
  await focus();
  assert.equal(f.reads.length, 1);
  await unmount();
  await act(async () => pending.reject(new Error('Offline')));
  assert.equal(f.toasts.length, 0);
});

test('two clicks before rendering the pending state issue only one redemption', async () => {
  const pending = deferred(),
    f = fixture({
      consume: (...args: any[]) => {
        f.consumes.push(args);
        return pending.promise;
      },
    });
  await mount();
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use reset')!;
  await act(async () => {
    button.click();
    button.click();
  });
  assert.equal(f.consumes.length, 1);
  await act(async () => pending.resolve({ outcome: 'reset' }));
  await unmount();
});

test('a card that expires between rendering and clicking cannot be redeemed', async () => {
  const f = fixture({ reply: reply([card({ expiresAt: Date.now() / 1000 + 60 })]) });
  await mount();
  const now = Date.now;
  Date.now = () => now() + 120000;
  try {
    await click('Use reset');
    assert.equal(f.consumes.length, 0);
    assert.equal(f.reads.length, 2);
    assert.match(f.toasts[0][0], /expired/);
  } finally {
    Date.now = now;
    await unmount();
  }
});

test('expiry timer updates availability and pending count-only redemption label', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  fixture({ reply: reply([card({ expiresAt: Date.now() / 1000 + 60 })], 0) });
  await mount();
  const now = Date.now;
  Date.now = () => now() + 120000;
  try {
    await act(async () => t.mock.timers.tick(30000));
    assert.doesNotMatch(host.textContent!, /Use reset/);
  } finally {
    Date.now = now;
    await unmount();
  }
  const pending = deferred();
  fixture({ reply: reply(null, 1), consume: () => pending.promise });
  await mount();
  await click('Use next reset');
  assert.match(host.textContent!, /Using reset/);
  await act(async () => pending.resolve({ outcome: 'reset' }));
  await unmount();
});

test('an ambiguous redemption can still be checked after its card expires', async () => {
  const f = fixture({
    consume: async (...args: any[]) => {
      f.consumes.push(args);
      if (f.consumes.length === 1) throw new Error('Timeout');
      return { outcome: 'alreadyRedeemed' };
    },
  });
  await mount();
  await click('Use reset');
  f.reply = reply([card({ expiresAt: 1 })], 0);
  await focus();
  await click('Retry reset');
  assert.equal(f.consumes.length, 2);
  await unmount();
});

test('switching accounts remounts the wallet and drops the previous account cards', async () => {
  const old = deferred(),
    f = fixture({
      read: (id: string) => {
        f.reads.push(id);
        return id === 'a' ? old.promise : Promise.resolve(reply([card({ title: 'B reset' })]));
      },
    });
  await mount();
  f.codex = { id: 'b', email: 'b@test', kind: 'subscription' };
  f.state.accounts = { active: 'b', accounts: [{ id: 'b', status: 'ok' }] };
  await act(async () => root!.render(createElement(CodexResetCards)));
  assert.match(host.textContent!, /b@test.*B reset/);
  await act(async () => old.resolve(reply()));
  assert.doesNotMatch(host.textContent!, /a@test|Weekly reset/);
  await click('Use reset');
  assert.deepEqual(f.consumes, [['b', 'card']]);
  await unmount();
});

test('a successful redemption followed by a failed refresh remains successful and offers refresh recovery', async () => {
  const f = fixture({
    read: async (id: string) => {
      f.reads.push(id);
      if (f.reads.length > 1) throw new Error('Refresh offline');
      return f.reply;
    },
  });
  await mount();
  await click('Use reset');
  assert.deepEqual(f.toasts, [['Usage limits reset', 'success']]);
  assert.match(host.textContent!, /Could not load reset cards.*Refresh offline/);
  assert.doesNotMatch(host.textContent!, /Reset result needs confirmation/);
  await unmount();
});
