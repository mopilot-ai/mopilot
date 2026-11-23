// Financial task grants follow the real executor turn tokens: delayed cleanup, harness completion, Stop and crashes cannot lend consent to a later turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/'];
const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { TaskGrants } = require('../electron/capabilities/browser/taskGrants.cjs');
const { TurnTokens } = require('../electron/capabilities/contract/turnTokens.cjs');
const { turnLedger } = require('../electron/capabilities/turnEnd.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const url = 'https://www.chase.com/';
const ctx = { chatId: 'chat', segmentId: 'segment' };
function setup() {
  const tokens = new TurnTokens();
  const asked: any[] = [];
  const grants = new OriginGrants({
    confirmAction: async (r: any) => {
      asked.push(r);
      return 'task';
    },
  });
  const inTurn = (fn: () => any, thread: string | null = null, token = tokens.issue(ctx.chatId, thread)) =>
    guarded({ token, current: (t: any) => tokens.current(t) }, fn);
  const act = (thread: string | null = null) => inTurn(() => grants.act(url, ctx, { ordinary: true }), thread);
  return { tokens, asked, grants, inTurn, act };
}

for (const harness of ['claude', 'acp'])
  test(`${harness}: completion retires consent before delayed cleanup; old cleanup retains the next turn's consent`, async () => {
    const w = setup();
    let release: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const ledger = turnLedger({
      steps: [
        async () => {
          await barrier;
          w.grants.turnEnded(ctx.chatId);
        },
      ],
      retire: (chat: string, thread: string | null) => w.tokens.retireTurn(chat, thread),
      retireAll: (chat: string) => w.tokens.retire(chat),
      chatOf: () => ctx.chatId,
      running: () => false,
      tracked: () => true,
    });
    ledger.begin(ctx.chatId);
    const old = w.tokens.issue(ctx.chatId);
    await w.act();
    await w.act();
    assert.equal(w.asked.length, 1);
    const ending = ledger.hooks.onFinished(ctx);
    assert.equal(w.tokens.current(old), false, 'retirement is synchronous');
    ledger.begin(ctx.chatId);
    await w.act();
    assert.equal(w.asked.length, 2, 'cleanup has not run, but a new turn asks');
    await assert.rejects(
      w.inTurn(() => w.grants.act(url, ctx, { ordinary: true }), null, old),
      { code: 'aborted' },
    );
    release();
    await ending;
    await w.act();
    assert.equal(w.asked.length, 2, 'an old asynchronous cleanup cannot clear the newer live allowance');
    w.grants.forget(ctx.chatId);
    await w.act();
    assert.equal(w.asked.length, 3, 'forget removes even a live token scope');
  });

test('Codex native threads have independent scopes, and completing one retires only its own allowance', async () => {
  const w = setup();
  const ledger = turnLedger({
    steps: [],
    retire: (chat: string, thread: string | null) => w.tokens.retireTurn(chat, thread),
    chatOf: () => ctx.chatId,
    ownerOf: () => ctx.chatId,
    rootOf: () => 'root',
    ridden: () => false,
    running: () => true,
    tracked: () => true,
  });
  for (const threadId of ['root', 'child']) ledger.codexMessage({ method: 'turn/started', params: { threadId, turn: { id: threadId } } });
  await w.act('root');
  await w.act('child');
  assert.equal(w.asked.length, 2);
  ledger.codexMessage({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child' } } });
  await w.act('root');
  assert.equal(w.asked.length, 2, 'a child completion preserves the root');
  await w.act('child');
  assert.equal(w.asked.length, 3, 'a later child turn cannot borrow its older grant');
});

for (const event of ['stop', 'crash'])
  test(`${event}: every harness turn token and pending approval is retired`, async () => {
    const w = setup();
    const ledger = turnLedger({
      steps: [],
      abortChat: (chat: string) => w.tokens.retire(chat),
      retireAll: (chat: string) => w.tokens.retire(chat),
      retire: (chat: string) => w.tokens.retire(chat),
      chatOf: () => ctx.chatId,
      running: () => false,
      tracked: () => true,
    });
    await w.act('root');
    await w.act('child');
    const old = w.tokens.issue(ctx.chatId, 'child');
    if (event === 'stop') ledger.hooks.onInterrupt(ctx.chatId);
    else await ledger.hooks.onCrash(ctx.chatId);
    await assert.rejects(
      w.inTurn(() => w.grants.act(url, ctx, { ordinary: true }), 'child', old),
      { code: 'aborted' },
    );
    await w.act('child');
    assert.equal(w.asked.length, 3);
  });

test('task cleanup prunes retired scopes without affecting independent live tokens; stale scope answers stay retired', async () => {
  const w = setup();
  const tasks = new TaskGrants();
  tasks.end('absent');
  const old = w.inTurn(() => tasks.scope(ctx.chatId, ctx.segmentId), 'root');
  w.inTurn(() => tasks.add(ctx.chatId, ctx.segmentId, url, old), 'root');
  assert.equal(
    w.inTurn(() => tasks.has(ctx.chatId, 'other', url), 'root'),
    false,
  );
  w.tokens.retireTurn(ctx.chatId, 'root');
  assert.equal(tasks.current(ctx.chatId, old), false);
  tasks.add(ctx.chatId, ctx.segmentId, url, old);
  tasks.end(ctx.chatId);
  assert.equal(tasks.byChat.has(ctx.chatId), false);
});

test('a pending native approval cannot outlive its executor token even when the card transport answers late', async () => {
  const tokens = new TurnTokens();
  let answer: any;
  const grants = new OriginGrants({
    confirmAction: () =>
      new Promise((r) => {
        answer = r;
      }),
  });
  const token = tokens.issue(ctx.chatId, 'native');
  const pending = guarded({ token, current: (t: any) => tokens.current(t) }, () => grants.act(url, ctx, { ordinary: true }));
  while (!answer) await new Promise((r) => setImmediate(r));
  tokens.retire(ctx.chatId);
  answer('task');
  await assert.rejects(pending, { code: 'aborted' });
  const tasks = new TaskGrants();
  const scope = guarded({ token: tokens.issue(ctx.chatId, 'a'), current: (t: any) => tokens.current(t) }, () =>
    tasks.scope(ctx.chatId, ctx.segmentId),
  );
  assert.equal(
    guarded({ token: tokens.issue(ctx.chatId, 'b'), current: (t: any) => tokens.current(t) }, () => tasks.current(ctx.chatId, scope)),
    false,
  );
});
