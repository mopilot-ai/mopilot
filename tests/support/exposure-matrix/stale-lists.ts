// stale lists exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  BU,
  CU,
  claudeSession,
  codexConnection,
  world,
  FLAG,
  registration,
  acpSession,
  textOf,
} from './fixture.ts';

export function registerStaleLists() {
  /* ====================================================================== */
  /* CM-X07: a tool from a stale list                                        */
  /* ====================================================================== */

  describe('CM-X07: a stale tool list', () => {
    test('CM-X07a: sage_browser_* listed under Your Chrome, then the built-in browser: refused on every channel with browser_* named, never run', async () => {
      const w = world();
      w.state.yourChrome = true;
      const claude = claudeSession(w, { chatId: 'c', segmentId: 's' });
      const cx = codexConnection(w, (id) => id);
      const { thread } = await cx.startThread();
      const codex = await cx.session(thread.id);
      const acp = await acpSession(w);
      for (const tools of [claude.tools, codex.tools, acp.tools]) assert.ok(tools.includes(BU));
      w.state.yourChrome = false;
      for (const [label, r] of [
        ['Claude', await claude.call(BU)],
        ['Codex', await codex.call(BU)],
        ['ACP', await acp.call(BU)],
      ]) {
        assert.equal(r.isError, true, `${label}: refused`);
        assert.match(textOf(r), /use the browser_\* tools for the built-in browser/, `${label}: names the replacement`);
      }
      assert.deepEqual(w.calls, []);
    });

    test('CM-X07b: computer_* listed before computer parity came on: refused on every channel with desktop_* named, never run', async () => {
      const w = world();
      w.flags[FLAG.computerParity] = false;
      const reg = registration(w);
      reg.startup();
      const claude = claudeSession(w, { chatId: 'c', segmentId: 's' });
      const cx = codexConnection(w, (id) => id);
      const { thread } = await cx.startThread();
      const codex = await cx.session(thread.id);
      const acp = await acpSession(w);
      for (const tools of [claude.tools, codex.tools, acp.tools]) assert.ok(tools.includes('computer_click'));
      w.flags[FLAG.computerParity] = true;
      reg.sync();
      for (const [label, r] of [
        ['Claude', await claude.call('computer_click')],
        ['Codex', await codex.call('computer_click')],
        ['ACP', await acp.call('computer_click')],
      ]) {
        assert.equal(r.isError, true, `${label}: refused`);
        assert.match(textOf(r), /use the desktop_\* tools to control the computer/, `${label}: names the replacement`);
      }
      assert.deepEqual(w.calls, []);
    });

    test('CM-X07c: a Claude in Chrome session that listed sage_browser_* for the pane, then Your Chrome: refused as Claude in Chrome, never run', async () => {
      const w = world();
      w.flags[FLAG.browserParity] = false;
      registration(w).startup();
      const s = claudeSession(w, { chatId: 'c', segmentId: 's' }, { nativeChrome: true });
      assert.ok(s.tools.includes(BU), 'parity off, built-in: sage_browser_* drive the pane');
      w.state.yourChrome = true;
      const r = await s.call(BU);
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Claude in Chrome/);
      assert.deepEqual(w.calls, []);
    });

    test('CM-X07d: a native Codex thread hiding a tool refuses a call to it, and the work never runs', async () => {
      for (const [surfaces, tool] of [
        [{ chrome: false, computer: true }, CU],
        [{ chrome: true, computer: false }, BU],
      ] as const) {
        const w = world();
        w.state.yourChrome = true;
        const cx = codexConnection(w, (id) => id, { ...surfaces });
        const { thread } = await cx.startThread();
        const s = await cx.session(thread.id);
        assert.equal(s.tools.includes(tool), false);
        // e.g. the model saw the tool earlier in a chat that switched from Claude
        const r = await s.call(tool);
        assert.equal(r.isError, true);
        assert.deepEqual(w.calls, []);
      }
    });

    test("CM-X07e: a native Codex thread's refusal names only the surface its harness serves", async () => {
      for (const [surfaces, tool, wrongly] of [
        // Codex Computer Use only: the user's Chrome is still Your Chrome's sage_browser_*
        [{ chrome: false, computer: true }, CU, /browser/i],
        // the Browser plugin only: desktop_* still control the computer
        [{ chrome: true, computer: false }, BU, /computer use/i],
      ] as const) {
        const w = world();
        w.state.yourChrome = true;
        const cx = codexConnection(w, (id) => id, { ...surfaces });
        const { thread } = await cx.startThread();
        const r = await (await cx.session(thread.id)).call(tool);
        assert.equal(r.isError, true);
        assert.doesNotMatch(textOf(r), wrongly, `${tool} on ${JSON.stringify(surfaces)}: ${textOf(r)}`);
        assert.equal(textOf(r), w.vis.message(tool, { nativeChrome: surfaces.chrome, nativeComputer: surfaces.computer }));
      }
    });
  });

  /* ====================================================================== */
  /* CM-X08: the native Codex degraded note                                  */
  /* ====================================================================== */
}
