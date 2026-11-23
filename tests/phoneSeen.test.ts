// A paired phone's presence line in Settings › Mobile Remote (src/components/pages/settings/phoneSeen.ts): Online while connected,
// otherwise when it was last seen in plain words, never a raw timestamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { phoneLine, phoneSeen } = await import('../src/components/pages/settings/phoneSeen.ts');

const now = new Date(2026, 10, 2, 15, 30).getTime();
const seen = (at: number | null, online = false) => phoneSeen({ online, lastSeenAt: at }, now);
const MIN = 60_000;

test('connected reads Online, whenever it was last seen', () => {
  assert.equal(seen(null, true), 'Online');
  assert.equal(seen(now - 3 * 86_400_000, true), 'Online');
});

test('never seen has no line', () => {
  assert.equal(seen(null), null);
});

test('recent times count minutes, then hours on the same day', () => {
  assert.equal(seen(now - 20_000), 'Last seen just now');
  assert.equal(seen(now + 5_000), 'Last seen just now', 'a clock a little ahead is not the future');
  assert.equal(seen(now - 5 * MIN), 'Last seen 5 min ago');
  assert.equal(seen(now - 59 * MIN), 'Last seen 59 min ago');
  assert.equal(seen(now - 3 * 60 * MIN), 'Last seen 3 hr ago');
});

test('earlier days read yesterday, then days ago, then the date', () => {
  assert.equal(seen(new Date(2026, 10, 1, 23, 50).getTime()), 'Last seen yesterday', 'late last night is yesterday, not 15 hr ago');
  assert.equal(seen(new Date(2026, 9, 29, 9).getTime()), 'Last seen 4 days ago');
  const sameYear = new Date(2026, 9, 3, 9);
  assert.equal(seen(sameYear.getTime()), `Last seen ${sameYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  const lastYear = new Date(2025, 9, 3, 9);
  assert.equal(
    seen(lastYear.getTime()),
    `Last seen ${lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
  );
});

test('the line adds the day it was paired, so two phones of one name read apart', () => {
  const pairedAt = new Date(2026, 9, 3).getTime();
  const day = pairedAt && new Date(pairedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  assert.equal(phoneLine({ connection: 'connected', online: true, lastSeenAt: null, pairedAt }, now), `Connected · Paired ${day}`);
  assert.equal(phoneLine({ connection: 'offline', online: false, lastSeenAt: null, pairedAt }, now), `Offline · Paired ${day}`);
  const lastYear = new Date(2025, 9, 3).getTime();
  assert.match(
    phoneLine({ connection: 'unknown', online: false, lastSeenAt: null, pairedAt: lastYear }, now),
    /^Status unavailable · Paired .*2025$/,
  );
});
