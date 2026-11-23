// The Host's browser service (host/src/browserHost.mjs, package 2.6): one Chromium per Host, a context per chat, and CDP commands that reach only the chat's own tabs and sessions. Chromium is a fake on a CDP pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';
import { world, tab, code, DOWNLOADS } from './support/browser-service-kit.ts';

test('open starts the browser once, makes the chat a context of its own and sets where its downloads go (I1: the folder is a digest)', async () => {
  const w = world();
  const [a, b] = await Promise.all([w.host.open('../../etc'), w.host.open('other')]);
  assert.notEqual(a.targetId, b.targetId);
  assert.equal(w.chromium.launches, 1);
  assert.equal(w.chromium.contexts.size, 2);
  const dirs = w.chromium.sent('Browser.setDownloadBehavior').map((c) => c.params);
  assert.equal(dirs.length, 2);
  for (const d of dirs) {
    assert.equal(d.behavior, 'allowAndName');
    assert.equal(d.eventsEnabled, true);
    assert.equal(path.dirname(d.downloadPath), DOWNLOADS);
    assert.match(path.basename(d.downloadPath), /^[0-9a-f]{24}$/);
  }
  assert.notEqual(dirs[0].downloadPath, dirs[1].downloadPath);
  // a second tab of the same chat shares its context
  await w.host.open('other');
  assert.equal(w.chromium.sent('Target.createBrowserContext').length, 2);
  await assert.rejects(w.host.open(''), code('invalid'));
  await assert.rejects(w.host.open(7 as any), code('invalid'));
});

test('I2: a chat reaches only its own tabs, sessions and frames', async () => {
  const w = world();
  const a = await tab(w, 'a');
  const b = await tab(w, 'b');
  await assert.rejects(w.host.command('a', { targetId: b, method: 'Page.enable' }), code('not_owned'));
  await assert.rejects(w.host.attach('a', b), code('not_owned'));
  await assert.rejects(w.host.detach('a', b), code('not_owned'));
  await assert.rejects(w.host.close('a', b), code('not_owned'));
  await assert.rejects(w.host.command('nobody', { targetId: a, method: 'Page.enable' }), code('not_owned'));
  await assert.rejects(w.host.command('a', { targetId: 7, method: 'Page.enable' }), code('not_owned'));
  // a frame session of b's tab named from a's tab, and one that does not exist
  const bSession = w.chromium.sessionOf(b)!;
  await assert.rejects(w.host.command('a', { targetId: a, sessionId: bSession, method: 'Page.enable' }), code('not_owned'));
  await assert.rejects(w.host.command('a', { targetId: a, sessionId: 'nope', method: 'Page.enable' }), code('not_owned'));
  assert.equal(w.chromium.sent('Page.enable').length, 0);
  assert.deepEqual(await w.host.tabs('a'), [{ targetId: a }]);
  assert.deepEqual(await w.host.tabs('nobody'), []);
});

test('B1: a malformed command or a method the tab may not call never reaches the browser', async () => {
  const w = world();
  const t = await tab(w);
  for (const bad of [
    { method: 7 },
    { method: 'nodot' },
    { method: 'Page.enable', params: null },
    { method: 'Page.enable', params: [] },
    { method: 'Page.enable', params: 'x' },
    { method: 'Page.enable', sessionId: 5 },
  ])
    await assert.rejects(w.host.command('c', { targetId: t, ...(bad as any) }), code('invalid'));
  for (const method of [
    'Browser.close',
    'Browser.setDownloadBehavior',
    'SystemInfo.getInfo',
    'Target.createTarget',
    'Target.closeTarget',
    'Page.setDownloadBehavior',
    // L: a domain nobody listed is not reachable, including ones a later Chromium adds
    'Storage.getCookies',
    'Storage.clearDataForOrigin',
    'Tracing.start',
    'Memory.getDOMCounters',
    'ServiceWorker.enable',
    'Extensions.loadUnpacked',
    'Future.method',
  ])
    await assert.rejects(w.host.command('c', { targetId: t, method }), code('refused'));
  // a tab goes to a web page, not to a file on the Host or a page of the browser (the tab's own session, whatever the page asks)
  for (const url of [
    'file:///etc/passwd',
    'chrome://settings',
    'chrome-untrusted://x/',
    'devtools://devtools/',
    'view-source:https://a.test/',
    'javascript:alert(1)',
    'not a url',
    undefined,
    7,
  ])
    await assert.rejects(w.host.command('c', { targetId: t, method: 'Page.navigate', params: { url } }), code('refused'), String(url));
  for (const url of ['https://a.test/', 'http://localhost:5173/', 'about:blank'])
    await w.host.command('c', { targetId: t, method: 'Page.navigate', params: { url } });
  await assert.rejects(
    w.host.command('c', { targetId: t, method: 'Target.getTargetInfo', params: { targetId: 'other' } }),
    code('refused'),
  );
  assert.equal(w.chromium.sent('Browser.close').length + w.chromium.sent('Target.closeTarget').length, 0);
  // the tab's own info and auto-attach are allowed
  assert.equal(
    (await w.host.command('c', { targetId: t, method: 'Target.getTargetInfo', params: { targetId: t } })).targetInfo.targetId,
    t,
  );
  await w.host.command('c', {
    targetId: t,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
  });
  // the browser's own refusal is an error to the caller
  w.chromium.fails.set('Page.enable', 'boom');
  await assert.rejects(
    w.host.command('c', { targetId: t, method: 'Page.enable' }),
    (e: any) => e.code === 'invalid' && /boom/.test(e.message),
  );
  // an error with no message still fails, and an answer with no result is an empty one
  w.chromium.fails.set('Page.enable', null);
  await assert.rejects(
    w.host.command('c', { targetId: t, method: 'Page.enable' }),
    (e: any) => e.code === 'invalid' && /refused/.test(e.message),
  );
  w.chromium.fails.delete('Page.enable');
  w.chromium.bare.add('Page.enable');
  assert.deepEqual(await w.host.command('c', { targetId: t, method: 'Page.enable', params: undefined }), {});
});

