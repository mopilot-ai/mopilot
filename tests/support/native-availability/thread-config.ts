// thread config native availability cases using shared in-memory fixtures.
import {
  test,
  assert,
  ToolVisibility,
  isToolHidden,
  CodexToolInjection,
  IN_APP_BROWSER_CONTEXT,
  inAppBrowserNote,
  scopeNote,
  NATIVE_CUA_PLUGIN,
  ToolSessions,
  chromeSelectionNote,
} from './fixture.ts';

export function registerThreadConfig() {
  /* ------------------------------------------------------------ tool visibility */

  function visibility(registered: string[], flags: Record<string, boolean> = {}) {
    const set = new Set(registered);
    return new ToolVisibility({ registry: { has: (n: string) => set.has(n) }, isEnabled: (k: string) => !!flags[k] });
  }

  test('ToolVisibility.managedComputer: MoPilot computer use counts only when a computer tool is registered and shown', () => {
    const on = { 'shared.computerUse.enabled': true, 'shared.computerUse.parityTools': true };
    assert.equal(visibility(['desktop_screenshot'], on).managedComputer(), true);
    // legacy computer_* tools while desktop_* are off
    assert.equal(visibility(['computer_screenshot'], { 'shared.computerUse.enabled': true }).managedComputer(), true);
    // computer_* registered but replaced by desktop_* that aren't registered: none shown
    assert.equal(visibility(['computer_screenshot'], { ...on }).managedComputer(), true);
    assert.equal(visibility([], on).managedComputer(), false);
  });

  test("a session hides MoPilot's tools only for the surface its harness really serves", () => {
    const chromeOnly = { drivesUserChrome: true, nativeChrome: true, nativeComputer: false };
    assert.equal(isToolHidden('sage_browser_click', chromeOnly), true);
    assert.equal(isToolHidden('desktop_click', chromeOnly), false);
    const computerOnly = { drivesUserChrome: true, nativeChrome: false, nativeComputer: true };
    assert.equal(isToolHidden('sage_browser_click', computerOnly), false);
    assert.equal(isToolHidden('desktop_click', computerOnly), true);
  });

  /* -------------------------------------------------------- Codex thread config */

  function injection(o: any = {}) {
    const sessions = new ToolSessions();
    const inj = new CodexToolInjection({
      sessions,
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      nativeEnabled: () => true,
      visibleTools: () => ['browser_navigate', 'desktop_click'],
      ...o,
    });
    let id = 0;
    const load = (threadId: string) => {
      const rid = ++id;
      const sent = inj.outgoing({ id: rid, method: 'thread/start', params: {} });
      inj.observe({ id: rid, result: { thread: { id: threadId } } });
      return sent;
    };
    return { inj, sessions, load };
  }
  const pluginOf = (sent: any) => sent.params.config.plugins[NATIVE_CUA_PLUGIN].enabled;
  const sageServer = (sent: any) => Object.keys(sent.params.config.mcp_servers).find((n) => n.startsWith('sage_'))!;

  test('Codex: with no native surface on this Mac a thread stays managed, with every MoPilot tool', () => {
    const asked: any[] = [];
    const { inj, sessions, load } = injection({
      nativeSurfaces: () => ({ chrome: false, computer: false }),
      nativeHideFor: (s: any) => (asked.push(s), () => true),
    });
    const sent = load('th');
    assert.equal(pluginOf(sent), false);
    assert.equal(inj.isNativeThread('th'), false);
    assert.deepEqual(asked, []);
    assert.equal(sessions.get(inj.byThread.get('th')).hide, null);
    // a managed thread gets the shared note on what MoPilot's tools reach, not the native routing (#1319 G3)
    assert.doesNotMatch(inj.turnContext('th')?.context.value ?? '', /Browser routing in MoPilot/);
    // without sage-mcp too: the thread is left as it was
    const bare = injection({ hasTools: () => false, nativeSurfaces: () => ({ chrome: false, computer: false }) });
    const msg = { id: 9, method: 'thread/start', params: {} };
    assert.equal(bare.inj.outgoing(msg), msg);
  });

  test("Codex: one native surface turns the plugin on and hides MoPilot's tools only for that surface", () => {
    const asked: any[] = [];
    const hideFor = (s: any) => {
      asked.push(s);
      return (name: string) => isToolHidden(name, { drivesUserChrome: true, nativeChrome: s.chrome, nativeComputer: s.computer });
    };
    const notes: any[] = [];
    const { inj, sessions, load } = injection({
      nativeSurfaces: () => ({ chrome: true, computer: false }),
      nativeHideFor: hideFor,
      degradedNote: (s: any, server: string) => (notes.push([s, server]), `missing computer on ${server}`),
    });
    const sent = load('th');
    assert.equal(pluginOf(sent), true);
    assert.equal(inj.isNativeThread('th'), true);
    assert.deepEqual(asked, [{ chrome: true, computer: false }]);
    const hide = sessions.get(inj.byThread.get('th')).hide;
    assert.equal(hide('sage_browser_click'), true);
    assert.equal(hide('desktop_click'), false);
    // the model is told both: the in-app browser routing, and what the plugin can't do here
    const server = sageServer(sent);
    const note = inj.turnContext('th');
    assert.equal(note.key, IN_APP_BROWSER_CONTEXT);
    assert.equal(note.context.value, `${scopeNote(server)}\n\n${inAppBrowserNote(server, true).value}\n\nmissing computer on ${server}`);
    assert.deepEqual(notes, [[{ chrome: true, computer: false }, server]]);
  });

  test("Codex: without native Chrome the browser note no longer claims the plugin drives the user's Chrome", () => {
    const { inj, load } = injection({ nativeSurfaces: () => ({ chrome: false, computer: true }), degradedNote: () => null });
    const server = sageServer(load('th'));
    const value = inj.turnContext('th').context.value;
    assert.equal(value, `${scopeNote(server)}\n\n${inAppBrowserNote(server, false).value}`);
    assert.doesNotMatch(value, /Browser plugin/);
    assert.match(value, new RegExp(`browser_\\* tools of the ${server} MCP server`));
  });

  test('Codex: the missing-surface note alone, when the thread lists no browser_* tools; nothing when there is nothing to say', () => {
    const { inj, load } = injection({
      visibleTools: () => ['desktop_click'],
      nativeSurfaces: () => ({ chrome: true, computer: false }),
      degradedNote: () => 'computer is missing',
    });
    const server = sageServer(load('th'));
    // the Chrome selection rule goes out with it: the plugin's Chrome is chosen by id (CM-W04); the missing-surface
    // note names MoPilot's settings, so it follows the scope note
    assert.equal(inj.turnContext('th').context.value, `${chromeSelectionNote(null)}\n\n${scopeNote(server)}\n\ncomputer is missing`);
    // a note reader that fails or has nothing to add leaves no note
    const failing = injection({
      visibleTools: () => [],
      nativeSurfaces: () => ({ chrome: false, computer: true }),
      degradedNote: () => {
        throw new Error('x');
      },
    });
    failing.load('th');
    assert.equal(failing.inj.turnContext('th'), null);
    const silent = injection({ visibleTools: () => [], nativeSurfaces: () => ({ chrome: false, computer: true }) });
    silent.load('th');
    assert.equal(silent.inj.turnContext('th'), null);
  });

  test('Codex: a native thread without sage-mcp still gets the plugin for the surface its runtime serves', () => {
    const { inj } = injection({ hasTools: () => false, nativeSurfaces: () => ({ chrome: false, computer: true }) });
    const sent = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    assert.equal(pluginOf(sent), true);
    assert.equal(inj.isNativeThread('th'), true);
    // no sage-mcp session, so no note to carry
    assert.equal(inj.turnContext('th'), null);
  });

  test('Codex: the native switch off never asks the probe', () => {
    let asked = 0;
    const { inj, load } = injection({ nativeEnabled: () => false, nativeSurfaces: () => (asked++, { chrome: true, computer: true }) });
    assert.equal(pluginOf(load('th')), false);
    assert.equal(asked, 0);
    assert.equal(inj.isNativeThread('th'), false);
  });
}
