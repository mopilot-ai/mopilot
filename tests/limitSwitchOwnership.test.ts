// Automatic quota handoffs keep the source harness until their policy and owner are still current at commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment } from './support/controller/fixture.ts';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { LimitContinuation } = require('../electron/session/limitContinue.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const CHAT = 'limited-chat';

function rig() {
  const h = setup();
  selectSegment(h.c, h.chats, CHAT, [['claude', 'source-session']]);
  const policy = { switching: true, exhausted: true, resume: false };
  const events: any[] = [];
  const runner = new SwitchRunner({
    chats: h.chats,
    ref: (id: string) => h.c.ref(id),
    invalidate: () => h.c.invalidate(),
    claim: (key: string, id: string) => h.c.claim(key, id),
    unclaim: (key: string, id: string) => h.c.unclaim(key, id),
    changed() {},
    prefs: () => ({}),
    home: '/scratch',
    emit: (event: any) => events.push(event),
    git: { info: async () => null, status: async () => null },
    permissionParams: () => ({}),
    codex: {
      startThread: async (_params: any, opts: any) => {
        opts.onThread('destination-session');
        return { thread: { id: 'destination-session' } };
      },
      ensureResumed: async () => {},
      threadTurns: async () => ({ data: [], nextCursor: null }),
      cwdOf: () => '/scratch',
    },
    claude: { isFresh: () => true, cwdOf: () => '/scratch', registerSession() {} },
  });
  h.c.switcher = runner;
  const limit = new LimitContinuation({
    controller: h.c,
    resumeEnabled: () => policy.resume,
    switchEnabled: () => policy.switching,
    exhausted: () => policy.exhausted,
    choose: async () => 'codex',
    resetAt: () => null,
    send: (id: string, item: any) => h.c.send(id, item, null, true),
  });
  const owner = () => {
    const owner = { chatId: CHAT, kind: 'claude', turnId: 'limited-turn', timer: null, itemId: null, afterSwitch: false };
    limit.owners.set(CHAT, owner);
    return owner;
  };
  const automatic = () => limit.switchTo(owner(), 'codex');
  const resume = () => limit.sendContinue(owner(), 'reset');
  return { ...h, runner, policy, limit, automatic, resume, events };
}

for (const stage of ['history', 'native', 'native failure']) {
  for (const retirement of ['setting', 'owner']) {
    test(`a quota reset retired by ${retirement} during returning Host ${stage} preserves the handoff for a fresh retry`, async () => {
      const t = rig();
      t.policy.resume = true;
      t.policy.switching = false;
      const done: string[] = [];
      t.runner.continues = {
        pending: () => ({ harness: 'codex', cwd: '/scratch', text: 'Work from the other Host' }),
        done: (id: string) => done.push(id),
      };
      const gate = deferred<void>();
      const entered = deferred<void>();
      const target = stage === 'history' ? t.runner : t.runner.codex;
      const name = stage === 'history' ? 'chatTurns' : 'startThread';
      const original = target[name].bind(target);
      target[name] = async (...args: any[]) => {
        const result = await original(...args);
        entered.resolve();
        await gate.promise;
        if (stage === 'native failure') throw new Error('native startup failed');
        return result;
      };
      const resuming = t.resume();
      await entered.promise;
      if (retirement === 'setting') t.policy.resume = false;
      else t.limit.retire(CHAT);
      gate.resolve();
      await resuming;
      assert.equal(t.c.ref(CHAT).kind, 'claude');
      assert.equal(t.chats.record(CHAT).segments.length, 1);
      assert.equal(t.execs.length, 0);
      assert.deepEqual(t.events, [], 'retired work must not report a startup failure or a completed switch');
      assert.deepEqual(done, [], 'retired automatic input must not consume the Host handoff');
      assert.equal(t.state.get(CHAT).queue.length, 0, 'retired automatic input is not kept as a user retry');
      target[name] = original;
      t.policy.resume = true;
      await t.resume();
      await tick();
      assert.equal(t.c.ref(CHAT).kind, 'codex');
      assert.equal(t.execs.length, 1);
      assert.deepEqual(done, [CHAT]);
    });
  }
}

for (const stage of ['history', 'native', 'handoff']) {
  for (const retirement of ['setting', 'quota', 'owner']) {
    test(`an automatic switch retired by ${retirement} during ${stage} never commits, and a fresh retry works`, async () => {
      const t = rig();
      const gate = deferred<void>();
      const entered = deferred<void>();
      const target = stage === 'native' ? t.runner.codex : t.runner;
      const name = stage === 'history' ? 'chatTurns' : stage === 'native' ? 'startThread' : 'handoff';
      const original = target[name].bind(target);
      target[name] = async (...args: any[]) => {
        const result = await original(...args);
        entered.resolve();
        await gate.promise;
        return result;
      };
      const switching = t.automatic();
      await entered.promise;
      if (retirement === 'setting') t.policy.switching = false;
      else if (retirement === 'quota') t.policy.exhausted = false;
      else t.limit.retire(CHAT);
      gate.resolve();
      await switching;
      assert.equal(t.c.ref(CHAT).kind, 'claude');
      assert.equal(t.chats.record(CHAT).segments.length, 1);
      assert.equal(t.execs.length, 0);
      assert.equal(t.state.get(CHAT).pendingSwitch, null, 'retired automatic choice is not restored as a user choice');
      target[name] = original;
      t.policy.switching = true;
      t.policy.exhausted = true;
      await t.automatic();
      await tick();
      assert.equal(t.c.ref(CHAT).kind, 'codex');
      assert.equal(t.execs.length, 1);
    });
  }
}
