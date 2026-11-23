// Chrome continuation producer/consumer ownership, including the real queue and adapter input guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick } from './support/controller/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const {
  handoffContinuation,
  handoffOwner,
  checkHandoffContinuation,
  installHandoffContinuationGuard,
} = require('../electron/capabilities/browser/handoffContinuation.cjs');
const { carryInputGuard, assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');

function world(kind = 'codex') {
  const h = setup();
  h.chats.records.set('chat', { id: 'chat', segments: [{ kind, nativeId: 'opaque:"/id' }] });
  let route = 'extension';
  const routeOf = () => route;
  const live = { controller: h.c, controllerPlans: { snapshot: () => ({ chromeToolName: 'chrome_tabs_context_mcp' }) } };
  const produce = () => handoffContinuation(live, routeOf, 'chat', 'https://site.test/');
  const item = () => {
    const result = produce();
    return { text: result.message, opts: { human: true, chromeHandoff: result.precondition } };
  };
  installHandoffContinuationGuard(live, routeOf);
  return {
    ...h,
    live,
    routeOf,
    produce,
    item,
    route: (value: string) => {
      route = value;
    },
  };
}

test('producer uses real NativeRef; stale, absent and malformed contexts fail closed, ordinary sends stay unchanged', () => {
  const h = world();
  const item = h.item();
  checkHandoffContinuation(h.live, h.routeOf, 'chat', item);
  checkHandoffContinuation(h.live, h.routeOf, 'chat', {});
  for (const value of [null, {}, [], { token: 3 }, { token: 'x', url: 'not a URL' }])
    assert.throws(() => checkHandoffContinuation(h.live, h.routeOf, 'chat', { opts: { chromeHandoff: value } }));
  h.chats.records.get('chat').segments.push({ kind: 'claude', nativeId: 'opaque:"/id' });
  assert.throws(() => checkHandoffContinuation(h.live, h.routeOf, 'chat', item), /controller changed/);
  assert.notEqual(handoffOwner(h.c, 'chat'), item.opts.chromeHandoff.token);
  checkHandoffContinuation(h.live, h.routeOf, 'chat', h.item());
  h.route('none');
  assert.throws(h.produce, /can't use your Chrome/);
  h.route('setup');
  assert.throws(h.produce, /Playwright Extension/);
  assert.throws(() => handoffContinuation(h.live, h.routeOf, '', 'https://site.test/'), /valid site/);
  h.route('relay');
  assert.throws(() => handoffContinuation({ controller: h.c }, h.routeOf, 'chat', 'https://site.test/'), /current Chrome tools/);
  assert.notEqual(
    handoffOwner({ ref: () => ({ kind: 'claude', key: null, id: null }) }, 'c'),
    handoffOwner({ ref: () => ({ kind: 'codex', key: null, id: null }) }, 'c'),
  );
});

for (const kind of ['codex', 'claude', 'acp:kimi']) {
  test(`queued ${kind} continuation rejects a changed route and retains input; a fresh retry works`, async () => {
    const h = world(kind);
    h.state.patch('chat', { turn: 'running', activeTurn: { id: 'turn' } });
    const item = h.item();
    const queued = h.c.send('chat', item, 1);
    h.route('relay');
    h.state.patch('chat', { turn: 'idle', activeTurn: null });
    const receipt = await h.c.sendNow('chat', queued.id, 1, true);
    assert.equal(receipt.status, 'queued');
    assert.match(receipt.error, /controller changed/);
    assert.equal(h.execs.length, 0);
    assert.equal(h.s('chat').queue[0].text, item.text);
    h.c.removeQueued('chat', queued.id);
    const fresh = h.item();
    const result = await h.c.send('chat', fresh, 1, true);
    assert.equal(result.action, 'started');
    assert.equal(h.execs.length, 1);
    h.c.end('chat', { drain: false });
  });
}

test('late route change after beforeDispatch is caught by carried adapter input guards', async () => {
  const h = world();
  const item = h.item();
  await h.c.chromeContinuationCheck({ chatId: 'chat', item });
  await h.c.chromeContinuationCheck({ chatId: 'chat', item });
  const meta = carryInputGuard(item, { human: true });
  assertInputCurrent(meta);
  h.route('relay');
  assert.throws(() => assertInputCurrent(meta), /controller changed/);
  await assert.rejects(h.c.claudeDeliver('chat', 'claude:x', {}, {}, 'now', meta), /controller changed/);
  await assert.rejects(h.c.acpSend('chat', 'acp:kimi:x', {}, meta), /controller changed/);
  assert.deepEqual([h.claudeSends, h.acpSends], [[], []]);
});

test('a previous dispatch hook may wait while the current harness changes', async () => {
  const h = world();
  const wait = deferred<void>();
  h.c.beforeDispatch = () => wait.promise;
  const sending = h.c.send('chat', h.item(), 1, true);
  await tick();
  h.chats.records.get('chat').segments.push({ kind: 'acp:kimi', nativeId: 'replacement' });
  wait.resolve();
  const receipt = await sending;
  assert.equal(receipt.action, 'queued');
  assert.equal(h.execs.length, 0);
  assert.equal(h.s('chat').queue.length, 1);
});
