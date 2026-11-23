// driver Chrome comparison cases using shared fake drivers and page services.
import {
  test,
  assert,
  fs,
  os,
  path,
  ARMS,
  electronDriver,
  chromeBin,
  HOLD_MS,
  DESKTOP_DECLINE,
  spawnSpec,
  fakePage,
  fakeChrome,
  ext,
} from './fixture.ts';

export function registerDriver() {
  test('driver: an arm is a separate instance with its own user data, switches and the scratch profile; a task answers, counts cards and calls', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-driver-'));
    try {
      const spawned: any[] = [];
      const spawn: any = (cmd: string, args: string[]) => (spawned.push([cmd, args]), { unref() {} });
      const fp = fakePage({ stopPolls: 3, cards: 1, answers: ['first', 'The code is DE-4471'] });
      const launches: any[] = [];
      const electron = {
        launch: async (o: any) => (launches.push(o), { firstWindow: async () => fp.page, close: async () => launches.push('closed') }),
      };
      let t = 0;
      const d = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/tmp/f.txt',
        signIn: 'http://b/login',
        electron,
        spawn,
        pollMs: 1,
        now: () => (t += 10),
        env: {},
      });
      const s = await d.start('b2', ARMS.b2);
      assert.deepEqual(spawned[0], [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['--user-data-dir=/tmp/scratch', 'http://b/login'],
      ]);
      assert.deepEqual(launches[0].args, ['/src/app']);
      assert.equal(launches[0].env.MOPILOT_FLAGS, ARMS.b2.flags);
      assert.equal(launches[0].env.SAGE_E2E_BACKGROUND, '1');
      const prefs = JSON.parse(fs.readFileSync(path.join(work, 'mopilot-b2', 'ui-state.json'), 'utf8')).prefs;
      assert.equal(prefs.browserChannel, 'builtin');
      // no --effort: the model's own default
      assert.equal('effort' in prefs, false);
      // the operation log of the chat, between the task's start and end
      fs.mkdirSync(path.join(s.userData, 'capabilities'), { recursive: true });
      fs.writeFileSync(
        path.join(s.userData, 'capabilities', 'operations.jsonl'),
        `${JSON.stringify({ at: 20, chatId: 'chat-1', outcome: 'ok' })}\n`,
      );
      const r = await d.runTask(s, { harness: 'claude', prompt: 'p', timeoutMs: 10_000 });
      assert.deepEqual(r, { answer: 'The code is DE-4471', cards: 1, calls: 1, invalid: 0 });
      assert.ok(fp.clicks.includes('.hp-harnesses .hp-row:Claude Code'));
      // no model named: the harness's first
      assert.ok(fp.clicks.includes('.hp-models .menu-item'));
      // the card was up while Stop was not (it took the composer's place): the turn went on, and Allow was held
      assert.deepEqual(fp.holds, [HOLD_MS]);
      assert.ok(HOLD_MS > 1000);
      await d.stop(s);
      assert.equal(launches.at(-1), 'closed');
      assert.equal(chromeBin({ MOPILOT_CHROME_RELAY_EXECUTABLE: '/x' }), '/x');
      assert.equal(typeof chromeBin(), 'string');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('driver: the native arm counts no calls, a missing log counts none, no answer is empty, and a task past its time is stopped', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-driver-'));
    try {
      const mk = (fp: any) => ({ launch: async () => ({ firstWindow: async () => fp.page, close: async () => undefined }) });
      let t = 0;
      const fp1 = fakePage({ stopPolls: 0 });
      const opened: any[] = [];
      const spawn: any = (_cmd: string, args: string[]) => (opened.push(args), { unref() {} });
      const d1 = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron: mk(fp1),
        spawn,
        pollMs: 1,
        startMs: 3,
        now: () => (t += 10),
      });
      const native = await d1.start('native', ARMS.native);
      // the scratch profile's Chrome is running before the instance, even with no account to sign in
      assert.deepEqual(opened[0], ['--user-data-dir=/s', 'about:blank']);
      assert.deepEqual(await d1.runTask(native, { harness: 'codex', prompt: 'p', timeoutMs: 1000 }), {
        answer: '',
        cards: 0,
        calls: null,
        invalid: null,
      });
      assert.ok(fp1.clicks.includes('.hp-harnesses .hp-row:Codex'));
      const b1 = await d1.start('b1', ARMS.b1);
      // an ACP harness, by its row in the picker (#1483)
      assert.deepEqual(await d1.runTask(b1, { harness: 'opencode', prompt: 'p', timeoutMs: 1000 }), {
        answer: '',
        cards: 0,
        calls: null,
        invalid: null,
      });
      assert.ok(fp1.clicks.includes('.hp-harnesses .hp-row:OpenCode'));
      // a basic harness's row closes the picker with its last model: another model is picked from the model menu
      const basic = async (label: string, model?: string) => {
        const fp = fakePage({ stopPolls: 0, basic: true, label });
        const d = electronDriver({ app: '/a', userDataDir: '/s', work, uploadFile: '/f', electron: mk(fp), spawn, pollMs: 1, startMs: 3 });
        await d.runTask(await d.start('b1', ARMS.b1), { harness: 'opencode', model, prompt: 'p', timeoutMs: 1000 });
        return fp.clicks.filter((c) => c === 'Select model' || c.startsWith('.menu-item') || c.startsWith('.hp-models'));
      };
      assert.deepEqual(await basic('opencode · OpenCode/Beam Free', 'Big Pickle'), [
        'Select model',
        'Select model',
        '.menu-item:Big Pickle',
      ]);
      assert.deepEqual(await basic('opencode · OpenCode/Big Pickle', 'Big Pickle'), ['Select model']);
      assert.deepEqual(await basic('opencode · OpenCode/Beam Free'), ['Select model']);
      assert.deepEqual(await d1.runTask(b1, { harness: 'codex', prompt: 'p', timeoutMs: 1000 }), {
        answer: '',
        cards: 0,
        calls: null,
        invalid: null,
      });
      const fp2 = fakePage({ stopPolls: 100 });
      const d2 = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron: mk(fp2),
        spawn,
        pollMs: 1,
        startMs: 3,
        now: () => (t += 1000),
      });
      const s2 = await d2.start('b2', ARMS.b2);
      await assert.rejects(d2.runTask(s2, { harness: 'claude', prompt: 'p', timeoutMs: 3000 }), /timed out after 3 s/);
      assert.ok(fp2.clicks.includes('stop'));
      // a turn that shows it started only after a while is waited for; one that never does ends after startMs
      const late = fakePage({ stopPolls: 2, quietPolls: 3, answers: ['late'] });
      const d4 = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron: mk(late),
        spawn,
        pollMs: 1,
        now: () => t,
      });
      const s4 = await d4.start('b2', ARMS.b2);
      assert.equal((await d4.runTask(s4, { harness: 'claude', model: 'Sonnet 5.5', prompt: 'p', timeoutMs: 3000 })).answer, 'late');
      // a model named on the command line is picked by its name in the picker, not the first one
      assert.ok(late.clicks.includes('.hp-models .menu-item:Sonnet 5.5'));
      const never = fakePage({ stopPolls: 0, quietPolls: 1000 });
      const d5 = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron: mk(never),
        spawn,
        pollMs: 1,
        startMs: 5,
        now: () => t,
      });
      const s5 = await d5.start('b2', ARMS.b2);
      assert.equal((await d5.runTask(s5, { harness: 'claude', prompt: 'p', timeoutMs: 3000 })).answer, '');
      // a card asking to drive the Chrome app with the mouse and keyboard is declined, and counted
      const cu = fakePage({ stopPolls: 1, desktopCards: 1, answers: ['no'] });
      const d6 = electronDriver({ app: '/a', userDataDir: '/s', work, uploadFile: '/f', electron: mk(cu), spawn, pollMs: 1, now: () => t });
      const r6 = await d6.runTask(await d6.start('b2', ARMS.b2), { harness: 'codex', prompt: 'p', timeoutMs: 3000 });
      assert.deepEqual([r6.declined, r6.cards, cu.clicks.includes('decline')], [1, 0, true]);
      assert.match(DESKTOP_DECLINE, /Allow Computer Use to use/);
      // a card with nothing to allow holds the turn until its time is up; with no Stop to press, it just ends
      const fp3 = fakePage({ stopPolls: 0, stuckCard: true });
      const d3 = electronDriver({
        app: '/a',
        userDataDir: '/s',
        work,
        uploadFile: '/f',
        electron: mk(fp3),
        spawn,
        pollMs: 1,
        now: () => (t += 1000),
      });
      const s3 = await d3.start('b2', ARMS.b2);
      await assert.rejects(d3.runTask(s3, { harness: 'claude', prompt: 'p', timeoutMs: 3000 }), /timed out after 3 s/);
      assert.ok(!fp3.clicks.includes('stop'));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('Your Chrome opens the comparison’s scratch profile when one is set, never otherwise', () => {
    assert.equal(
      spawnSpec({ outputDir: '/o', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/tmp/scratch' } }).options.env
        .PWTEST_EXTENSION_USER_DATA_DIR,
      '/tmp/scratch',
    );
    assert.equal(spawnSpec({ outputDir: '/o', env: {} }).options.env.PWTEST_EXTENSION_USER_DATA_DIR, undefined);
  });
}

export function registerExtensionDriver() {
  test('driver: the ext arm runs its own Chrome on a fresh scratch profile with the extension, hands that profile to MoPilot, counts pairings per task and closes it', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-driver-'));
    try {
      let paired = 0;
      const answers: Record<string, any> = {
        'Extensions.loadUnpacked': { id: 'extid' },
        'Target.setDiscoverTargets': {},
        'Target.attachToTarget': { sessionId: 's' },
        'Runtime.evaluate': () => (paired++, { result: { value: 'Connected to MoPilot.' } }),
        'Target.closeTarget': {},
        'Browser.close': {},
        // after each task the task's tabs close, one blank tab kept (#1699)
        'Target.createTarget': { targetId: 'keep' },
        'Target.getTargets': {
          targetInfos: [
            { type: 'page', targetId: 'keep', url: 'about:blank' },
            { type: 'page', targetId: 'old', url: 'http://127.0.0.1:9/download' },
            { type: 'page', targetId: 'opts', url: 'chrome-extension://extid/options.html' },
            { type: 'service_worker', targetId: 'sw', url: 'chrome-extension://extid/background.mjs' },
          ],
        },
      };
      const fc = fakeChrome(answers);
      const fp = fakePage({ stopPolls: 3, answers: ['DE-4471'] });
      const launches: any[] = [];
      const electron = { launch: async (o: any) => (launches.push(o), { firstWindow: async () => fp.page, close: async () => undefined }) };
      const logs: string[] = [];
      const d = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/f',
        electron,
        spawn: fc.spawn,
        pollMs: 5,
        env: {},
        log: (s) => logs.push(s),
      });
      const s = await d.start('ext', ARMS.ext);
      assert.equal(fc.spawned.length, 1);
      assert.equal(fc.spawned[0][1][0], `--user-data-dir=${path.join(work, 'chrome-ext')}`);
      assert.deepEqual(fc.sent[0].params, { path: path.join('/src/app', 'dist', 'chrome-extension') });
      assert.equal(launches[0].env.MOPILOT_CHROME_RELAY_USER_DATA_DIR, path.join(work, 'chrome-ext'));
      assert.equal(launches[0].env.MOPILOT_FLAGS, ARMS.ext.flags);
      assert.match(logs[0], /loaded MoPilot's extension extid/);
      // the first task's Chrome call opens the pairing page, which is answered; the next task pairs no more
      const task = d.runTask(s, { harness: 'codex', prompt: 'p', timeoutMs: 10_000 });
      fc.emit('Target.targetCreated', { targetInfo: { type: 'page', url: 'chrome-extension://extid/options.html#pair=x', targetId: 't' } });
      const r = await task;
      assert.equal(paired, 1);
      assert.deepEqual(r, { answer: 'DE-4471', cards: 0, calls: null, invalid: null, pairings: 1 });
      assert.deepEqual(
        fc.sent.filter((m: any) => m.method === 'Target.closeTarget').map((m: any) => m.params.targetId),
        ['t', 'old'],
        'the pairing page, then the task’s own tab; the kept blank tab, the extension’s pages and workers stay',
      );
      // a Chrome that can't open the blank tab: logged, the task's result stands
      answers['Target.createTarget'] = new Error('Chrome is gone');
      assert.equal((await d.runTask(s, { harness: 'codex', prompt: 'p', timeoutMs: 10_000 })).pairings, 0);
      assert.ok(logs.some((l) => /closing the task's tabs failed: Error: Chrome is gone/.test(l)));
      await d.stop(s);
      assert.equal(fc.sent.at(-1).method, 'Browser.close');
      // without a log, the arm's Chrome starts the same way
      const fc2 = fakeChrome({ 'Extensions.loadUnpacked': { id: 'x' }, 'Target.getTargets': ext('x'), 'Target.setDiscoverTargets': {} });
      // the instance does not start, or fails to close: the arm's Chrome is closed all the same
      const fc3 = fakeChrome({
        'Extensions.loadUnpacked': { id: 'x' },
        'Target.getTargets': ext('x'),
        'Target.setDiscoverTargets': {},
        'Browser.close': {},
      });
      const failing = {
        launch: async () => ({
          firstWindow: async () => {
            throw new Error('no window');
          },
        }),
      };
      const d3 = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/f',
        electron: failing,
        spawn: fc3.spawn,
        env: {},
      });
      await assert.rejects(d3.start('ext', ARMS.ext), /no window/);
      assert.equal(fc3.sent.at(-1).method, 'Browser.close');
      const fc4 = fakeChrome({
        'Extensions.loadUnpacked': { id: 'x' },
        'Target.getTargets': ext('x'),
        'Target.setDiscoverTargets': {},
        'Browser.close': {},
      });
      const stuck = {
        launch: async () => ({
          firstWindow: async () => fp.page,
          close: async () => {
            throw new Error('close failed');
          },
        }),
      };
      const d4 = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/f',
        electron: stuck,
        spawn: fc4.spawn,
        env: {},
      });
      await assert.rejects(d4.stop(await d4.start('ext', ARMS.ext)), /close failed/);
      assert.equal(fc4.sent.at(-1).method, 'Browser.close');
      // a non-ext arm that fails to start has no Chrome of its own to close
      const d5 = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/f',
        electron: failing,
        spawn: (() => ({ unref() {} })) as any,
        env: {},
      });
      await assert.rejects(d5.start('b2', ARMS.b2), /no window/);
      const quiet = electronDriver({
        app: '/src/app',
        userDataDir: '/tmp/scratch',
        work,
        uploadFile: '/f',
        electron,
        spawn: fc2.spawn,
        env: {},
      });
      assert.equal((await quiet.start('ext', ARMS.ext)).own?.id, 'x');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
