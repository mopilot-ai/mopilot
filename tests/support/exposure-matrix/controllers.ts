// controllers exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  BU,
  CU,
  IAB,
  claudeSession,
  codexConnection,
  world,
  FLAG,
  registration,
  realTabsContext,
  acpSession,
  type Surfaces,
  HARNESSES,
  offered,
  has,
  controllers,
  bools,
  flagCombos,
  setFlags,
} from './fixture.ts';

export function registerControllers() {
  /* ====================================================================== */
  /* CM-X01: one controller per surface, exhaustively                        */
  /* ====================================================================== */

  describe('CM-X01: one controller per surface', () => {
    test('CM-X01: every harness × browser channel × remote switch has at most one controller per surface, and none missing', async () => {
      const problems: string[] = [];
      let cells = 0;
      // every harness and browser channel, with the switches as they were at startup or flipped there live from all on (CM-X02)
      for (const h of HARNESSES)
        for (const yourChrome of bools)
          for (const f of flagCombos)
            for (const live of bools) {
              const w = world();
              const reg = registration(w);
              if (live) {
                reg.startup();
                setFlags(w, f);
                reg.sync();
              } else {
                setFlags(w, f);
                reg.startup();
              }
              w.state.yourChrome = yourChrome;
              const { tools, vendor } = await offered(w, h);
              const n = controllers(tools, vendor, yourChrome);
              const cell = `${h.label} / ${yourChrome ? 'Your Chrome' : 'built-in'} / browserParity=${f.browserParity} computerUse=${f.computer} computerParity=${f.computerParity}${live ? ' (switched live)' : ''}`;
              cells++;
              for (const [surface, count] of Object.entries(n))
                if (count > 1) problems.push(`${cell}: ${count} controllers for ${surface}`);
              // where a controller exists for the surface, the session has one
              const available = {
                iab: f.browserParity || !yourChrome,
                cu: f.computer || vendor.computer,
                bu: yourChrome || vendor.chrome,
              };
              for (const [surface, ok] of Object.entries(available))
                if (ok && n[surface as keyof typeof n] === 0) problems.push(`${cell}: no controller for ${surface}`);
              if (f.browserParity && !tools.includes(IAB)) problems.push(`${cell}: browser_* not offered with browser parity on`);
              // the legacy desktop tools never sit beside desktop_*
              if (has(tools, 'computer_') && has(tools, 'desktop_')) problems.push(`${cell}: computer_* and desktop_* together`);
            }
      assert.equal(cells, HARNESSES.length * 2 * 8 * 2);
      assert.deepEqual(problems, []);
    });

    test('CM-X01a: each harness gets the expected controller for each surface with every switch on', async () => {
      const who = (tools: string[], vendor: Surfaces, yourChrome: boolean) => ({
        cu: vendor.computer ? 'vendor' : has(tools, 'desktop_') ? 'desktop_*' : has(tools, 'computer_') ? 'computer_*' : 'none',
        bu: vendor.chrome ? 'vendor' : yourChrome && has(tools, 'sage_browser_') ? 'sage_browser_*' : 'none',
      });
      const got: Record<string, unknown> = {};
      for (const h of HARNESSES) {
        const w = world();
        w.state.yourChrome = true;
        registration(w).startup();
        const { tools, vendor } = await offered(w, h);
        got[h.label] = who(tools, vendor, true);
      }
      assert.deepEqual(got, {
        Claude: { cu: 'desktop_*', bu: 'sage_browser_*' },
        'Claude with Claude in Chrome': { cu: 'desktop_*', bu: 'vendor' },
        'Codex managed': { cu: 'desktop_*', bu: 'sage_browser_*' },
        'Codex native Chrome only': { cu: 'desktop_*', bu: 'vendor' },
        'Codex native computer only': { cu: 'vendor', bu: 'sage_browser_*' },
        'Codex fully native': { cu: 'vendor', bu: 'vendor' },
        'ACP sage-mcp': { cu: 'desktop_*', bu: 'sage_browser_*' },
      });
    });
  });
}

