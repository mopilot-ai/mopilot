// routing browser control matrix cases using shared fake surfaces.
import {
  test,
  assert,
  switchingChat,
  world,
  SessionStore,
  chatHandoffRoute,
  ControllerPlans,
  planInputs,
  toRendererSegment,
} from './fixture.ts';

export function registerRouting() {
  /* ====================================================================== */
  /* Sign-in hand-off to the user's Chrome: every controller, every harness  */
  /* ====================================================================== */

  /**
   * A chat's route as main reads it (app/browserTools.cjs chromeHandoffRoute): its current segment's controller plan
   * (the real ControllerPlans over the kit's switching chat, with main's plan inputs), MoPilot's chrome_* tools and
   * Your Chrome's switch. ACP chats are kept by kind: the kit's switch runner has no ACP harness.
   */
  function routeWorld(
    o: { codex?: { chrome: boolean; computer: boolean }; yourChrome?: boolean; relay?: 'extension' | 'relay' | null } = {},
  ) {
    const w = world();
    const store = new SessionStore();
    let plans: any = null;
    const sw = switchingChat(w, { surfaces: o.codex, segmentEnded: (e) => plans.segmentEnded(e) });
    const claudeChrome = new Map<string, boolean>();
    const acp = new Map<string, string>();
    const ref = (chatId: string) => {
      const kind = acp.get(chatId);
      if (kind) return { kind, id: `s-${chatId}`, instance: null, key: `${kind}:s-${chatId}` };
      const seg = sw.chats.record(chatId).segments.at(-1);
      return { kind: seg.kind, id: seg.nativeId, instance: null, key: toRendererSegment(seg).nativeId };
    };
    plans = new ControllerPlans({
      chats: sw.chats,
      sessions: store,
      ref,
      chatOf: sw.chatOf,
      inputs: planInputs({
        tools: () => [
          ...w.r.list().map((t: { name: string }) => t.name),
          'sage_browser_snapshot',
          ...(o.relay && !w.state.yourChrome ? ['chrome_tabs_context_mcp', 'chrome_navigate'] : []),
        ],
        yourChrome: () => w.state.yourChrome,
        claude: { channel: () => true, nativeChromeOf: (key: string) => claudeChrome.get(key) ?? null, nativeChromeFor: () => false },
        codex: {
          channel: () => true,
          loadedPath: (id: string) => sw.codex.inj.loadedPath(id),
          nativeSurfaces: () => o.codex ?? { chrome: false, computer: false },
          iabAvailable: () => false,
        },
        acp: { channel: () => true },
      }),
    });
    // main's own rule (app/browserTools.cjs chromeHandoffRoute): the plan, the chrome_* channel set up at startup, the switches
    const switches = (k: string) =>
      k === 'shared.browser.extension' ? (o.yourChrome ?? true) : k === 'shared.browser.chromeExtension' ? !!o.relay : false;
    const route = (chatId: string) =>
      chatHandoffRoute({
        plan: plans.snapshot(chatId).plan,
        channelEnabled: plans.snapshot(chatId).channel,
        tools: plans.snapshot(chatId).tools,
        relay: o.relay ? { kind: o.relay, toolsOn: () => switches('shared.browser.chromeExtension') } : null,
        isEnabled: switches,
        channel: w.state.yourChrome ? 'chrome' : 'builtin',
      });
    /** The chat's Claude CLI starts, running Claude in Chrome or not (harness/claude/sessions.cjs reports it). */
    const claudeStarts = (chatId: string, runsClaudeInChrome: boolean) => {
      const key = ref(chatId).key;
      claudeChrome.set(key, runsClaudeInChrome);
      plans.loaded(key, chatId);
    };
    return { w, sw, plans, acp, route, claudeStarts };
  }

  test("CM-B21: the sign-in hand-off's route follows the chat's Chrome controller on every harness, a switched chat's current segment included", async () => {
    // Claude Code: Claude in Chrome when its CLI runs it, else Your Chrome, else MoPilot's chrome_* tools
    for (const [runs, o, want] of [
      [true, {}, 'claude-in-chrome'],
      [false, {}, 'your-chrome'],
      [false, { relay: 'extension' }, 'extension'],
      [false, { yourChrome: false }, 'none'],
    ] as const) {
      const r = routeWorld(o);
      r.sw.startOnClaude('chat');
      r.claudeStarts('chat', runs);
      assert.equal(r.route('chat'), want, `Claude Code, Claude in Chrome ${runs}, ${JSON.stringify(o)}`);
    }
    // Codex native (the Codex Browser plugin) and managed (MoPilot's tools only)
    const native = routeWorld({ codex: { chrome: true, computer: false } });
    native.sw.startOnClaude('codex');
    await native.sw.switchTo('codex', 'codex');
    assert.equal(native.route('codex'), 'codex-browser-plugin');
    const managed = routeWorld({ relay: 'relay' });
    managed.sw.startOnClaude('m');
    await managed.sw.switchTo('m', 'codex');
    assert.equal(managed.route('m'), 'relay', "managed Codex: MoPilot's chrome_* tools");
    managed.w.state.yourChrome = true;
    assert.equal(managed.route('m'), 'your-chrome', 'agents already work in Your Chrome: it wins over the chrome_* tools');
    // ACP: never a vendor controller
    for (const [o, want] of [
      [{}, 'your-chrome'],
      [{ relay: 'extension' }, 'extension'],
      [{ yourChrome: false }, 'none'],
    ] as const) {
      const r = routeWorld(o);
      r.acp.set('acp-chat', 'acp:kimi');
      assert.equal(r.route('acp-chat'), want, `ACP, ${JSON.stringify(o)}`);
    }
    // a chat that switched: Claude (Claude in Chrome) → Codex native → Claude; the route is the current segment's
    const sw = routeWorld({ codex: { chrome: true, computer: false } });
    sw.sw.startOnClaude('s');
    sw.claudeStarts('s', true);
    assert.equal(sw.route('s'), 'claude-in-chrome');
    await sw.sw.switchTo('s', 'codex');
    assert.equal(sw.route('s'), 'codex-browser-plugin', 'never the earlier segment’s Claude in Chrome');
    await sw.sw.switchTo('s', 'claude');
    assert.equal(sw.route('s'), 'claude-in-chrome');
    // and to a managed Codex: Your Chrome, not the Claude segment's controller
    const sm = routeWorld();
    sm.sw.startOnClaude('s');
    sm.claudeStarts('s', true);
    await sm.sw.switchTo('s', 'codex');
    assert.equal(sm.route('s'), 'your-chrome');
    // the chrome_* channel set up at startup but switched off since: not a route any more; a chat with no plan yet
    assert.equal(
      chatHandoffRoute({
        plan: null,
        channelEnabled: true,
        tools: ['sage_browser_snapshot'],
        relay: { kind: 'extension', toolsOn: () => false },
        isEnabled: (k: string) => k === 'shared.browser.extension',
        channel: 'builtin',
      }),
      'your-chrome',
    );
  });
}
