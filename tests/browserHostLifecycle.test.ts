// The Host's browser service, tab events, downloads and lifecycle (host/src/browserHost.mjs, package 2.6): popups, crashes, downloads under their own names, release, idle, exit and dispose. Chromium is a fake on a CDP pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';
import { FakeChromium } from './support/fake-chromium.ts';
import { world, tab, code } from './support/browser-service-kit.ts';
// @ts-ignore: plain ESM without declarations
import { BrowserHostError } from '../host/src/browserHost.mjs';

test('tab events: a tab a page opens joins the chat that owns its context; a closed one is dropped; a crashed session says CDP went', async () => {
  const w = world();
  const t = await tab(w, 'a');
  const other = await tab(w, 'b');
  w.hear('a');
  w.hear('b');
  const popup = w.chromium.popup(t);
  assert.deepEqual(w.events.a, [{ type: 'opened', targetId: popup, openerId: t, url: 'https://popup.test/' }]);
  assert.deepEqual(w.events.b, []);
  await w.host.attach('a', popup);
  // events that are not a page of a known context, or without an opener, or twice, change nothing
  w.chromium.emit('Target.targetCreated', { targetInfo: { targetId: 'x', type: 'page', browserContextId: 'ctx-unknown', openerId: t } });
  w.chromium.emit('Target.targetCreated', { targetInfo: { targetId: 'y', type: 'service_worker', browserContextId: 'ctx1', openerId: t } });
  w.chromium.emit('Target.targetCreated', { targetInfo: { targetId: other, type: 'page', browserContextId: 'ctx1', openerId: t } });
  w.chromium.emit('Target.targetCreated', {});
  const ctxOfA = w.chromium.targets.get(t)!.ctx;
  w.chromium.emit('Target.targetCreated', { targetInfo: { targetId: popup, type: 'page', browserContextId: ctxOfA, openerId: t } });
  w.chromium.emit('Target.targetCreated', { targetInfo: { targetId: 'noOpener', type: 'page', browserContextId: ctxOfA } });
  assert.equal(w.events.a.length, 1);
  // the page closes
  w.chromium.emit('Target.targetDestroyed', { targetId: popup });
  assert.deepEqual(w.events.a.at(-1), { type: 'closed', targetId: popup });
  await assert.rejects(w.host.command('a', { targetId: popup, method: 'Page.enable' }), code('not_owned'));
  w.chromium.emit('Target.targetDestroyed', { targetId: 'unknown' });
  // the tab's session is lost by the browser (a crash)
  const root = w.chromium.sessionOf(t)!;
  w.chromium.emit('Target.detachedFromTarget', { sessionId: root });
  assert.deepEqual(w.events.a.at(-1), {
    type: 'cdp',
    targetId: t,
    sessionId: '',
    method: 'Target.detachedFromTarget',
    params: { sessionId: root },
  });
  await assert.rejects(w.host.command('a', { targetId: t, method: 'Page.enable' }), code('not_owned'));
  // a detach of a session that is not a tab's own, or not known, says nothing
  w.chromium.emit('Target.detachedFromTarget', { sessionId: 'unknown' });
  const n = w.events.a.length;
  w.chromium.emit('Target.detachedFromTarget', { sessionId: 'unknown' });
  assert.equal(w.events.a.length, n);
});

