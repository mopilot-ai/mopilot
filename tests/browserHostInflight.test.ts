// Commands in flight when a tab is let go (host/src/browserHost.mjs, host/src/commandWaiters.mjs, package 2.6): Chromium never answers a command on a session it detached, so Stop, a detach and the chat ending fail what is waiting at once instead of leaving the Mac's call pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/async-scenarios.ts';
import { world, tab, code } from './support/browser-service-kit.ts';

/** The state of a promise without waiting for it. */
function watch<T>(p: Promise<T>) {
  const seen: { state: 'pending' | 'resolved' | 'rejected'; value?: unknown } = { state: 'pending' };
  p.then(
    (value) => Object.assign(seen, { state: 'resolved', value }),
    (value) => Object.assign(seen, { state: 'rejected', value }),
  );
  return seen;
}

test('A: Stop fails a command that is in flight on a tab of the chat, and not one of another chat', async () => {
  const w = world();
  const mine = await tab(w, 'c');
  const theirs = await tab(w, 'other');
  w.chromium.hangs.add('Page.navigate');
  const navigating = watch(w.host.command('c', { targetId: mine, method: 'Page.navigate', params: { url: 'http://slow.test/' } }));
  const elsewhere = watch(w.host.command('other', { targetId: theirs, method: 'Page.navigate', params: { url: 'http://slow.test/' } }));
  await tick();
  assert.equal(navigating.state, 'pending');
  await w.host.abort('c');
  await tick();
  assert.equal(navigating.state, 'rejected', 'the Mac is told at once; Chromium would never have answered');
  assert.ok(code('not_owned')(navigating.value));
  assert.equal(elsewhere.state, 'pending', "another chat's call is not Stop's to end");
  // Chromium answers in the order it was asked: the stopped chat's late reply changes nothing, then the other chat's arrives
  w.chromium.answer('Page.navigate', { frameId: 'f', loaderId: 'stopped' });
  w.chromium.answer('Page.navigate', { frameId: 'f', loaderId: 'l' });
  await tick();
  assert.equal(navigating.state, 'rejected');
  assert.equal(elsewhere.state, 'resolved');
});

test('A: Stop ends the in-flight commands of every tab of the chat, a frame session included', async () => {
  const w = world();
  const a = await tab(w, 'c');
  const b = await tab(w, 'c');
  const root = w.chromium.sessionOf(a)!;
  w.chromium.sessions.set('F1', a);
  w.chromium.emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { targetId: 'frame1', type: 'iframe' } }, root);
  w.chromium.hangs.add('Runtime.evaluate');
  w.chromium.hangs.add('Page.navigate');
  const inFrame = watch(w.host.command('c', { targetId: a, sessionId: 'F1', method: 'Runtime.evaluate', params: { expression: '1' } }));
  const inRoot = watch(w.host.command('c', { targetId: a, method: 'Runtime.evaluate', params: { expression: '2' } }));
  const inOther = watch(w.host.command('c', { targetId: b, method: 'Page.navigate', params: { url: 'http://slow.test/' } }));
  await tick();
  await w.host.abort('c');
  await tick();
  for (const call of [inFrame, inRoot, inOther]) assert.equal(call.state, 'rejected');
});

test('A: detaching one tab ends its in-flight commands only', async () => {
  const w = world();
  const a = await tab(w, 'c');
  const b = await tab(w, 'c');
  w.chromium.hangs.add('Page.navigate');
  const onA = watch(w.host.command('c', { targetId: a, method: 'Page.navigate', params: { url: 'http://slow.test/a' } }));
  const onB = watch(w.host.command('c', { targetId: b, method: 'Page.navigate', params: { url: 'http://slow.test/b' } }));
  await tick();
  await w.host.detach('c', a);
  await tick();
  assert.equal(onA.state, 'rejected');
  assert.ok(code('not_owned')(onA.value));
  assert.equal(onB.state, 'pending');
});

