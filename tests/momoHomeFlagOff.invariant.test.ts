// MoMo's home stays off until its blockers are closed: the stack landed with the review's open items (stale-stamp refusal in every real receiver, the move queue, timeouts, and the rest), so `momo.home` must default to false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

test('the `momo.home` flag defaults to false while the blockers for turning it on are open (mopilot-ai/mopilot-internal#5474)', () => {
  const flag = (FLAG_DEFS as readonly { key: string; default: boolean }[]).find((f) => f.key === 'momo.home');
  assert.ok(flag, 'the `momo.home` flag is defined');
  assert.equal(
    flag.default,
    false,
    [
      '`momo.home` must stay off by default until every blocker is closed (listed on mopilot-ai/mopilot-internal#5474):',
      'a. stale-stamp refusal in every real receiver (Host↔Host, push bridge, phone, chat-turn receivers; the Host cannot verify that a client asked the target first);',
      'b. reset, start and grant go through the move queue;',
      'c. timeouts on the awaits inside the queue (stopTurns, pause hooks);',
      'd. a sealed move never expires: every client shows it with the reclaim action;',
      'e. a monotonic marker instead of acceptedAt < openedAt in the turn ledger;',
      'f. after a reclaim, the user is told what the fenced-out machine accepted;',
      'g. a wire test for check-turn `missing`;',
      'h. the NOT_LEDGERED additions and retry: true on move_expired / bundle_* are justified.',
      'Close them, update this test and the issue, then flip the default.',
    ].join('\n'),
  );
});