test("downloads land in the chat's folder under their own name; a taken name gets a number; failures say so", async () => {
  const w = world();
  const t = await tab(w);
  w.hear('c');
  const dir = path.dirname(w.chromium.sent('Browser.setDownloadBehavior')[0].params.downloadPath + '/x');
  w.chromium.emit('Browser.downloadWillBegin', {
    guid: 'g1',
    frameId: t,
    url: 'https://x.test/report.pdf',
    suggestedFilename: '../../etc/report.pdf',
  });
  w.chromium.emit('Browser.downloadProgress', { guid: 'g1', state: 'inProgress' });
  w.files.saved.add(path.join(dir, 'report.pdf'));
  w.chromium.emit('Browser.downloadProgress', { guid: 'g1', state: 'completed' });
  assert.deepEqual(w.events.c[0], {
    type: 'download',
    targetId: t,
    guid: 'g1',
    url: 'https://x.test/report.pdf',
    filename: 'report.pdf',
    state: 'inProgress',
  });
  assert.deepEqual(w.files.renames, [[path.join(dir, 'g1'), path.join(dir, 'report (2).pdf')]]);
  assert.deepEqual(w.events.c[1], {
    type: 'download',
    targetId: '',
    guid: 'g1',
    filename: 'report.pdf',
    state: 'completed',
    path: path.join(dir, 'report (2).pdf'),
  });
  // a name that is nothing, a control character, and a rename that fails
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'g2', frameId: t, suggestedFilename: '..' });
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'g3', frameId: t, suggestedFilename: 'a\u0001b.txt' });
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'g4', frameId: t });
  assert.deepEqual(
    w.events.c.slice(2).map((e) => e.filename),
    ['download', 'ab.txt', 'download'],
  );
  w.files.renameSync = () => {
    throw new Error('EXDEV');
  };
  w.chromium.emit('Browser.downloadProgress', { guid: 'g3', state: 'completed' });
  assert.deepEqual(w.events.c.at(-1), { type: 'download', targetId: '', guid: 'g3', filename: 'ab.txt', state: 'interrupted', path: '' });
  w.chromium.emit('Browser.downloadProgress', { guid: 'g2', state: 'canceled' });
  assert.deepEqual(w.events.c.at(-1), { type: 'download', targetId: '', guid: 'g2', filename: 'download', state: 'canceled', path: '' });
  // a download of a frame nobody owns, a missing guid, and a progress for an unknown download change nothing
  const n = w.events.c.length;
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'g5', frameId: 'stranger' });
  w.chromium.emit('Browser.downloadWillBegin', { frameId: t });
  w.chromium.emit('Browser.downloadProgress', { guid: 'g5', state: 'completed' });
  assert.equal(w.events.c.length, n);
});

test("one chat's release leaves another chat's download alone", async () => {
  const w = world();
  const a = await tab(w, 'a');
  const b = await tab(w, 'b');
  w.hear('b');
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'ga', frameId: a, suggestedFilename: 'a.txt' });
  w.chromium.emit('Browser.downloadWillBegin', { guid: 'gb', frameId: b, suggestedFilename: 'b.txt' });
  await w.host.release('a');
  w.chromium.emit('Browser.downloadProgress', { guid: 'gb', state: 'canceled' });
  assert.equal(w.events.b.at(-1).state, 'canceled');
});

test("release closes the chat's context, tells it, and stops the browser after the grace time unless a chat came back (A5)", async () => {
  const w = world();
  const t = await tab(w);
  const off = w.hear('c');
  await w.host.release('c');
  assert.deepEqual(w.events.c, [{ type: 'closed', targetId: '' }]);
  assert.equal(w.chromium.sent('Target.disposeBrowserContext').length, 1);
  assert.equal(w.chromium.contexts.size, 0);
  await assert.rejects(w.host.command('c', { targetId: t, method: 'Page.enable' }), code('not_owned'));
  assert.deepEqual(await w.host.release('c'), {});
  off();
  // a chat comes back within the grace time: the browser stays
  await w.host.open('d');
  assert.equal(w.chromium.stops, 0);
  w.clock.fire(2000);
  assert.equal(w.chromium.stops, 0);
  await w.host.release('d');
  // two releases leave one stop timer; it stops the browser
  w.clock.fire(2000);
  assert.equal(w.chromium.stops, 1);
  // the next chat starts a new browser
  await w.host.open('e');
  assert.equal(w.chromium.launches, 2);
  // the grace timer of an earlier browser does not stop the new one
  await w.host.release('e');
  w.chromium.die();
  w.clock.fire(2000);
  assert.equal(w.chromium.stops, 1);
  // releasing a chat whose context failed to make
  const w2 = world();
  w2.chromium.fails.set('Target.createBrowserContext', 'no');
  await assert.rejects(w2.host.open('f'), (e: any) => e instanceof BrowserHostError);
  assert.deepEqual(await w2.host.release('f'), {});
});

test('B5: a chat that stays idle is released; a command keeps its tabs; a command the browser never answers times out', async () => {
  const w = world();
  const t = await tab(w);
  assert.deepEqual(w.clock.pending().filter((ms) => ms === 1000).length, 1);
  await w.host.command('c', { targetId: t, method: 'Page.enable' });
  assert.equal(w.clock.pending().filter((ms) => ms === 1000).length, 1);
  w.chromium.hangs.add('Page.navigate');
  const slow = w.host.command('c', { targetId: t, method: 'Page.navigate', params: { url: 'https://slow.test/' } });
  await tick();
  w.clock.fire(3000);
  await assert.rejects(slow, code('timeout'));
  w.hear('c');
  w.clock.fire(1000);
  await tick();
  assert.deepEqual(w.events.c, [{ type: 'closed', targetId: '' }]);
  assert.equal(w.chromium.sent('Target.disposeBrowserContext').length, 1);
  // the idle timer of a chat that was released and came back is not the new chat's
  const w2 = world();
  await w2.host.open('c');
  await w2.host.release('c');
  await w2.host.open('c');
  w2.clock.all[0]();
  await tick();
  assert.equal(w2.chromium.sent('Target.disposeBrowserContext').length, 1);
  w2.clock.fire(1000);
  await tick();
  assert.equal(w2.chromium.sent('Target.disposeBrowserContext').length, 2);
});