export function registerLiveSwitches() {
  /* ====================================================================== */
  /* CM-X02: remote kill switches flipped while sessions are live            */
  /* ====================================================================== */

  describe('CM-X02: remote kill switches flipped while sessions run', () => {
    test('CM-X02a: browser parity off brings sage_browser_* back on the per-call list; browser_* calls are refused on both channels', async () => {
      const w = world();
      const reg = registration(w);
      reg.startup();
      const ran = realTabsContext(w);
      const claude = claudeSession(w, { chatId: 'chat-c', segmentId: 's1' });
      const cx = codexConnection(w, (id) => id);
      const { thread } = await cx.startThread();
      const codex = await cx.session(thread.id);
      assert.equal(claude.tools.includes(BU), false, 'built-in channel, parity on: sage_browser_* give way to browser_*');
      assert.equal(codex.tools.includes(BU), false);
      // both channels run the in-app browser while the switch is on
      assert.equal((await claude.call('browser_tabs_context')).isError, false);
      assert.equal((await codex.call('browser_tabs_context')).isError, false);
      assert.deepEqual(ran, ['chat-c', thread.id]);

      w.flags[FLAG.browserParity] = false;
      // Codex lists per call: sage_browser_* are back, and they run
      const relisted = (await cx.session(thread.id)).tools;
      assert.ok(relisted.includes(BU), 'Codex: sage_browser_* back');
      const accepted = await codex.call(BU);
      assert.equal(accepted.isError, false);
      // Claude's list is fixed per CLI process: it keeps browser_* and gets sage_browser_* with its next process
      assert.equal(claude.tools.includes(BU), false);
      assert.ok(claudeSession(w, { chatId: 'chat-c', segmentId: 's1' }).tools.includes(BU), 'the next Claude process has them');
      // the listed browser_* are refused at call time on both channels; their work never runs
      for (const r of [await claude.call('browser_tabs_context'), await codex.call('browser_tabs_context')]) {
        assert.equal(r.isError, true);
        assert.match(r.content.map((c: any) => c.text).join('\n'), /Browser control is turned off/);
      }
      assert.deepEqual(ran, ['chat-c', thread.id], 'no browser_* call ran after the switch went off');
      assert.deepEqual(
        w.calls.map((c) => c.tool),
        [BU],
      );
    });

    test('CM-X02b: with browser parity switched off live, a per-call list does not offer browser_* beside sage_browser_* for the in-app browser', async () => {
      for (const kind of ['codex', 'acp'] as const) {
        const w = world();
        registration(w).startup();
        w.flags[FLAG.browserParity] = false;
        const tools =
          kind === 'codex'
            ? await (async () => {
                const cx = codexConnection(w, (id) => id);
                const { thread } = await cx.startThread();
                return (await cx.session(thread.id)).tools;
              })()
            : (await acpSession(w)).tools;
        assert.ok(tools.includes(BU), `${kind}: sage_browser_* serve the in-app browser again`);
        assert.equal(controllers(tools, { chrome: false, computer: false }, false).iab, 1, `${kind}: one in-app browser controller`);
      }
    });

    test('CM-X02c: computer use switched off live refuses desktop_* on the Claude snapshot and drops them from the Codex and ACP lists', async () => {
      const w = world();
      const reg = registration(w);
      reg.startup();
      const claude = claudeSession(w, { chatId: 'chat-c', segmentId: 's1' });
      const cx = codexConnection(w, (id) => id);
      const { thread } = await cx.startThread();
      const codex = await cx.session(thread.id);
      const acp = await acpSession(w);
      for (const tools of [claude.tools, codex.tools, acp.tools]) assert.ok(tools.includes(CU));

      w.flags[FLAG.computer] = false;
      reg.sync();
      // each refusal names the tool as that harness knows it: Claude calls it click on mopilot_computer
      for (const [r, name] of [
        [await claude.call(CU), /\bclick\b/],
        [await codex.call(CU), new RegExp(CU)],
        [await acp.call(CU), new RegExp(CU)],
      ] as const) {
        assert.equal(r.isError, true);
        assert.match(r.content.map((c: any) => c.text).join('\n'), name);
      }
      assert.deepEqual(w.calls, [], 'no desktop call ran');
      for (const tools of [(await cx.session(thread.id)).tools, await acp.list()]) {
        assert.equal(has(tools, 'desktop_'), false);
        assert.equal(has(tools, 'computer_'), false);
      }
      // back on: the per-call lists offer desktop_* again and a call runs
      w.flags[FLAG.computer] = true;
      reg.sync();
      assert.ok((await acp.list()).includes(CU));
      assert.equal((await codex.call(CU)).isError, false);
      assert.equal((await claude.call(CU)).isError, false, "the Claude process's listed desktop_* work again");
    });

    test('CM-X02d: computer parity switched off live brings computer_* back on the per-call lists, never beside desktop_*', async () => {
      const w = world();
      const reg = registration(w);
      reg.startup();
      const claude = claudeSession(w, { chatId: 'chat-c', segmentId: 's1' });
      const cx = codexConnection(w, (id) => id);
      const { thread } = await cx.startThread();
      const codex = await cx.session(thread.id);
      assert.equal(has(codex.tools, 'computer_'), false);

      w.flags[FLAG.computerParity] = false;
      reg.sync();
      const relisted = (await cx.session(thread.id)).tools;
      assert.ok(relisted.includes('computer_click'));
      assert.equal(has(relisted, 'desktop_'), false);
      assert.equal((await codex.call('computer_click')).isError, false);
      // Claude's process keeps desktop_* listed: refused now, computer_* reach it with its next process
      assert.equal((await claude.call(CU)).isError, true);
      const next = claudeSession(w, { chatId: 'chat-c', segmentId: 's1' }).tools;
      assert.ok(next.includes('computer_click'));
      assert.equal(has(next, 'desktop_'), false);
      assert.deepEqual(
        w.calls.map((c) => c.tool),
        ['computer_click'],
      );
    });
  });
}
