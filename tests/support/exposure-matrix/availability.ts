// availability exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  BU,
  CU,
  IAB,
  codexConnection,
  world,
  has,
  controllers,
  claudeMod,
  send,
  newKey,
  presented,
  chromeArg,
  withLogin,
  claudeFacts,
  wireClaude,
  closeAll,
  codexFacts,
  codexAvailability,
} from './fixture.ts';

export function registerAvailability() {
  describe('CM-X04: availability changes mid-session', () => {
    test('CM-X04a: Codex Computer Use removed while a native thread is loaded: kept until unload and resume, then desktop_* return', async () => {
      const w = world();
      w.state.yourChrome = true;
      const { na, probe, surfaces } = codexAvailability(w, {});
      const cx = codexConnection(w, (id) => id, surfaces);
      const { thread } = await cx.startThread();
      assert.equal(cx.inj.isNativeThread(thread.id), true);
      let tools = (await cx.session(thread.id)).tools;
      assert.equal(has(tools, 'desktop_'), false);
      assert.equal(tools.includes(BU), false);

      probe.facts = codexFacts({ sky: false });
      na.refresh({ force: true });
      assert.deepEqual(na.codexSurfaces(), { chrome: true, computer: false });
      // a resume of the loaded thread is ignored by Codex: its path stays
      cx.resume(thread.id);
      tools = (await cx.session(thread.id)).tools;
      assert.equal(has(tools, 'desktop_'), false, 'known limit: the loaded thread keeps the vendor path');
      cx.unload(thread.id);
      cx.resume(thread.id);
      tools = (await cx.session(thread.id)).tools;
      assert.ok(tools.includes(CU), 'desktop_* after the reload');
      assert.equal(tools.includes(BU), false, 'the Browser plugin still serves Chrome');
      assert.deepEqual(controllers(tools, na.codexSurfaces(), true), { iab: 1, cu: 1, bu: 1 });
    });

    test('CM-X04b: the ChatGPT for Chrome extension installed while a managed thread is loaded: Your Chrome stays until the reload', async () => {
      const w = world();
      w.state.yourChrome = true;
      const { na, probe, surfaces } = codexAvailability(w, { sky: false, chrome: false });
      const cx = codexConnection(w, (id) => id, surfaces);
      const { thread } = await cx.startThread();
      assert.equal(cx.inj.isNativeThread(thread.id), false);
      assert.ok((await cx.session(thread.id)).tools.includes(BU));
      probe.facts = codexFacts({ sky: false, chrome: true });
      na.refresh({ force: true });
      cx.resume(thread.id);
      assert.ok((await cx.session(thread.id)).tools.includes(BU), 'still Your Chrome while loaded');
      assert.equal(cx.inj.isNativeThread(thread.id), false);
      cx.unload(thread.id);
      cx.resume(thread.id);
      const tools = (await cx.session(thread.id)).tools;
      assert.equal(cx.inj.isNativeThread(thread.id), true);
      assert.equal(tools.includes(BU), false, 'the Browser plugin serves Chrome now');
      assert.ok(tools.includes(CU), 'desktop_* stay: Codex Computer Use is still missing');
      // a new thread picks the new path at once
      const other = await cx.startThread();
      assert.equal((await cx.session(other.thread.id)).tools.includes(BU), false);
    });

    test('CM-X04c: Claude in Chrome becoming ready reaches a chat with its next CLI process, not the live one', async () => {
      const w = world();
      w.state.yourChrome = true;
      const { na, probe } = wireClaude(w, { ready: false });
      const keys: string[] = [];
      try {
        await withLogin('claude.ai', async () => {
          const key = keys[keys.push(newKey()) - 1];
          // ephemeral: an unpersisted process is reused as long as it lives
          const first = await send(key, { ephemeral: true });
          assert.equal(chromeArg(first.q), '--no-chrome');
          assert.ok(presented(first.q, w).includes(BU));
          // the user installs the extension: the next probe sees it
          probe.facts = claudeFacts(true);
          na.refresh({ force: true });
          assert.equal(claudeMod.nativeChromeFor('default'), true);
          const again = await send(key, { ephemeral: true });
          assert.equal(again.fresh, false, 'the live process takes the next prompt');
          assert.equal(chromeArg(first.q), '--no-chrome');
          assert.ok(presented(first.q, w).includes(BU), 'the live process keeps Your Chrome');
          // a new process (a new chat, or this one restarted) runs Claude in Chrome
          const next = await send(keys[keys.push(newKey()) - 1]);
          assert.equal(chromeArg(next.q), '--chrome');
          assert.equal(presented(next.q, w).includes(BU), false);
          assert.ok(presented(next.q, w).includes(IAB));
          // and the other way: the extension gone, new processes are back on Your Chrome
          probe.facts = claudeFacts(false);
          na.refresh({ force: true });
          const gone = await send(keys[keys.push(newKey()) - 1]);
          assert.equal(chromeArg(gone.q), '--no-chrome');
          assert.ok(presented(gone.q, w).includes(BU));
        });
      } finally {
        await closeAll(keys);
      }
    });
  });
}