test('when the browser dies everything waiting fails, every chat hears so, and the next open starts a new browser', async () => {
  const w = world();
  const t = await tab(w, 'a');
  await tab(w, 'b');
  w.hear('a');
  w.hear('b');
  w.chromium.hangs.add('Page.navigate');
  const waiting = w.host.command('a', { targetId: t, method: 'Page.navigate', params: { url: 'https://x.test/' } });
  await tick();
  w.chromium.die('error');
  await assert.rejects(waiting, code('browser_exited'));
  assert.deepEqual(w.events.a, [{ type: 'exit' }]);
  assert.deepEqual(w.events.b, [{ type: 'exit' }]);
  await assert.rejects(w.host.command('a', { targetId: t, method: 'Page.enable' }), code('not_owned'));
  w.chromium.hangs.clear();
  await w.host.open('a');
  assert.equal(w.chromium.launches, 2);
  // a send on a pipe that closed under us fails the command
  w.chromium.closed = true;
  const { targetId } = await Promise.resolve({ targetId: [...w.chromium.targets.keys()].at(-1)! });
  await assert.rejects(w.host.attach('a', targetId), code('browser_exited'));
});

test('A1: callers at once share one start; a failed start can be tried again; a start that cannot discover tabs stops the browser', async () => {
  const w = world();
  await Promise.all([w.host.open('a'), w.host.open('b'), w.host.open('c')]);
  assert.equal(w.chromium.launches, 1);
  let tries = 0;
  const flaky = world({
    launch: async () => {
      if (tries++ === 0) throw Object.assign(new Error('no chrome'), { code: 'no_chromium' });
      return flakyChromium.launch();
    },
  });
  const flakyChromium = new FakeChromium();
  await assert.rejects(flaky.host.open('a'), /no chrome/);
  await flaky.host.open('a');
  assert.equal(tries, 2);
  const broken = world();
  broken.chromium.fails.set('Target.setDiscoverTargets', 'denied');
  await assert.rejects(broken.host.open('a'), (e: any) => e.code === 'invalid');
  assert.equal(broken.chromium.stops, 1);
  broken.chromium.fails.clear();
});

test('dispose ends every chat and the browser, and refuses new work; a browser that was still starting is stopped', async () => {
  const w = world();
  await tab(w);
  w.hear('c');
  w.host.dispose();
  assert.deepEqual(w.events.c, [{ type: 'exit' }]);
  assert.equal(w.chromium.stops, 1);
  await assert.rejects(w.host.open('c'), code('disposed'));
  // disposed while the browser was starting
  let release: (v: any) => void = () => undefined;
  const late = new FakeChromium();
  const w2 = world({ launch: () => new Promise((r) => (release = r)) });
  const opening = w2.host.open('c');
  w2.host.dispose();
  release(await late.launch());
  await assert.rejects(opening, code('disposed'));
  assert.equal(late.stops, 1);
  // disposed with nothing started
  world().host.dispose();
});

test('subscribe is for a chat that has a browser; its listener stops with the returned function; one failing listener does not stop the others', async () => {
  const w = world();
  assert.throws(() => w.host.subscribe('c', () => undefined), code('not_owned'));
  const t = await tab(w);
  const heard: any[] = [];
  const off = w.host.subscribe('c', () => {
    throw new Error('listener bug');
  });
  w.host.subscribe('c', (e: any) => heard.push(e));
  w.chromium.emit('Page.frameNavigated', { frame: { id: t } }, w.chromium.sessionOf(t));
  assert.equal(heard.length, 1);
  off();
  w.chromium.emit('Page.frameNavigated', { frame: { id: t } }, w.chromium.sessionOf(t));
  assert.equal(heard.length, 2);
  // replies for an unknown command and events with no method are ignored; an event with no params is one with none
  w.chromium.raw({ method: 'Target.targetDestroyed' });
  w.chromium.raw({ id: 12345, result: {} });
  w.chromium.raw({});
  w.chromium.raw(null);
});

test('close closes one tab of the chat', async () => {
  const w = world();
  const t = await tab(w);
  w.hear('c');
  await w.host.close('c', t);
  assert.equal(w.chromium.targets.has(t), false);
  assert.deepEqual(w.events.c.at(-1), { type: 'closed', targetId: t });
});
