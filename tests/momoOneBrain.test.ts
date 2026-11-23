// One brain, one rule, one greeting and the Notifications row's notice in MoMo's background work (electron/app/momoBackground.cjs, #2527): per-role settings an older build saved are folded into the one brain and rule at startup; one at-limit rule drives the main chat and routines (#2306, #2365); setup's last step has MoMo greet once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const done = async (w: any) => {
  await w.m.close();
  setMomoContextProvider(null);
};

test('per-role settings an older build saved become the one brain and rule at startup; a current one is left alone', async () => {
  const old = world({
    allowed: true,
    prefs: { momo: { atLimit: { main: 'pause', routines: 'skip' }, brain: { routines: { harness: 'codex' } } } },
  });
  assert.equal(old.prefs.momo.atLimit, 'pause');
  assert.equal(old.prefs.momo.brain.main.harness, 'codex', 'never left with no brain');
  assert.equal(old.prefs.momo.brain.routines, undefined);
  await done(old);
  const current = world({ allowed: true, prefs: { momo: { atLimit: 'skip', brain: { main: { harness: 'claude' } } } } });
  assert.equal(current.prefs.momo.atLimit, 'skip');
  assert.deepEqual(current.prefs.momo.brain, { main: { harness: 'claude' } }, 'not rewritten');
  await done(current);
});

test('a migration whose write was refused is noted and leaves the old shapes readable', async () => {
  const w = world({
    allowed: true,
    patchOk: false,
    prefs: { momo: { atLimit: { main: 'pause' }, brain: { routines: { harness: 'codex' } } } },
  });
  assert.deepEqual(w.prefs.momo.atLimit, { main: 'pause' }, 'not written');
  assert.ok(recentIgnored().some((e: any) => /fold MoMo's per-role settings/.test(e.context ?? e.message ?? String(e))));
  await done(w);
});

test('setup’s Start has MoMo greet in its main chat, once', async () => {
  const w = world({ allowed: true });
  assert.deepEqual(await w.call('momoChat:greet'), { value: true });
  assert.equal(w.ran.length, 1, 'one message, sent as MoMo’s own');
  const chatId = w.ran[0][0];
  assert.equal(w.chats.record(chatId).meta.momo, 'main', 'in the main chat');
  assert.deepEqual(await w.call('momoChat:greet'), { value: false }, 'not again');
  assert.equal(w.ran.length, 1);
  await done(w);
  // refused while MoMo is off
  const off = world({ allowed: false });
  assert.equal((await off.call('momoChat:greet')).error.code, 'not_allowed');
  assert.equal(off.ran.length, 0);
  await done(off);
});

test('setup’s Notifications row: MoMo says its notifications are on, as one notice; refused while MoMo is off (#2607)', async () => {
  const w = world({ allowed: true });
  assert.deepEqual(await w.call('momoChat:enableNotices'), { value: true });
  assert.deepEqual(w.live.notifier.noticed, [{ title: 'MoMo notifications are on', body: 'You’ll hear from MoMo when it needs you.' }]);
  assert.equal(w.ran.length, 0, 'no message to a model: the notice is not a message');
  await done(w);
  const off = world({ allowed: false });
  assert.equal((await off.call('momoChat:enableNotices')).error.code, 'not_allowed');
  assert.deepEqual(off.live.notifier.noticed, []);
  await done(off);
});

test('one at-limit rule drives MoMo’s main chat and routines alike (#2306, #2365, #2527)', async () => {
  const w = world({ allowed: true });
  w.m.mainChat.current = () => 'mc';
  const brain = { harness: 'claude', account: 'du@work', model: null };
  const next = { account: 'du@home', kind: 'harnessAuth', billing: 'subscription', status: 'ok', limited: false };
  const out = { account: 'du@work', kind: 'harnessAuth', billing: 'subscription', status: 'ok', limited: true };
  w.live.identity.instances = (h: string) => (h === 'claude' ? [out, next] : []);
  const each = () => ({
    main: w.live.heldChat('mc'),
    routines: w.m.routines.o.atLimit(brain),
  });
  w.prefs.momo = { ...w.prefs.momo, brain: { main: brain } };
  // the default, Next account: every kind of work moves to the other account (the main chat is not held)
  let r = each();
  assert.equal(r.main, null);
  assert.equal(r.routines.go.account, 'du@home');
  // Pause: all of them held for the same reason
  w.prefs.momo = { ...w.prefs.momo, atLimit: 'pause' };
  r = each();
  assert.equal(r.main, 'MoMo is paused: Claude Code is at its limit.');
  assert.equal(r.routines.held, 'Claude Code is at its limit');
  // Skip this run: held too (a run is skipped)
  w.prefs.momo = { ...w.prefs.momo, atLimit: 'skip' };
  r = each();
  assert.ok(r.main && r.routines.held);
  // an older build's per-role rules read as the main chat's, before and after the startup migration
  w.prefs.momo = { ...w.prefs.momo, atLimit: { main: 'pause', routines: 'nextAccount', topics: 'nextAccount' } };
  r = each();
  assert.ok(r.routines.held, 'routines have no rule of their own');
  await done(w);
});
