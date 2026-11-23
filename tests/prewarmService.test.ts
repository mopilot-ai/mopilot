// The shared prewarm service (electron/session/contract/prewarm.cjs, #1664): one entry per composer, its key the hook computes
// now, a take at most once that waits for a warm still in flight, and every way an entry is let go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick as settle } from './support/async-scenarios.ts';

const { createPrewarm, IDLE_MS, RETRY_MS } = createRequire(import.meta.url)('../electron/session/contract/prewarm.cjs');

/** A hook whose key is the spec's `k` (null: nothing to warm) and whose warms the test settles one by one. */
function fakeHook(o: { valid?: (h: any) => boolean; claim?: boolean; keyThrows?: boolean; disposeThrows?: 'sync' | 'async' } = {}) {
  const warms: { spec: any; resolve: (h: any) => void; reject: (e: unknown) => void }[] = [];
  const disposed: any[] = [];
  const claimed: any[] = [];
  const hook: any = {
    key: (spec: any) => {
      if (o.keyThrows) throw new Error('no settings');
      return spec.k ?? null;
    },
    warm: (spec: any) => new Promise((resolve, reject) => warms.push({ spec, resolve, reject })),
    dispose: (h: any) => {
      disposed.push(h);
      if (o.disposeThrows === 'sync') throw new Error('gone');
      if (o.disposeThrows === 'async') return Promise.reject(new Error('gone'));
      return undefined;
    },
  };
  if (o.valid) hook.valid = o.valid;
  if (o.claim !== false)
    hook.claim = (h: any) => {
      claimed.push(h);
      return { id: h.id };
    };
  return { hook, warms, disposed, claimed };
}

/** Timers the test fires by hand; `now` moves with them. */
function fakeTimers() {
  let t = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  return {
    now: () => t,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        pending.set(id, { at: t + ms, fn });
        return { id, unref() {} } as any;
      },
      clearTimeout: (h: any) => h && pending.delete(h.id),
    } as any,
    advance(ms: number) {
      t += ms;
      for (const [id, p] of [...pending]) if (p.at <= t) pending.delete(id), p.fn();
    },
  };
}

function rig(hookOpts = {}, o: { enabled?: () => boolean } = {}) {
  const claude = fakeHook(hookOpts);
  const clock = fakeTimers();
  const pw = createPrewarm({ hooks: { claude: claude.hook, codex: null, acp: null }, now: clock.now, timers: clock.timers, ...o });
  return { pw, claude, clock };
}

test('a warmed entry serves its own composer once: the take answers the claim, and a second take answers null', async () => {
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve({ id: 's1' });
  assert.deepEqual(await pw.take(1, { kind: 'claude', k: 'a' }), { id: 's1' });
  assert.equal(await pw.take(1, { kind: 'claude', k: 'a' }), null);
  assert.deepEqual(claude.claimed, [{ id: 's1' }]);
  assert.deepEqual(claude.disposed, []);
  assert.equal(pw.size(), 0);
});

test('I2: another window takes nothing from this one, and a key that changed since the warm is let go, not used', async () => {
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve({ id: 's1' });
  assert.equal(await pw.take(2, { kind: 'claude', k: 'a' }), null);
  // the account (or model, folder, permission) the send uses now differs from the one it warmed with
  assert.equal(await pw.take(1, { kind: 'claude', k: 'b' }), null);
  assert.deepEqual(claude.disposed, [{ id: 's1' }]);
  assert.deepEqual(claude.claimed, []);
});

test('A3: a take while the warm is in flight waits for it; one whose warm then fails answers null (the send starts cold)', async () => {
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  const taking = pw.take(1, { kind: 'claude', k: 'a' });
  // the composer leaving while the take waits doesn't take it back
  pw.hint(1, null);
  claude.warms[0].resolve({ id: 's1' });
  assert.deepEqual(await taking, { id: 's1' });
  assert.deepEqual(claude.disposed, []);

  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  const failing = pw.take(1, { kind: 'claude', k: 'a' });
  claude.warms[1].reject(new Error('Claude Code is not installed'));
  assert.equal(await failing, null);
});

test('A1/A2: a new key replaces the entry; the older warm settling later (either way) is let go and never served', async () => {
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  pw.hint(1, { kind: 'claude', k: 'b' });
  pw.hint(1, { kind: 'claude', k: 'c' });
  await settle();
  assert.equal(claude.warms.length, 3);
  claude.warms[2].resolve({ id: 'c' });
  claude.warms[0].resolve({ id: 'a' });
  claude.warms[1].reject(new Error('late failure'));
  await settle();
  assert.deepEqual(claude.disposed, [{ id: 'a' }]);
  assert.deepEqual(await pw.take(1, { kind: 'claude', k: 'c' }), { id: 'c' });
});

test('the same key again only keeps the entry; a failed one is warmed again only after RETRY_MS', async () => {
  const { pw, claude, clock } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  assert.equal(claude.warms.length, 1);
  claude.warms[0].reject(new Error('signed out'));
  await settle();
  pw.hint(1, { kind: 'claude', k: 'a' });
  assert.equal(claude.warms.length, 1, 'a heartbeat right after the failure does not warm again');
  clock.advance(RETRY_MS);
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  assert.equal(claude.warms.length, 2);
});

