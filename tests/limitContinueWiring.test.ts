// electron/app/limitContinue.cjs: the limit continuation's composition over main's services: the prefs, the harnesses
// that can run now, the registry's quota and the controller's send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachLimitContinue } = require('../electron/app/limitContinue.cjs');
const { quotaOf } = require('../electron/session/orchestration/autoHarness.cjs');

function wire(o: { prefs?: any; kind?: string; destination?: string; kinds?: string[]; instances?: any[] | null } = {}) {
  const calls: any[] = [];
  const asked: any[] = [];
  const state = { turn: 'idle', activeTurn: null, queue: [], pendingSwitch: null };
  const controller: any = {
    send: async (...a: any[]) => (calls.push(a), { action: 'started' }),
    ref: () => ({ kind: o.kind ?? 'codex' }),
    state: { get: () => state, patch: (_id: string, patch: object) => Object.assign(state, patch) },
  };
  const patched: any[] = [];
  const live = {
    controller,
    chats: {
      record: () => ({ meta: {} }),
      patchMeta: (...a: any[]) => (patched.push(a), true),
      get: (id: string) => ({ id }),
    },
    identity: { instances: (family: string) => (asked.push(family), o.instances ?? null) },
  };
  const broadcast: any[] = [];
  const orchestrator = {
    o: {
      kinds: () => o.kinds ?? ['codex', 'claude', 'acp:kimi'],
      usable: async (k: string) => k === (o.destination ?? 'claude'),
      lacks: () => false,
      quota: (k: string) => (k === (o.kind ?? 'codex') ? quotaOf(o.instances, k) : null),
      controller,
    },
  };
  const limit = attachLimitContinue({ live, orchestrator, prefs: () => o.prefs, broadcastAll: (...a: any[]) => broadcast.push(a) });
  return { limit, calls, broadcast, patched, asked };
}

test('reset continuation defaults on and harness switching requires its own explicit opt-in', () => {
  for (const [prefs, resume, switchHarness] of [
    [undefined, true, false],
    [null, true, false],
    [{}, true, false],
    [{ autoContinueOnLimit: true }, true, false],
    [{ autoContinueOnLimit: false }, false, false],
    [{ autoContinueOnLimit: false, autoSwitchHarnessOnLimit: true }, false, true],
    [{ autoContinueOnLimit: true, autoSwitchHarnessOnLimit: true }, true, true],
    [{ autoSwitchHarnessOnLimit: false }, true, false],
    [{ autoSwitchHarnessOnLimit: null }, true, false],
    [{ autoSwitchHarnessOnLimit: 'true' }, true, false],
  ] as const) {
    const { limit } = wire({ prefs });
    assert.equal(limit.resumeEnabled(), resume);
    assert.equal(limit.switchEnabled(), switchHarness);
  }
});

test('automatic switching waits until every source account is exhausted, while ACP uses its single-account limit event', async () => {
  const plan = (account: string, limited: boolean) => ({ account, status: 'ok', billing: 'subscription', limited });
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    for (const [instances, pooledExhausted] of [
      [null, false],
      [[], false],
      [[plan('a', true), plan('b', false)], false],
      [[plan('a', true), plan('b', true)], true],
      [[plan('a', true), { account: 'key', status: 'ok', billing: 'apiKey', active: true }], false],
    ] as const) {
      const t = wire({
        kind,
        destination: kind === 'claude' ? 'codex' : 'claude',
        prefs: { autoContinueOnLimit: false, autoSwitchHarnessOnLimit: true },
        instances: instances as any,
      });
      const owner = { chatId: 'chat', kind, afterSwitch: false };
      t.limit.owners.set('chat', owner);
      await t.limit.settle(owner);
      assert.equal(t.calls.length, Number(kind === 'acp:kimi' || pooledExhausted), `${kind}: ${JSON.stringify(instances)}`);
    }
  }
});

test('automatic switching reads the same model preferences as the composer', () => {
  const prefs = { model: 'gpt-6.1-sol', claudeSelection: { model: 'opus' } };
  assert.equal(wire({ prefs }).limit.prefs(), prefs);
});

test('unknown pooled quota never authorizes switching; an ACP limit needs no pooled quota reader', () => {
  assert.equal(wire().limit.exhausted('not-a-harness'), false);
  const limit = attachLimitContinue({
    live: { controller: { state: {} } },
    orchestrator: { o: {} },
    prefs: () => ({ autoSwitchHarnessOnLimit: true }),
    broadcastAll() {},
  });
  assert.equal(limit.exhausted('codex'), false);
  assert.equal(limit.exhausted('acp:kimi'), true);
});

test('the other harness is picked among the first tier that can run, leaving the chat’s own and every ACP harness out', async () => {
  const t = wire();
  assert.equal(await t.limit.choose('chat', 'codex'), 'claude');
  assert.equal(await t.limit.choose('chat', 'claude'), null, 'Codex is not usable here');
});

test('a MoMo chat is never switched to another harness at its limit: it waits for its brain’s quota', async () => {
  const t = wire();
  const live = (t.limit as any).controller;
  assert.ok(live);
  const momo = attachLimitContinue({
    live: { controller: live, chats: { records: new Map([['m', { meta: { momo: 'main' } }]]) }, identity: null },
    orchestrator: {
      o: { kinds: () => ['codex', 'claude'], usable: async () => true, lacks: () => false, quota: () => null, controller: live },
    },
    prefs: () => ({}),
    broadcastAll() {},
  });
  assert.equal(await momo.choose('m', 'codex'), null);
});

test('a harness list or chat that cannot be read leaves nothing to switch to, noted rather than thrown', async () => {
  const live = { controller: { send: async () => undefined }, chats: {}, identity: null };
  const wired = (o: any) => attachLimitContinue({ live, orchestrator: { o }, prefs: () => ({}), broadcastAll() {} });
  const listing = wired({
    kinds: () => {
      throw new Error('no kinds');
    },
  });
  assert.equal(await listing.choose('chat', 'codex'), null);
  const unreadable = wired({
    kinds: () => ['codex', 'claude'],
    controller: {
      ref: () => {
        throw new Error('gone');
      },
    },
    usable: async () => true,
  });
  assert.equal(await unreadable.choose('chat', 'codex'), null);
});

test('the reset time is the registry’s, by the family of the harness', () => {
  const instances = [{ account: 'a', status: 'ok', limited: true, billing: 'subscription', limitedUntil: 123 }];
  const t = wire({ instances });
  assert.equal(t.limit.resetAt('codex'), 123);
  assert.deepEqual(t.asked, ['codex']);
  assert.equal(wire().limit.resetAt('codex'), null);
});

test('Continue goes through the controller and waits for its receipt; windows see it as MoPilot’s', async () => {
  const t = wire();
  const receipt = await t.limit.send('chat', { id: 'x' });
  assert.deepEqual(receipt, { action: 'started' });
  assert.deepEqual(t.calls[0], ['chat', { id: 'x' }, null, true]);
  const item = t.limit.make('chat', 'Continue', { by: 'mopilot', title: 'Continuing after the usage limit' });
  assert.equal(item.text, 'Continue');
  assert.deepEqual(t.broadcast, [['chats:changed', { id: 'chat', chat: { id: 'chat' } }]]);
  assert.equal(t.patched.length, 1);
});
