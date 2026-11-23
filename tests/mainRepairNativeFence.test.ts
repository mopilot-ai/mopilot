// Retires real CAS claims during real native-port readiness awaits, rather than only testing a fake adapter's guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeRepairWorld } from './support/main-repair-runtime.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { deferred } from './support/async-scenarios.ts';
import { retire, claim } from '../shared/mainRedClaims.mjs';
import { WORKER_LEASE_MS } from '../shared/mainRepairClaim.mjs';
const require = createRequire(import.meta.url);
const { CodexConnection } = require('../electron/harness/codexConnection.cjs');
const { createSessions } = require('../electron/harness/claude/sessions.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');
const { carryInputGuard, guardInput, guardInputReady } = require('../electron/session/contract/inputGuard.cjs');
function receive(kind: string, item: any, ready: any, entered: any, sent: any[]) {
  if (kind === 'codex') {
    const adapter: any = {
      initialize: () => {
        entered.resolve();
        return ready.promise;
      },
      nativeLifecycle: { turnEnded: async () => undefined, resetContext: () => null },
      unrecorded: new Set(),
      call: async (...args: any[]) => {
        sent.push(args);
        return {};
      },
    };
    return CodexConnection.prototype.request.call(adapter, 'turn/start', carryInputGuard(item, { threadId: 'native' }));
  }
  if (kind === 'claude') {
    const session = {
      key: 'native',
      account: 'a',
      busy: false,
      owed: 0,
      sent: 0,
      unpersisted: true,
      seen: new Set(),
      input: { push: (m: any) => sent.push(m) },
    };
    const state: any = { starting: new Map([['native', ready.promise]]), sessions: new Map([['native', session]]), prewarmed: new Set() };
    void ready.promise.then(() => state.starting.delete('native'));
    const api = createSessions(state, { auth: {}, cli: {}, catalog: {}, chrome: {} });
    const result = api.send(
      'native',
      { account: 'a' },
      { role: 'user', content: 'assigned repair' },
      undefined,
      carryInputGuard(item, { human: false }),
    );
    entered.resolve();
    return result;
  }
  const chat: any = {
    key: 'native',
    harness: 'test',
    sessionId: 's',
    cwd: '/wt',
    agent: {
      caps: {},
      request: (...args: any[]) => {
        sent.push(args);
        return new Promise(() => undefined);
      },
    },
  };
  const host: any = {
    starting: new Map(),
    ensure: async () => {
      entered.resolve();
      await ready.promise;
      return chat;
    },
    items: { append: () => undefined },
    emitEvent: () => undefined,
    now: () => 0,
  };
  return sendPrompt(host, 'native', { blocks: [] }, carryInputGuard(item, { human: false }));
}
test('retirement and lease expiry during each native readiness wait block the brief; a current lease still sends', async (t) => {
  for (const kind of ['codex', 'claude', 'acp:test'])
    for (const mode of ['retired', 'expired', 'current'])
      await t.test(`${kind}/${mode}`, async (t) => {
        const clock = useFakeClock(t, 1000),
          f = nativeRepairWorld(kind),
          ready = deferred(),
          entered = deferred(),
          sent: any[] = [];
        Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
        f.live.controller.start = async (chatId: string, item: any) => {
          Object.assign(f.live.controller.rt(chatId), { token: 'pending', inputToken: `pending-${item.id}`, startAttempt: {} });
          await f.live.controller.beforeDispatch({ chatId, item });
          await receive(kind, item, ready, entered, sent);
          return { started: true };
        };
        const result = f.runtime.deliver(f.job, 'assigned repair', () => true);
        await entered.promise;
        if (mode === 'retired') {
          retire({ gh: f.hub.gh, repo: f.policy.repo, issue: 5, from: f.held().sha, reason: 'replacement', now: clock.now() });
          claim({ gh: f.hub.gh, repo: f.policy.repo, issue: 5, claimant: 'replacement', now: clock.now() });
        } else if (mode === 'expired') clock.advance(WORKER_LEASE_MS);
        ready.resolve();
        if (mode === 'current') {
          assert.equal((await result).accepted, true);
          assert.equal(sent.length, 1);
        } else {
          await assert.rejects(result, /claim changed/);
          assert.equal(sent.length, 0);
        }
      });
});

test('ordinary Codex requests without an input still pass through readiness without inventing a guard', async () => {
  const sent: any[] = [];
  const connection: any = {
    initialize: async () => undefined,
    call: async (...args: any[]) => {
      sent.push(args);
      return { ok: true };
    },
  };
  assert.deepEqual(await CodexConnection.prototype.request.call(connection, 'account/read', undefined), { ok: true });
  assert.equal(sent[0][1], undefined);
});

test('retirement after asynchronous readiness resolves is checked synchronously at every native send', async (t) => {
  for (const kind of ['codex', 'claude', 'acp:test'])
    await t.test(kind, async () => {
      let allowed = true;
      const item = {},
        ready = deferred(),
        entered = deferred(),
        sent: any[] = [];
      guardInput(item, () => allowed);
      guardInputReady(item, async () => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            allowed = false;
          }),
        );
      });
      ready.resolve();
      await assert.rejects(receive(kind, item, ready, entered, sent), /automatic input was paused/);
      assert.equal(sent.length, 0);
    });
});