test('B: a reply from Chromium after the call was ended changes nothing, and a normal command is untouched', async () => {
  const w = world();
  const t = await tab(w, 'c');
  w.chromium.hangs.add('Page.navigate');
  const late = watch(w.host.command('c', { targetId: t, method: 'Page.navigate', params: { url: 'http://slow.test/' } }));
  await tick();
  await w.host.abort('c');
  await tick();
  w.chromium.answer('Page.navigate', { frameId: 'f' });
  await tick();
  assert.equal(late.state, 'rejected', 'the first outcome stands');
  // the chat works again once attached
  await w.host.attach('c', t);
  assert.deepEqual(await w.host.command('c', { targetId: t, method: 'Page.enable' }), {});
});

test('A: the chat ending fails its in-flight commands too', async () => {
  const w = world();
  const t = await tab(w, 'c');
  w.chromium.hangs.add('Page.navigate');
  const navigating = watch(w.host.command('c', { targetId: t, method: 'Page.navigate', params: { url: 'http://slow.test/' } }));
  await tick();
  await w.host.release('c');
  await tick();
  assert.equal(navigating.state, 'rejected');
  assert.ok(code('not_owned')(navigating.value));
});

test('A: Chromium letting go of a page, a tab destroyed and a frame detached each fail what waits on them, and only them', async () => {
  const w = world();
  const a = await tab(w, 'c');
  const b = await tab(w, 'c');
  const c = await tab(w, 'c');
  const rootA = w.chromium.sessionOf(a)!;
  const rootB = w.chromium.sessionOf(b)!;
  const rootC = w.chromium.sessionOf(c)!;
  w.chromium.sessions.set('F1', c);
  w.chromium.emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { targetId: 'frame1', type: 'iframe' } }, rootC);
  w.chromium.hangs.add('Page.navigate');
  w.chromium.hangs.add('Runtime.evaluate');
  const crashed = watch(w.host.command('c', { targetId: a, method: 'Page.navigate', params: { url: 'http://slow.test/a' } }));
  const closed = watch(w.host.command('c', { targetId: b, method: 'Page.navigate', params: { url: 'http://slow.test/b' } }));
  const inFrame = watch(w.host.command('c', { targetId: c, sessionId: 'F1', method: 'Runtime.evaluate', params: { expression: '1' } }));
  const inPage = watch(w.host.command('c', { targetId: c, method: 'Runtime.evaluate', params: { expression: '2' } }));
  await tick();
  // the frame goes: only its own command fails
  w.chromium.emit('Target.detachedFromTarget', { sessionId: 'F1' }, rootC);
  await tick();
  assert.equal(inFrame.state, 'rejected');
  assert.ok(code('not_owned')(inFrame.value));
  assert.equal(inPage.state, 'pending', "the page's own session is still there");
  // Chromium lets go of the page's own session (a crash, a cross-process navigation)
  w.chromium.emit('Target.detachedFromTarget', { sessionId: rootA });
  await tick();
  assert.equal(crashed.state, 'rejected');
  assert.equal(closed.state, 'pending');
  assert.equal(inPage.state, 'pending');
  // a tab destroyed
  w.chromium.emit('Target.targetDestroyed', { targetId: b });
  await tick();
  assert.equal(closed.state, 'rejected');
  assert.ok(code('not_owned')(closed.value));
  assert.equal(inPage.state, 'pending', 'the third tab is untouched');
  assert.ok(rootB);
});

test('A: Stop ends a load under way on every session before it detaches, because Chromium holds the next session’s first commands while one runs; a step that fails does not stop the rest', async () => {
  const w = world();
  const a = await tab(w, 'c');
  const b = await tab(w, 'c');
  const roots = [w.chromium.sessionOf(a)!, w.chromium.sessionOf(b)!].sort();
  await w.host.abort('c');
  assert.deepEqual(
    w.chromium
      .sent('Page.stopLoading')
      .map((c) => c.sessionId)
      .sort(),
    roots,
  );
  // the load is ended before the session goes
  const order = w.chromium.log.map((c: any) => c.method).filter((m: string) => ['Page.stopLoading', 'Target.detachFromTarget'].includes(m));
  assert.equal(order.indexOf('Page.stopLoading') < order.indexOf('Target.detachFromTarget'), true);
  // a browser that refuses it still lets the sessions go
  await w.host.attach('c', a);
  w.chromium.fails.set('Page.stopLoading', 'gone');
  await w.host.abort('c');
  assert.equal(w.chromium.sessions.size, 0);
});
