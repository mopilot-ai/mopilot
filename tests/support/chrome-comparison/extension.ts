// extension Chrome comparison cases using shared fake drivers and page services.
import { test, assert, EventEmitter, cdpPipe, startExtensionChrome, PAIR_SCRIPT, fakeChrome, ext } from './fixture.ts';
import { createRequire } from 'node:module';

const { hostPairUrl } = createRequire(import.meta.url)('../../../electron/capabilities/browser/chromeExtensionTransport.cjs');

export function registerExtension() {
  test('ext arm leaves native host pairing pages to the extension while still pairing manual claim pages', async (t) => {
    const fc = fakeChrome({
      'Extensions.loadUnpacked': { id: 'extid' },
      'Target.getTargets': ext('extid'),
      'Target.setDiscoverTargets': {},
      'Target.attachToTarget': (p: any) => ({ sessionId: `s-${p.targetId}` }),
      'Runtime.evaluate': { result: { value: 'connected' } },
      'Target.closeTarget': {},
      'Browser.close': {},
    });
    const own = await startExtensionChrome({ spawn: fc.spawn, bin: '/chrome', userDataDir: '/p', extensionDir: '/e' });
    t.after(() => own.close());
    for (const [i, url] of [
      hostPairUrl('extid'),
      'chrome-extension://extid/options.html#pair=%68ost',
      'chrome-extension://extid/options.html#x=1&pair=host',
    ].entries()) {
      const native = { type: 'page', targetId: `native-${i}`, url };
      fc.emit('Target.targetCreated', { targetInfo: native });
      fc.emit('Target.targetInfoChanged', { targetInfo: native });
      // The native page consumes its route itself; a later target update cannot give the helper ownership.
      fc.emit('Target.targetInfoChanged', { targetInfo: { ...native, url: 'chrome-extension://extid/options.html' } });
    }
    const manual = { type: 'page', targetId: 'manual', url: 'chrome-extension://extid/options.html#pair=mopilot-claim%3A1%3A9%3Atok' };
    fc.emit('Target.targetCreated', { targetInfo: manual });
    fc.emit('Target.targetInfoChanged', { targetInfo: manual });
    assert.equal(await own.pairings(), 1, 'only the manually offered code is answered');
    for (const method of ['Target.attachToTarget', 'Target.closeTarget'])
      assert.deepEqual(
        fc.sent.filter((m) => m.method === method).map((m) => m.params.targetId),
        ['manual'],
        method,
      );
  });

  test('Chrome close waits for the owned process exit after Browser.close acknowledges', async () => {
    const fc = fakeChrome({
      'Extensions.loadUnpacked': { id: 'x' },
      'Target.getTargets': ext('x'),
      'Target.setDiscoverTargets': {},
      'Browser.close': {},
    });
    fc.child.autoExit = false;
    const own = await startExtensionChrome({ spawn: fc.spawn, bin: '/chrome', userDataDir: '/p', extensionDir: '/e', closeMs: 500 });
    let settled = false;
    const closing = own.close().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'an acknowledgement is not a process-exit receipt');
    fc.child.exitCode = 0;
    fc.child.emit('exit', 0);
    await closing;
    assert.equal(settled, true);
    assert.equal(fc.child.killed, 0);
  });

  test('ext arm: the DevTools pipe pairs answers with calls, splits and joins messages, passes events and fails calls when Chrome closes', async () => {
    const out = new EventEmitter();
    const written: string[] = [];
    const cdp = cdpPipe({ write: (s: string) => written.push(s) }, out);
    const a = cdp.send('A.one');
    const b = cdp.send('B.two', { x: 1 }, 'sess');
    assert.deepEqual(
      written.map((w) => JSON.parse(w.slice(0, -1))),
      [
        { id: 1, method: 'A.one', params: {} },
        { id: 2, method: 'B.two', params: { x: 1 }, sessionId: 'sess' },
      ],
    );
    const events: any[] = [];
    cdp.on('E.v', (p, s) => events.push([p, s]));
    // two messages in one chunk, and one split over two; an event nobody listens to is dropped
    out.emit(
      'data',
      `${JSON.stringify({ id: 1, result: { ok: 1 } })}\0${JSON.stringify({ method: 'E.v', params: { n: 1 }, sessionId: 's' })}\0{"id":2,`,
    );
    out.emit('data', `"error":{"message":"nope"}}\0${JSON.stringify({ method: 'Other.event', params: {} })}\0`);
    assert.deepEqual(await a, { ok: 1 });
    await assert.rejects(b, /nope/);
    assert.deepEqual(events, [[{ n: 1 }, 's']]);
    const c = cdp.send('C.three');
    out.emit('close');
    await assert.rejects(c, /closed its DevTools pipe/);
    // once the pipe is gone, a new call fails at once instead of waiting for an answer that cannot come
    await assert.rejects(cdp.send('D.four'), /closed its DevTools pipe/);
    assert.equal(written.length, 3);
    // a write to a pipe Chrome closed (EPIPE) ends the client the same way, and the first reason stays
    const input = Object.assign(new EventEmitter(), { write: () => true });
    const piped = cdpPipe(input, new EventEmitter());
    const waiting = piped.send('E.five');
    input.emit('error', new Error('write EPIPE'));
    await assert.rejects(waiting, /DevTools pipe failed: write EPIPE/);
    piped.fail(new Error('later'));
    await assert.rejects(piped.send('F.six'), /write EPIPE/);
  });

  test('ext arm: its Chrome never stays behind: not started, an extension that does not load, a close that hangs or fails', async () => {
    // no such executable: the start fails with why, and nothing is left to kill but the process that never ran
    const missing = fakeChrome({});
    const started = startExtensionChrome({ spawn: missing.spawn, bin: '/nope', userDataDir: '/p', extensionDir: '/e', closeMs: 5 });
    missing.child.emit('error', new Error('spawn /nope ENOENT'));
    await assert.rejects(started, /Chrome did not start: spawn \/nope ENOENT/);
    assert.equal(missing.child.killed, 1);
    // the extension does not load: Chrome is closed (it answers), not killed
    const broken = fakeChrome({ 'Extensions.loadUnpacked': new Error('Manifest file is missing'), 'Browser.close': {} });
    const logs: string[] = [];
    await assert.rejects(
      startExtensionChrome({ spawn: broken.spawn, bin: '/c', userDataDir: '/p', extensionDir: '/e', log: (l) => logs.push(l) }),
      /Manifest file is missing/,
    );
    assert.equal(broken.sent.at(-1).method, 'Browser.close');
    assert.equal(broken.child.killed, 0);
    // Chrome does not answer Browser.close in time: it is killed
    const hung = fakeChrome({ 'Extensions.loadUnpacked': { id: 'x' }, 'Target.getTargets': ext('x'), 'Target.setDiscoverTargets': {} });
    const own = await startExtensionChrome({ spawn: hung.spawn, bin: '/c', userDataDir: '/p', extensionDir: '/e', closeMs: 5 });
    await own.close();
    assert.equal(hung.child.killed, 1);
  });

  test('ext arm: its Chrome loads the extension unpacked over the pipe and presses Pair on the pairing page MoPilot opens, counting pairings', async () => {
    const page = 'chrome-extension://extid/options.html#pair=mopilot-claim%3A1%3A9%3Atok';
    // t1 is still loading on the first try (its document is replaced), t4 never finishes loading, t5 fails otherwise
    const loading: Record<string, number> = { 's-t1': 1, 's-t4': 99 };
    const fc = fakeChrome({
      'Extensions.loadUnpacked': { id: 'extid' },
      'Target.getTargets': ext('extid'),
      'Target.setDiscoverTargets': {},
      'Target.attachToTarget': (p: any) => (p.targetId === 'broken' ? new Error('gone') : { sessionId: `s-${p.targetId}` }),
      'Runtime.evaluate': (_p: any, s: string) => {
        if (loading[s]-- > 0) return new Error('Execution context was destroyed.');
        if (s === 's-t5') return new Error('Target crashed');
        return s === 's-t1' ? { result: { value: 'Connected to MoPilot.' } } : s === 's-t2' ? { result: { value: 'no code' } } : undefined;
      },
      'Target.closeTarget': {},
      'Browser.close': new Error('already closed'),
    });
    const logs: string[] = [];
    const own = await startExtensionChrome({
      spawn: fc.spawn,
      bin: '/chrome',
      userDataDir: '/w/chrome-ext',
      extensionDir: '/app/dist/chrome-extension',
      url: 'http://b/login',
      log: (s) => logs.push(s),
      retryMs: 1,
    });
    assert.equal(own.id, 'extid');
    // the DevTools pipe is exposed for probes
    assert.equal(typeof own.cdp.send, 'function');
    assert.deepEqual(fc.spawned[0][1], [
      '--user-data-dir=/w/chrome-ext',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      'http://b/login',
    ]);
    assert.deepEqual(fc.spawned[0][2].stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
    assert.deepEqual(fc.sent[0].params, { path: '/app/dist/chrome-extension' });
    // the pairing page (once, though Chrome reports it twice), a page with no code, one with no answer, one that fails;
    // other pages and targets are left alone
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 't1' } });
    fc.emit('Target.targetInfoChanged', { targetInfo: { type: 'page', url: page, targetId: 't1' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 't2' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 't3' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 'broken' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 't4' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: page, targetId: 't5' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: 'chrome-extension://extid/options.html', targetId: 'plain' } });
    fc.emit('Target.targetCreated', { targetInfo: { type: 'service_worker', url: page, targetId: 'sw' } });
    // the count waits for the pages still being answered
    assert.equal(await own.pairings(), 2);
    assert.deepEqual(
      fc.sent.filter((m) => m.method === 'Target.attachToTarget').map((m) => m.params.targetId),
      ['t1', 't2', 't3', 'broken', 't4', 't5'],
    );
    // the page still loading is tried again, up to ten times
    const evaluated = fc.sent.filter((m) => m.method === 'Runtime.evaluate').map((m) => m.sessionId);
    assert.equal(evaluated.filter((s) => s === 's-t1').length, 2);
    assert.equal(evaluated.filter((s) => s === 's-t4').length, 10);
    assert.equal(evaluated.filter((s) => s === 's-t5').length, 1);
    assert.ok(logs.includes('ext: pairing page failed: Error: Execution context was destroyed.'));
    assert.ok(logs.includes('ext: pairing page failed: Error: Target crashed'));
    const evaluate = fc.sent.find((m) => m.method === 'Runtime.evaluate');
    assert.equal(evaluate.sessionId, 's-t1');
    assert.equal(evaluate.params.expression, PAIR_SCRIPT);
    assert.deepEqual(
      fc.sent
        .filter((m) => m.method === 'Target.closeTarget')
        .map((m) => m.params.targetId)
        .sort(),
      ['t1', 't2', 't3'],
    );
    assert.ok(logs.includes('ext: pairing page answered: Connected to MoPilot.'));
    assert.ok(logs.includes('ext: pairing page answered: no code'));
    assert.ok(logs.includes('ext: pairing page answered: '));
    assert.ok(logs.includes('ext: pairing page failed: Error: gone'));
    // closing a Chrome that already went away is not an error: it is logged, and the process is killed
    await own.close();
    assert.equal(fc.sent.at(-1).method, 'Browser.close');
    assert.ok(logs.includes('ext: closing Chrome failed: Error: already closed'));
    assert.equal(fc.child.killed, 1);
    // the defaults: a blank page, and no log
    const fc2 = fakeChrome({
      'Extensions.loadUnpacked': { id: 'x' },
      'Target.setDiscoverTargets': {},
      'Browser.close': {},
      'Target.createTarget': { targetId: 'keep' },
      'Target.getTargets': {
        targetInfos: [
          { type: 'page', targetId: 'a', url: 'https://a.test/' },
          { type: 'page', targetId: 'b', url: 'about:blank' },
          // the loaded extension's worker, which the start waits for
          { type: 'service_worker', targetId: 'sw', url: 'chrome-extension://x/background.js' },
        ],
      },
      'Target.closeTarget': (p: any) => (p.targetId === 'b' ? new Error('No target with given id') : {}),
    });
    const own2 = await startExtensionChrome({ spawn: fc2.spawn, bin: '/chrome', userDataDir: '/p', extensionDir: '/e' });
    assert.equal(fc2.spawned[0][1].at(-1), 'about:blank');
    // closing a task's tabs: a tab that is already gone is skipped (no log by default), the count says what closed
    assert.equal(await own2.closeTabs(), 1);
    await own2.close();
  });

  test("ext arm: the pairing script waits for the code, presses Pair and returns the extension's settled status, or says there was no code", async () => {
    const run = async (code: string, answers: any[]) => {
      const els: Record<string, any> = { code: { value: code }, pair: { click: () => (els.pair.clicked = true) } };
      const document = { getElementById: (id: string) => els[id] };
      const asked: any[] = [];
      const chrome = {
        runtime: { sendMessage: async (m: any) => (asked.push(m), answers.length > 1 ? answers.shift() : answers[0]) },
      };
      // the page's waits run at once here
      const fast = (f: () => void) => setImmediate(f);
      const result = await new Function('document', 'setTimeout', 'chrome', `return ${PAIR_SCRIPT}`)(document, fast, chrome);
      return { result, clicked: !!els.pair.clicked, asked: asked.length };
    };
    assert.deepEqual(await run('mopilot-claim:1:9:t', [{ status: 'connecting' }, { status: 'connected', port: 9 }]), {
      result: 'connected',
      clicked: true,
      asked: 2,
    });
    assert.deepEqual(await run('', [{}]), { result: 'no code', clicked: false, asked: 0 });
    // still connecting after ten seconds; a failure; no answer at all
    assert.deepEqual(await run('c', [{ status: 'connecting' }]), { result: 'connecting', clicked: true, asked: 100 });
    assert.equal((await run('c', [{ status: 'offline', error: 'bad claim' }])).result, 'bad claim');
    assert.equal((await run('c', [undefined])).result, '');
  });

  test('ext arm: an extension that Chrome does not keep is loaded once more, and the arm stops when it still does not start', async () => {
    // the first look finds nothing (Chrome dropped it), the second load starts
    let looks = 0;
    const logs: string[] = [];
    const retried = fakeChrome({
      'Extensions.loadUnpacked': { id: 'extid' },
      'Target.getTargets': () => (++looks < 3 ? { targetInfos: [] } : ext('extid')),
      'Target.setDiscoverTargets': {},
    });
    await startExtensionChrome({
      spawn: retried.spawn,
      bin: '/c',
      userDataDir: '/p',
      extensionDir: '/e',
      startMs: 1,
      startPollMs: 1,
      log: (l) => logs.push(l),
    });
    assert.equal(retried.sent.filter((m: any) => m.method === 'Extensions.loadUnpacked').length, 2);
    assert.ok(logs.includes('ext: the extension did not start; loading it again'));
    // still nothing after the second load: the arm does not run its chats, and Chrome is closed
    const gone = fakeChrome({ 'Extensions.loadUnpacked': { id: 'extid' }, 'Target.getTargets': { targetInfos: [] }, 'Browser.close': {} });
    await assert.rejects(
      startExtensionChrome({ spawn: gone.spawn, bin: '/c', userDataDir: '/p', extensionDir: '/e', startMs: 1, startPollMs: 1 }),
      /extension extid did not start in Chrome/,
    );
    assert.equal(gone.sent.at(-1).method, 'Browser.close');
  });
}