test('an unattached tab refuses commands; attach is shared by callers at once (A1); detach and attach again give a new session and retire the old one (A3)', async () => {
  const w = world();
  const { targetId } = await w.host.open('c');
  await assert.rejects(w.host.command('c', { targetId, method: 'Page.enable' }), code('not_owned'));
  await Promise.all([w.host.attach('c', targetId), w.host.attach('c', targetId)]);
  assert.equal(w.chromium.sent('Target.attachToTarget').length, 1);
  await w.host.attach('c', targetId);
  assert.equal(w.chromium.sent('Target.attachToTarget').length, 1);
  const first = w.chromium.sessionOf(targetId)!;
  await w.host.detach('c', targetId);
  await w.host.detach('c', targetId);
  assert.equal(w.chromium.sessions.size, 0);
  await assert.rejects(w.host.command('c', { targetId, method: 'Page.enable' }), code('not_owned'));
  await w.host.attach('c', targetId);
  assert.notEqual(w.chromium.sessionOf(targetId), first);
  // the old session is not the tab's any more, even named explicitly
  await assert.rejects(w.host.command('c', { targetId, sessionId: first, method: 'Page.enable' }), code('not_owned'));
  // detach tolerates a session the browser already lost
  w.chromium.sessions.clear();
  await w.host.detach('c', targetId);
});

test('A3: a chat released while its tab attaches or is made, or whose tab went meanwhile, keeps nothing the late answer made', async () => {
  // the tab goes while its attach is on its way: the session the late answer made is let go
  const w = world();
  const { targetId } = await w.host.open('c');
  w.chromium.hangs.add('Target.attachToTarget');
  const attaching = w.host.attach('c', targetId);
  await tick();
  w.chromium.emit('Target.targetDestroyed', { targetId });
  w.chromium.sessions.set('late', targetId);
  w.chromium.answer('Target.attachToTarget', { sessionId: 'late' });
  await assert.rejects(attaching, code('not_owned'));
  await tick();
  assert.equal(w.chromium.sent('Target.detachFromTarget')[0].params.sessionId, 'late');
  // the chat is released while the attach is on its way
  const w1 = world();
  const t1 = (await w1.host.open('c')).targetId;
  w1.chromium.hangs.add('Target.attachToTarget');
  const attaching1 = w1.host.attach('c', t1);
  await tick();
  await w1.host.release('c');
  w1.chromium.answer('Target.attachToTarget', { sessionId: 'late' });
  await assert.rejects(attaching1, code('not_owned'));
  // the chat is released while its tab is being created: the tab is closed
  const w3 = world();
  await w3.host.open('seed');
  w3.chromium.hangs.add('Target.createTarget');
  const creating = w3.host.open('y');
  await tick();
  await w3.host.release('y');
  w3.chromium.targets.set('late', { ctx: 'ctx-y', url: '', title: '' });
  w3.chromium.answer('Target.createTarget', { targetId: 'late' });
  await assert.rejects(creating, code('not_owned'));
  await tick();
  assert.equal(w3.chromium.sent('Target.closeTarget').at(-1)!.params.targetId, 'late');
  // released while its context is made: release waits for the context, which fails here
  const w2 = world();
  w2.chromium.hangs.add('Browser.setDownloadBehavior');
  const opening = w2.host.open('x');
  await tick();
  const released = w2.host.release('x');
  await tick();
  w2.clock.fire(3000);
  await released;
  await assert.rejects(opening, code('timeout'));
  await assert.rejects(w2.host.command('x', { targetId: 'T1', method: 'Page.enable' }), code('not_owned'));
});

