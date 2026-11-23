// Claude reaping, current-segment indicators and renderer recovery cases.
import { waitFor } from '../waitFor.ts';
import {
  test,
  assert,
  fs,
  path,
  CU,
  IAB,
  drive,
  browserHost,
  tabOf,
  tmp,
  require,
  ControlIndicator,
  settle,
  within,
  mainApp,
} from './fixture.ts';

export function registerRecovery() {
  const DIALOG = {
    allowed: true,
    subscriber: true,
    installed: true,
    connected: true,
    paired_browser: 'Chrome on Mac',
    urls: { install: 'https://i', reconnect: 'https://r', permissions: 'https://p' },
  };

  const queries: any[] = [];

  (globalThis as any).__lifeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const out: any[] = [];
    let wake = () => {};
    const q: any = {
      options,
      closed: false,
      push(m: any) {
        out.push(m);
        wake();
      },
      close() {
        q.closed = true;
        wake();
      },
      async interrupt() {},
      async getSettings() {
        return { applied: {} };
      },
      async getChromeDialog() {
        return DIALOG;
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (out.length) yield out.shift();
          else if (q.closed) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
    };
    // each prompt is answered with a result; the CLI quits when its input ends (it runs its exit hooks, as on stdin EOF)
    (async () => {
      for await (const m of prompt) q.push({ type: 'result', subtype: 'success', echo: m.message.content });
      q.close();
    })();
    queries.push(q);
    return q;
  };

  test("CM-L08: the idle reaper ending the old Claude CLI after a switch to Codex clears the chat's Claude in Chrome link and leaves the Codex turn alone", async () => {
    const claude = require('../../../electron/harness/claude/index.cjs').createClaudeHarness();
    const app = mainApp();
    const handlers = new Map<string, Function>();
    // main: claude.register's onEvent goes to the controller (sessions.cjs), the link to the chat's state (agentTools.cjs:116)
    claude.register({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, () => {}, {
      onEvent: (e: any) => app.controller.onClaudeEvent(e),
    });
    claude.setChromeLinkListener((chatId: string, link: any) => chatId && app.state.patch(chatId, { chromeLink: link }));
    claude.setTools({ enabled: () => false, nativeChrome: () => true });
    claude.timing.retireMs = 200;
    const sid = 'life-s0';
    const chat = 'chat-L8';
    const first = app.sw.chats.record(chat).segments[0];
    app.sw.chats.commit({ ...app.sw.chats.record(chat), segments: [{ ...first, kind: 'claude', nativeId: sid, count: 0 }] });
    app.controller.invalidate();
    const before = queries.length;
    await claude.send(
      `claude:${sid}`,
      { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', chatId: chat },
      { role: 'user', content: 'open the page' },
    );
    const q = queries[before];
    q.push({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'claude-in-chrome', status: 'connected' }] });
    await waitFor(() => app.state.get(chat).chromeLink, 'the Claude in Chrome link');
    assert.equal(app.state.get(chat).chromeLink?.connected, true, 'the chat shows its Claude in Chrome link');
    // the chat moves to Codex and runs a turn there, with a browser step in flight
    const seg = await app.switchTo(chat, 'codex');
    await app.send(chat);
    assert.equal(app.turn(chat), 'running');
    app.w.hold(IAB);
    const running = (await app.sw.codex.session(seg.nativeId)).call(IAB);
    await settle();
    const active = app.state.get(chat).activeTurn;
    // the reaper ends the old CLI, idle past its limit
    claude.reap(Date.now() + 2 * 60 * 60 * 1000);
    await waitFor(() => !claude.turnApi.isLive(`claude:${sid}`) && !app.state.get(chat).chromeLink, 'the reaped turn and cleared link');
    assert.equal(claude.turnApi.isLive(`claude:${sid}`), false);
    assert.equal(app.state.get(chat).chromeLink, null, "the chat's Claude in Chrome link is cleared");
    assert.equal(app.turn(chat), 'running', 'the Codex turn goes on');
    assert.deepEqual(app.state.get(chat).activeTurn, active);
    assert.deepEqual(app.ends, { tabs: [], cu: [] }, 'nothing the Codex turn holds is let go');
    assert.equal(await within(running, 20), 'still running', "the Codex thread's browser step goes on");
    assert.ok((await app.sw.codex.session(seg.nativeId)).owner, "the thread's sage-mcp session is live");
    app.w.release(IAB);
    await running;
  });

  test("CM-L09a: Stop goes to the harness of the chat's current segment: Claude → Codex → Claude", async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    await app.controller.stopChat(chat);
    await app.switchTo(chat, 'codex');
    await app.controller.stopChat(chat);
    await app.switchTo(chat, 'claude');
    await app.controller.stopChat(chat);
    assert.deepEqual(app.stops, [
      ['claude', chat],
      ['codex', chat],
      ['claude', chat],
    ]);
  });

  test("CM-L09b: Esc while the chat holds the desktop stops the current segment's turn, after a switch too", async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    const shortcuts = new Map<string, Function>();
    const electron = {
      globalShortcut: {
        register: (accel: string, fn: Function) => (shortcuts.set(accel, fn), true),
        unregister: (accel: string) => void shortcuts.delete(accel),
      },
    };
    // computerUse.cjs: the indicator's Esc → cu.stop → onStop: desktop.interrupt + o.stop (agentTools.cjs:264: controller.stopChat)
    const interrupted: string[] = [];
    const indicator = new ControlIndicator({
      electron,
      onEscape: (chatId: string) => (interrupted.push(chatId), app.controller.stopChat(chatId)),
    });
    indicator.sync(chat);
    shortcuts.get('Escape')!();
    await settle();
    await app.switchTo(chat, 'claude');
    shortcuts.get('Escape')!();
    await settle();
    assert.deepEqual(interrupted, [chat, chat]);
    assert.deepEqual(app.stops, [
      ['codex', chat],
      ['claude', chat],
    ]);
    indicator.sync(null);
    assert.equal(shortcuts.has('Escape'), false);
  });

  test("CM-L10: a switch picked while a turn runs applies only after it ends; the old segment's tool finishes first", async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    await app.send(chat, 'first');
    app.w.hold(CU);
    const running = app.sw.claudeNow(chat).call(CU);
    await settle();
    // the user picks Codex in the harness picker and sends the next message while the turn runs
    app.state.patch(chat, { pendingSwitch: { harness: 'codex', model: 'm', modelLabel: 'M', mode: 'workspace' } });
    const r = await app.send(chat, 'second');
    assert.equal(r.action, 'queued', 'not steered into the running turn');
    assert.equal(app.sw.chats.record(chat).segments.at(-1).kind, 'claude', 'still on Claude');
    assert.deepEqual(
      app.starts.map((s) => s[0]),
      ['claude'],
    );
    // the Claude turn's desktop step finishes, then the turn
    app.w.release(CU);
    await running;
    assert.equal(app.sw.chats.record(chat).segments.at(-1).kind, 'claude');
    app.claudeResult('claude:s0');
    await settle(20);
    const seg = app.sw.chats.record(chat).segments.at(-1);
    assert.equal(seg.kind, 'codex', 'the switch applied');
    assert.deepEqual(app.starts, [
      ['claude', chat, 'claude:s0'],
      ['codex', chat, seg.nativeId],
    ]);
    assert.equal(app.state.get(chat).pendingSwitch, null);
    assert.equal(app.turn(chat), 'running');
    assert.deepEqual(
      app.w.calls.map((c) => `${c.tool}@${c.chatId}/${c.segmentId}`),
      [`${CU}@${chat}/s0`],
    );
  });

  test('CM-L16: a tab whose renderer crashed or was killed gets no size emulation, so the app survives it', async (t) => {
    const h = browserHost(t);
    const tab = tabOf(h);
    tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssLayoutViewport: { clientWidth: 640, clientHeight: 500 } });
    const sizes = () =>
      tab.wc.debugger.sent('Emulation.setDeviceMetricsOverride').length +
      tab.wc.debugger.sent('Emulation.clearDeviceMetricsOverride').length;
    await drive(
      t,
      h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
    );
    assert.equal(sizes(), 0, 'agent control preserves the narrow pane viewport');
    tab.wc.crashed = true;
    assert.equal(tab.rendererGone(), true);
    // a crashed renderer receives no implicit size command either
    await drive(
      t,
      h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
    );
    assert.equal(sizes(), 0);
    for (const [method, params] of [
      ['Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 0, mobile: false }],
      ['Emulation.clearDeviceMetricsOverride', {}],
    ] as const) {
      await assert.rejects(tab.send(method, params), { code: 'page_crashed', message: /crashed\. Reload it/ });
    }
    // readiness does not need a device metrics command
    await drive(
      t,
      h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
    );
    assert.equal(sizes(), 0);
    // other commands still go: reloading is how the page comes back
    await tab.send('Page.reload', {});
    assert.equal(tab.wc.debugger.sent('Page.reload').length, 1);
    // guard: size emulation reaches a tab only through Tab.send, which checks the renderer
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.cjs'))
          for (const line of fs.readFileSync(f, 'utf8').split('\n'))
            if (/sendCommand\(|\bquiet\(/.test(line) && /Emulation\.\w*DeviceMetricsOverride/.test(line))
              offenders.push(`${f}: ${line.trim()}`);
      }
    };
    walk(new URL('../../../electron/', import.meta.url).pathname);
    assert.deepEqual(
      offenders.map((f) => path.relative(new URL('../../..', import.meta.url).pathname, f)),
      [],
      'every size command goes through Tab.send, which checks the renderer',
    );
  });
  test('CM-L16a: on a crashed tab every call that needs the page says it crashed and to reload, at once, for every harness; reloading goes', async (t) => {
    const h = browserHost(t);
    const tab = tabOf(h);
    tab.wc.crashed = true;
    // MoPilot's own browser_* tools and the Codex plugin's CDP calls both go through Tab.send: neither waits for the hang
    // check, which would call the page busy and tell the agent not to retry
    for (const method of ['Runtime.evaluate', 'Input.dispatchMouseEvent', 'DOM.getDocument', 'Page.captureScreenshot'])
      await assert.rejects(tab.send(method, {}), { code: 'page_crashed', message: /^This page crashed\. Reload it/ });
    assert.equal(tab.wc.debugger.sent('Runtime.evaluate').length, 0, 'nothing reaches the gone renderer');
    // the way back to a page still goes (a client's own reload sequence enables its domains first), and the page
    // answers again once its renderer is back
    await tab.send('Runtime.enable', {});
    await tab.send('Page.disable', {});
    await tab.send('Page.reload', {});
    await tab.send('Page.navigate', { url: 'https://example.test/' });
    assert.equal(tab.wc.debugger.sent('Page.reload').length + tab.wc.debugger.sent('Page.navigate').length, 2);
    tab.wc.crashed = false;
    await tab.send('Runtime.evaluate', { expression: '1' });
    assert.equal(tab.wc.debugger.sent('Runtime.evaluate').length, 1);
    // the hang check never looks at a crashed renderer, so it is never called busy
    const { PageHang } = await import('../../../electron/capabilities/browser/pageHang.cjs');
    let probed = 0;
    const hang = new PageHang({ probe: () => (probed++, new Promise(() => {})) });
    hang.suspect({ id: 7, isDestroyed: () => false, isCrashed: () => true });
    assert.deepEqual([probed, hang.hung({ id: 7 }), hang.state.size], [0, false, 0]);
  });
  test('CM-L16b: a page that crashes while a command runs says it crashed and to reload, not "Target crashed" (#1561)', async (t) => {
    const h = browserHost(t);
    const tab = tabOf(h);
    const dbg = tab.wc.debugger;
    const send = dbg.sendCommand;
    // the renderer goes while the navigation loads: the debugger answers only "Target crashed"
    dbg.sendCommand = async (method: string, ...rest: any[]) => {
      if (method !== 'Page.navigate') return send.call(dbg, method, ...rest);
      tab.wc.crashed = true;
      throw new Error('Target crashed');
    };
    await assert.rejects(tab.send('Page.navigate', { url: 'https://example.test/' }), {
      code: 'page_crashed',
      message: /^This page crashed\. Reload it/,
    });
    // a failure with the renderer still there is passed on as it was (the same error)
    tab.wc.crashed = false;
    const own = new Error('Cannot find context with specified id');
    dbg.sendCommand = async () => {
      throw own;
    };
    await assert.rejects(tab.send('Runtime.evaluate', {}), (e: unknown) => e === own);
    // an error MoPilot already explained (the tab closed meanwhile) is passed on, even with the renderer gone
    const { ToolError } = await import('../../../electron/capabilities/contract/registry.cjs');
    const closed = new ToolError('Tab 1 was closed.', 'tab_closed');
    dbg.sendCommand = async () => {
      tab.wc.crashed = true;
      throw closed;
    };
    await assert.rejects(tab.send('Page.navigate', { url: 'https://example.test/' }), (e: unknown) => e === closed);
    // a destroyed webContents (its tab closed) throws on isCrashed: it is gone, not crashed, and its error stays
    tab.wc.crashed = false;
    const destroyed = new Error('Target closed');
    const { isCrashed, isDestroyed } = tab.wc;
    dbg.sendCommand = async () => {
      tab.wc.isDestroyed = () => true;
      tab.wc.isCrashed = () => {
        throw new TypeError('Object has been destroyed');
      };
      throw destroyed;
    };
    await assert.rejects(tab.send('Page.navigate', { url: 'https://example.test/' }), (e: unknown) => e === destroyed);
    Object.assign(tab.wc, { isCrashed, isDestroyed });
    dbg.sendCommand = send;
  });
}