test('the same key warms again once the ready handle can no longer serve (its process exited while the composer stayed open)', async () => {
  let alive = true;
  const { pw, claude } = rig({ valid: () => alive });
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  pw.hint(1, { kind: 'claude', k: 'a' });
  assert.equal(claude.warms.length, 1, 'still warming: kept');
  claude.warms[0].resolve({ id: 'a' });
  await settle();
  pw.hint(1, { kind: 'claude', k: 'a' });
  assert.equal(claude.warms.length, 1, 'ready and valid: kept');
  alive = false;
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  assert.equal(claude.warms.length, 2);
  assert.deepEqual(claude.disposed, [{ id: 'a' }]);
});

test('A6: a heartbeat inside the idle window keeps the entry; IDLE_MS without one lets it go', async () => {
  const { pw, claude, clock } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve({ id: 's1' });
  await settle();
  clock.advance(IDLE_MS - 1);
  pw.hint(1, { kind: 'claude', k: 'a' });
  clock.advance(IDLE_MS - 1);
  assert.deepEqual(claude.disposed, []);
  clock.advance(1);
  assert.deepEqual(claude.disposed, [{ id: 's1' }]);
  assert.equal(pw.size(), 0);
});

test('A3/A5: released while warming, it goes once it settles; releaseAll (quit) lets every window go', async () => {
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  pw.hint(2, { kind: 'claude', k: 'b' });
  await settle();
  pw.release(1);
  assert.deepEqual(claude.disposed, []);
  claude.warms[0].resolve({ id: 'a' });
  await settle();
  assert.deepEqual(claude.disposed, [{ id: 'a' }]);
  claude.warms[1].resolve({ id: 'b' });
  await settle();
  pw.releaseAll();
  assert.deepEqual(claude.disposed, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(await pw.take(2, { kind: 'claude', k: 'b' }), null);
  pw.release(3);
});

test('a ready handle the hook says can no longer serve (its process quit) is let go at the take', async () => {
  const { pw, claude } = rig({ valid: (h: any) => h.id !== 'dead' });
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve({ id: 'dead' });
  assert.equal(await pw.take(1, { kind: 'claude', k: 'a' }), null);
  assert.deepEqual(claude.disposed, [{ id: 'dead' }]);
  // a hook without a claim answers null for a valid one
  const plain = rig({ claim: false });
  plain.pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  plain.claude.warms[0].resolve({ id: 'p' });
  assert.equal(await plain.pw.take(1, { kind: 'claude', k: 'a' }), null);
  assert.deepEqual(plain.claude.disposed, []);
});

test('nothing is warmed when the switch is off, for no spec, a null key, a family with no hook or a kind main does not know', async () => {
  const off = rig({}, { enabled: () => false });
  off.pw.hint(1, { kind: 'claude', k: 'a' });
  const { pw, claude } = rig();
  pw.hint(1, null);
  pw.hint(1, { kind: 42 });
  pw.hint(1, { kind: 'claude' });
  pw.hint(1, { kind: 'codex', k: 'a' });
  pw.hint(1, { kind: 'nope:x:y', k: 'a' });
  await settle();
  assert.equal(off.claude.warms.length + claude.warms.length, 0);
  assert.equal(pw.size() + off.pw.size(), 0);
  assert.equal(await pw.take(1, { kind: 'claude', k: 'a' }), null);
});

test('a key that throws warms nothing, and a hint that turns null lets a ready entry go', async () => {
  const bad = rig({ keyThrows: true });
  bad.pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  assert.equal(bad.claude.warms.length, 0);
  const { pw, claude } = rig();
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve(undefined);
  await settle();
  // a warm that answered no handle has nothing to let go or take
  assert.equal(await pw.take(1, { kind: 'claude', k: 'a' }), null);
  pw.hint(1, { kind: 'claude', k: 'b' });
  await settle();
  claude.warms[1].resolve({ id: 'b' });
  await settle();
  pw.hint(1, null);
  assert.deepEqual(claude.disposed, [{ id: 'b' }]);
});

for (const how of ['sync', 'async'] as const)
  test(`B2: a dispose that fails (${how}) is noted, and the service goes on`, async () => {
    const { pw, claude } = rig({ disposeThrows: how });
    pw.hint(1, { kind: 'claude', k: 'a' });
    await settle();
    claude.warms[0].resolve({ id: 'a' });
    await settle();
    pw.release(1);
    await settle();
    pw.hint(1, { kind: 'claude', k: 'b' });
    await settle();
    assert.equal(claude.warms.length, 2);
  });

test('the defaults: real timers (unref), Date.now, and switched on', async () => {
  const claude = fakeHook();
  const pw = createPrewarm({ hooks: { claude: claude.hook, codex: null, acp: null } });
  pw.hint(1, { kind: 'claude', k: 'a' });
  await settle();
  claude.warms[0].resolve({ id: 'a' });
  assert.deepEqual(await pw.take(1, { kind: 'claude', k: 'a' }), { id: 'a' });
  pw.hint(1, { kind: 'claude', k: 'a' });
  pw.releaseAll();
});