test("Stop: abort drops a drag and lets go of the chat's sessions, and a command that waited fails", async () => {
  const w = world();
  const a = await tab(w, 'c');
  const b = await w.host.open('c');
  await w.host.attach('c', b.targetId);
  const sessions = [w.chromium.sessionOf(a)!, w.chromium.sessionOf(b.targetId)!];
  await w.host.abort('c');
  assert.deepEqual(
    w.chromium
      .sent('Input.cancelDragging')
      .map((c) => c.sessionId)
      .sort(),
    sessions.sort(),
  );
  assert.equal(w.chromium.sessions.size, 0);
  await assert.rejects(w.host.command('c', { targetId: a, method: 'Page.enable' }), code('not_owned'));
  assert.deepEqual(await w.host.abort('nobody'), {});
  // a failing step does not stop the rest
  await w.host.attach('c', a);
  w.chromium.fails.set('Input.cancelDragging', 'gone');
  w.chromium.fails.set('Target.detachFromTarget', 'gone');
  await w.host.abort('c');
});

test('frame sessions: the owner reaches the frames of its tab; a frame that detaches is not reachable', async () => {
  const w = world();
  const t = await tab(w);
  const root = w.chromium.sessionOf(t)!;
  const heard: any[] = [];
  w.host.subscribe('c', (e: any) => heard.push(e));
  w.chromium.sessions.set('F1', t);
  w.chromium.emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { targetId: 'frame1', type: 'iframe' } }, root);
  await w.host.command('c', { targetId: t, sessionId: 'F1', method: 'Page.enable' });
  assert.equal(w.chromium.sent('Page.enable')[0].sessionId, 'F1');
  w.chromium.emit('Runtime.consoleAPICalled', { type: 'log' }, 'F1');
  w.chromium.emit('Runtime.consoleAPICalled', { type: 'log' }, root);
  assert.deepEqual(
    heard.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => [e.targetId, e.sessionId]),
    [
      [t, 'F1'],
      [t, ''],
    ],
  );
  // the frame's attach event reaches the chat as it came, with the tab's own session as ''
  assert.equal(heard[0].method, 'Target.attachedToTarget');
  assert.equal(heard[0].sessionId, '');
  // an attach event with a malformed session id registers nothing
  w.chromium.emit('Target.attachedToTarget', { sessionId: 7 }, root);
  w.chromium.emit('Target.detachedFromTarget', { sessionId: 'F1' }, root);
  await assert.rejects(w.host.command('c', { targetId: t, sessionId: 'F1', method: 'Page.enable' }), code('not_owned'));
  // an event of a session nobody owns is dropped
  w.chromium.emit('Runtime.consoleAPICalled', {}, 'stranger');
  assert.equal(heard.filter((e) => e.method === 'Runtime.consoleAPICalled').length, 2);
});

test("Stop takes the chat's sessions at once, even when the browser is slow to answer the cleanup", async () => {
  const w = world();
  const t = await tab(w);
  w.chromium.hangs.add('Input.cancelDragging');
  const aborting = w.host.abort('c');
  await tick();
  await assert.rejects(w.host.command('c', { targetId: t, method: 'Page.enable' }), code('not_owned'));
  w.chromium.answer('Input.cancelDragging', {});
  await aborting;
  assert.equal(w.chromium.sessions.size, 0);
});

test('M4: a page event too large for a wire message is dropped and counted, with a note of which; the chat hears the rest and the connection stays', async () => {
  const w = world();
  const t = await tab(w);
  const root = w.chromium.sessionOf(t)!;
  const heard: any[] = [];
  w.host.subscribe('c', (e: any) => heard.push(e));
  assert.equal(w.host.droppedEvents, 0);
  // a page logs 5 MB: far under the pipe's 64 MB, far over what one wire message carries
  w.chromium.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x'.repeat(5 * 1024 * 1024) }] }, root);
  w.chromium.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'small' }] }, root);
  assert.equal(w.host.droppedEvents, 1);
  assert.deepEqual(
    heard.map((e) => [e.type, e.method]),
    [
      ['dropped', 'Runtime.consoleAPICalled'],
      ['cdp', 'Runtime.consoleAPICalled'],
    ],
  );
  assert.equal(JSON.stringify(heard[0]).length < 1000, true, 'the note is small');
  assert.deepEqual([heard[0].targetId, heard[0].sessionId], [t, '']);
});
