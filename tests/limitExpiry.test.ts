// A quota limit lifts at its reset, for every harness: a Claude Code limit at the reset time the CLI printed,
// a Codex window at the reset its reading carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageText } from '../src/harness/claudeUsage.ts';
import { accountStatusText, claudeAccounts, codexAccounts } from '../src/harness/accounts.ts';
import { harnessAccountView } from '../src/harness/accountView.ts';

const status = (usage: any) => ({ state: 'ready', bin: '/x', version: null, plan: 'Claude Max', usage }) as any;

test('a parsed limit counts until the reset the CLI printed, in the zone it named, and not after', (t) => {
  // Oct 15 2026 at 0:00 in Los Angeles, when the CLI printed its (cached) answer
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 7) });
  const usage = parseUsageText(
    'Current session: 0% used\nCurrent week (all models): 100% used · resets Oct 18 at 11am (America/Los_Angeles)\nCurrent week (Fable): 0% used · resets Oct 18 at 11am (America/Los_Angeles)',
  )!;
  const weekly = usage.windows.find((w) => w.label === 'Weekly')!;
  assert.equal(weekly.resetsAt, Date.UTC(2026, 9, 18, 18) / 1000);
  const before = claudeAccounts(status(usage)).active!;
  assert.deepEqual(before.limited, { resetsAt: weekly.resetsAt });
  assert.equal(accountStatusText(before).text, 'Limit reached · resets in 3d 11h');
  // the week started over: the same reading no longer limits the account, and none of the new week is used
  t.mock.timers.setTime(Date.UTC(2026, 9, 18, 18, 1));
  const after = claudeAccounts(status(usage)).active!;
  assert.equal(after.limited, null);
  assert.equal(after.left, 100);
  assert.match(accountStatusText(after).text, /^100% left · updated \d+m ago$/);
  // the picker's short form says the same
  assert.equal(harnessAccountView(status(usage), claudeAccounts(status(usage))).active?.short, '100% left');
});

test('a Codex account whose window passed its reset is not limited, and that window counts as started over', () => {
  const now = Math.floor(Date.now() / 1000);
  const limits = {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now - 60 },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: now + 3600 },
    used: 100,
    reached: true,
    resetsAt: now - 60,
    at: Date.now() - 20 * 60_000,
  };
  const pool = { active: 'a', autoSwitch: true, accounts: [{ id: 'a', kind: 'chatgpt', status: 'ok', email: 'a@example.com', limits }] };
  const a = codexAccounts({ accounts: pool as any, account: null, rateLimits: null }).active!;
  assert.equal(a.limited, null);
  assert.equal(a.left, 70);
  // the app-server's own login, read live: the same
  const live = codexAccounts({
    accounts: { active: null, accounts: [] } as any,
    account: { type: 'chatgpt', email: 'b@example.com' },
    rateLimits: { rateLimits: { primary: limits.primary, secondary: limits.secondary } },
  }).active!;
  assert.equal(live.left, 70);
});
