// The organization access service's renewal and take-back (electron/host/orgAccess/service.cjs): one refresh per renewal at 80% of life, single-flight refresh, and a lease a machine still holds from before an app restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, CONFIG, setup, tick, id } from './support/orgAccessKit.ts';

test('a turn spanning a renewal: at 80% of the life every lent lease gets a fresh token, and the next renewal is scheduled', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const h = s.host();
  await s.svc.lend(h, 'claude');
  await s.svc.lend(h, 'codex');
  assert.equal(s.clock.pending, 1);
  s.clock.advance(47 * 60_000);
  assert.equal(h.calls.length, 2);
  s.clock.advance(60_000);
  await tick();
  assert.deepEqual(
    h.calls.slice(2).map((c: any) => [c.harness, c.token]),
    [
      ['claude', 'access-renewed-1-aaaa'],
      ['codex', 'access-renewed-1-aaaa'],
    ],
  );
  assert.equal(s.clock.pending, 1);
  s.svc.dispose();
});

test('renewal stops quietly when the sign-in ended; drops a host that cannot be reached and reports; skips a harness that lost its gateway', async (t) => {
  const quiet = setup(t);
  await quiet.svc.configure(CONFIG);
  await quiet.svc.signIn();
  const qh = quiet.host();
  await quiet.svc.lend(qh, 'claude');
  quiet.o.refreshError = Object.assign(new Error('gone'), { code: 'signin_required' });
  quiet.clock.advance(48 * 60_000);
  await tick();
  assert.equal(qh.calls.length, 1);
  assert.deepEqual([quiet.reports.length, quiet.clock.pending], [0, 0]);

  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const down = s.host();
  const up = s.host();
  await s.svc.lend(down, 'claude');
  await s.svc.lend(up, 'claude');
  down.fail = new Error('offline');
  s.clock.advance(48 * 60_000);
  await tick();
  assert.equal(s.reports.length, 1);
  assert.equal(s.reports[0].message, 'offline');
  assert.equal(up.calls.at(-1).token, 'access-renewed-1-aaaa');
  assert.equal(s.o.refreshes.length, 1);
  // the dropped host is not told again at sign-out; the other one is
  const sent = down.calls.length;
  await s.svc.signOut();
  assert.equal(down.calls.length, sent);
  assert.deepEqual(up.calls.at(-1), { harness: 'claude', identity: id(), token: null });

  const gone = setup(t);
  await gone.svc.configure(CONFIG);
  await gone.svc.signIn();
  const gh = gone.host();
  await gone.svc.lend(gh, 'claude');
  gone.patch((r) => (r.config.access.gateways = { openai: 'https://gw.example.test/o' }));
  gone.clock.advance(48 * 60_000);
  await tick();
  assert.deepEqual([gh.calls.length, gone.reports.length, gone.clock.pending], [1, 0, 0]);
});

test('a sooner lease replaces a later renewal timer; a later one keeps the sooner', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  s.o.lifeMs = 10 * HOUR;
  await s.svc.signIn();
  const h = s.host();
  await s.svc.lend(h, 'claude');
  s.patch((r) => (r.config.leaseHours = 1));
  await s.svc.lend(h, 'codex');
  assert.equal(s.clock.pending, 1);
  s.clock.advance(48 * 60_000);
  await tick();
  assert.equal(h.calls.length, 4);
  s.svc.dispose();
});

test('without a report callback a failed renewal is still dropped quietly', async (t) => {
  const s = setup(t, { quiet: true });
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  const h = s.host();
  await s.svc.lend(h, 'claude');
  h.fail = new Error('offline');
  s.clock.advance(48 * 60_000);
  await tick();
  assert.equal(h.calls.length, 2);
});

test('concurrent lends with a stale token share one refresh; a failed refresh is not kept, the next call asks again', async (t) => {
  const s = setup(t);
  await s.svc.configure(CONFIG);
  await s.svc.signIn();
  s.clock.advance(55 * 60_000);
  let open: () => void = () => undefined;
  s.o.refreshGate = new Promise((r) => (open = r));
  const h = s.host();
  const both = Promise.all([s.svc.lend(h, 'claude'), s.svc.lend(h, 'codex')]);
  await tick();
  open();
  assert.deepEqual(await both, [true, true]);
  assert.equal(s.o.refreshes.length, 1);
  assert.equal(h.calls[0].token, h.calls[1].token);
  s.svc.dispose();

  const f = setup(t);
  await f.svc.configure(CONFIG);
  await f.svc.signIn();
  f.clock.advance(55 * 60_000);
  f.o.refreshError = new Error('offline');
  await assert.rejects(f.svc.lend(f.host(), 'claude'), { code: 'org_unavailable' });
  f.o.refreshError = undefined;
  assert.equal(await f.svc.lend(f.host(), 'claude'), true);
  assert.equal(f.o.refreshes.length, 2);
  f.svc.dispose();
});

test('a lease a machine may still hold from before is taken back by the next message, even after an app restart', async (t) => {
  for (const end of ['signOut', 'remove'] as const) {
    const s = setup(t);
    await s.svc.configure(CONFIG);
    await s.svc.signIn();
    await s.svc[end]();
    assert.equal(s.rec().former, id());
    // the app restarted: a new service on the same file
    const again = s.make();
    const harness = end === 'signOut' ? 'claude' : 'codex';
    const h = s.host();
    if (end === 'signOut') {
      // settings still there but no gateway for this harness: nothing to lend, but the old lease goes
      s.patch((r) => (r.config.access.gateways = { openai: 'https://gw.example.test/o' }));
      assert.equal(await again.lend(h, 'claude'), false);
    } else {
      assert.equal(await again.lend(h, 'codex'), false);
    }
    assert.deepEqual(h.calls, [{ harness: end === 'signOut' ? 'claude' : 'codex', identity: id(), token: null }]);
    // a harness that is not an organization one gets nothing
    for (const other of ['', 'gemini']) assert.equal(await again.lend(h, other), false);
    assert.equal(h.calls.length, 1);
    // an older Host never held one; any other refusal is the caller's
    const old = s.host();
    old.fail = Object.assign(new Error('old'), { code: 'feature_missing' });
    assert.equal(await again.lend(old, harness), false);
    const bad = s.host();
    bad.fail = Object.assign(new Error('down'), { code: 'closed' });
    await assert.rejects(again.lend(bad, harness), { code: 'closed' });
  }
});

test('no former identity, nothing to take back', async (t) => {
  const s = setup(t);
  const h = s.host();
  assert.equal(await s.svc.lend(h, 'claude'), false);
  assert.equal(h.calls.length, 0);
});
