// Tool routing across harnesses (PR #351): the one visibility rule every tool channel asks
// (electron/capabilities/visibility.cjs), the Registry's hidden filter and refusal, a native Codex
// thread's one-time built-in browser note (codexConfig.cjs turnContext, merged into turn/start by
// harness/codex.cjs) and the turn-end cleanup every harness shares (capabilities/turnEnd.cjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isToolHidden,
  hiddenToolMessage,
  hideRule,
  hiddenRefusalText,
  CLAUDE_IN_CHROME_HOST,
  ToolVisibility,
  IN_APP_BROWSER_PROBE,
  DESKTOP_PROBE,
} = require('../electron/capabilities/visibility.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { hostTurnEnd, turnLedger, codexTurnEndedChat, patchTurnEndedChat } = require('../electron/capabilities/turnEnd.cjs');
const {
  CodexToolInjection,
  IN_APP_BROWSER_CONTEXT,
  inAppBrowserNote,
  scopeNote,
} = require('../electron/capabilities/channels/codexConfig.cjs');
const { chromeSelectionNote } = require('../electron/capabilities/browser/codexChromePick.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

/* ---------- the visibility rule ---------- */

test("isToolHidden: legacy panel tools give way to browser_* unless they drive the user's Chrome", () => {
  // built-in browser channel: sage_browser_* hidden only once the browser_* set is on
  assert.equal(isToolHidden('sage_browser_navigate', { browserParity: true }), true);
  assert.equal(isToolHidden('sage_browser_navigate', { browserParity: false }), false);
  assert.equal(isToolHidden('sage_browser_navigate'), false);
  // Your Chrome channel: kept, unless the harness controls Chrome itself (Claude in Chrome, Codex's Browser plugin)
  assert.equal(isToolHidden('sage_browser_navigate', { browserParity: true, drivesUserChrome: true }), false);
  assert.equal(isToolHidden('sage_browser_navigate', { browserParity: true, drivesUserChrome: true, nativeChrome: true }), true);
  // the built-in browser's own tools are never hidden, whatever the harness
  assert.equal(
    isToolHidden('browser_navigate', { browserParity: true, drivesUserChrome: true, nativeChrome: true, nativeComputer: true }),
    false,
  );
});

test('isToolHidden: desktop_* replace computer_*, and a harness with its own computer use gets neither', () => {
  assert.equal(isToolHidden('computer_click', {}), false);
  assert.equal(isToolHidden('computer_click', { computerParity: true }), true);
  assert.equal(isToolHidden('computer_click', { nativeComputer: true }), true);
  assert.equal(isToolHidden('desktop_click', { computerParity: true }), false);
  assert.equal(isToolHidden('desktop_click', { nativeComputer: true }), true);
  assert.equal(
    isToolHidden('sage_debug_echo', { browserParity: true, computerParity: true, nativeChrome: true, nativeComputer: true }),
    false,
  );
  assert.equal(isToolHidden(42 as any, { nativeComputer: true }), false);
});

test('hiddenToolMessage names the replacement for each refused tool', () => {
  assert.match(
    hiddenToolMessage('sage_browser_click', { drivesUserChrome: true }),
    /^sage_browser_click is unavailable in this session: this harness controls the user's Chrome itself\.$/,
  );
  assert.match(hiddenToolMessage('sage_browser_click', {}), /use the browser_\* tools for the built-in browser/);
  assert.match(hiddenToolMessage('sage_browser_click'), /use the browser_\* tools/);
  assert.match(hiddenToolMessage('computer_click', { computerParity: true }), /use the desktop_\* tools to control the computer/);
  // hidden for the harness's own computer use: the message names that surface, not the browser too
  assert.equal(
    hiddenToolMessage('computer_click', { nativeComputer: true }),
    "computer_click is unavailable in this session: the harness's own computer use is on here; use it instead.",
  );
  assert.equal(
    hiddenToolMessage('desktop_click', { nativeComputer: true }),
    "desktop_click is unavailable in this session: the harness's own computer use is on here; use it instead.",
  );
  // a tool no rule hides names no surface (the harness may serve only one of them)
  assert.equal(hiddenToolMessage('sage_files', { nativeComputer: true }), 'sage_files is unavailable in this session.');
  assert.match(hiddenToolMessage(7 as any), /^7 is unavailable in this session/);
  // the harness's own Chrome controller by name, when the session says which it is
  assert.equal(
    hiddenToolMessage('sage_browser_click', { drivesUserChrome: true, chromeBy: 'Claude in Chrome' }),
    'sage_browser_click is unavailable in this session: Chrome is controlled by Claude in Chrome here.',
  );
});

test("hideRule carries the session's refusal; hiddenRefusalText uses it, or a sentence naming no surface", () => {
  const plain = hideRule((n: string) => n === 'a' || (n === 'b' ? 'yes' : false));
  assert.deepEqual([plain('a'), plain('b'), plain('c')], [true, false, false]);
  assert.equal('message' in plain, false);
  assert.equal(hiddenRefusalText(plain, 'a'), 'a is unavailable in this session.');
  const told = hideRule(
    () => true,
    (n: string) => `no ${n}`,
  );
  assert.equal(hiddenRefusalText(told, 'a'), 'no a');
  assert.equal(
    hiddenRefusalText(
      hideRule(() => true, 'not a function' as any),
      'a',
    ),
    'a is unavailable in this session.',
  );
  assert.equal(hiddenRefusalText(null, 'a'), 'a is unavailable in this session.');
  assert.equal(
    hiddenRefusalText(
      Object.assign(() => true, { message: () => 7 }),
      'a',
    ),
    '7',
  );
});

test("forHost: the session's rule refuses with the message for its own surfaces", () => {
  const { vis, state } = world();
  state.chrome = true;
  const claude = vis.forHost(CLAUDE_IN_CHROME_HOST);
  assert.equal(claude('sage_browser_navigate'), true);
  assert.equal(
    hiddenRefusalText(claude, 'sage_browser_navigate'),
    'sage_browser_navigate is unavailable in this session: Chrome is controlled by Claude in Chrome here.',
  );
  const codexComputer = vis.forHost({ nativeChrome: false, nativeComputer: true });
  assert.equal(codexComputer('desktop_click'), true);
  assert.doesNotMatch(hiddenRefusalText(codexComputer, 'desktop_click'), /browser|Chrome/i);
  const codexChrome = vis.forHost({ nativeChrome: true, nativeComputer: false });
  assert.doesNotMatch(hiddenRefusalText(codexChrome, 'sage_browser_navigate'), /computer/i);
  // a label only when given as a non-empty string
  assert.equal(vis.facts({ chromeBy: '' }).chromeBy, undefined);
  assert.equal(vis.facts(CLAUDE_IN_CHROME_HOST).chromeBy, 'Claude in Chrome');
});

/** A registry with one tool of each family, and the live flags a ToolVisibility reads. */
function world(o: { flags?: Record<string, boolean>; chrome?: boolean; probes?: boolean; drives?: boolean } = {}) {
  const r = new Registry();
  r.setApprover(() => true);
  const names = [
    'sage_debug_echo',
    'sage_browser_navigate',
    'computer_click',
    'browser_tabs_context',
    'browser_navigate',
    'desktop_screenshot',
    'desktop_click',
  ];
  for (const name of names) {
    if (o.probes === false && (name === IN_APP_BROWSER_PROBE || name === DESKTOP_PROBE)) continue;
    r.register({ name, policy: 'observe', handler: () => `ran ${name}` });
  }
  const flags: Record<string, boolean> = {
    'shared.browser.parityTools': true,
    'shared.computerUse.enabled': true,
    'shared.computerUse.parityTools': true,
    ...o.flags,
  };
  const state = { chrome: !!o.chrome };
  const vis = new ToolVisibility(
    o.drives === false
      ? { registry: r, isEnabled: (k: string) => !!flags[k] }
      : { registry: r, isEnabled: (k: string) => !!flags[k], drivesUserChrome: () => state.chrome },
  );
  r.setHidden(
    (name: string) => vis.hides(name),
    (name: string) => vis.message(name),
  );
  return { r, vis, flags, state };
}
const names = (list: any[]) => list.map((t) => t.name).sort();

test('ToolVisibility reads the switches, the registered probes and the browser channel at every call', () => {
  const { vis, flags, state } = world();
  assert.deepEqual(vis.facts(), {
    browserParity: true,
    browserParityOff: false,
    computerParity: true,
    drivesUserChrome: false,
    chromeRelay: false,
    nativeChrome: false,
    nativeComputer: false,
    computerUnavailable: null,
  });
  assert.deepEqual(vis.facts({ nativeChrome: true, nativeComputer: true }), {
    browserParity: true,
    browserParityOff: false,
    computerParity: true,
    drivesUserChrome: false,
    chromeRelay: false,
    nativeChrome: true,
    nativeComputer: true,
    computerUnavailable: null,
  });
  assert.equal(vis.hides('sage_browser_navigate'), true);
  assert.equal(vis.hides('computer_click'), true);
  // a remote switch turned off while sessions run: the legacy tools come back
  flags['shared.browser.parityTools'] = false;
  flags['shared.computerUse.parityTools'] = false;
  assert.equal(vis.hides('sage_browser_navigate'), false);
  assert.equal(vis.hides('computer_click'), false);
  assert.equal(vis.hides('browser_navigate'), true, 'one built-in browser controller: browser_* leave the list');
  flags['shared.computerUse.parityTools'] = true;
  flags['shared.computerUse.enabled'] = false;
  assert.equal(vis.facts().computerParity, false);
  // the user moves agents to Your Chrome
  state.chrome = true;
  assert.equal(vis.hides('sage_browser_navigate'), false);
  assert.equal(vis.hides('sage_browser_navigate', { nativeChrome: true }), true);
  assert.match(vis.message('sage_browser_navigate', { nativeChrome: true }), /controls the user's Chrome itself/);
  const claudeInChrome = vis.forHost({ nativeChrome: true });
  assert.equal(claudeInChrome('sage_browser_navigate'), true);
  state.chrome = false;
  assert.equal(claudeInChrome('sage_browser_navigate'), false);
  // without the browser_*/desktop_* probes registered, nothing is replaced
  const bare = world({ probes: false });
  assert.deepEqual(bare.vis.facts(), {
    browserParity: false,
    browserParityOff: false,
    computerParity: false,
    drivesUserChrome: false,
    chromeRelay: false,
    nativeChrome: false,
    nativeComputer: false,
    computerUnavailable: null,
  });
  // without a drivesUserChrome reader, agents use the built-in browser
  assert.equal(world({ drives: false }).vis.facts().drivesUserChrome, false);
});

/* ---------- the Registry's filter and refusal ---------- */

test("Registry: hidden tools stay registered, leave list() and are refused at call time with the rule's message", async () => {
  const { r } = world();
  assert.deepEqual(names(r.list()), ['browser_navigate', 'browser_tabs_context', 'desktop_click', 'desktop_screenshot', 'sage_debug_echo']);
  assert.equal(r.list({ all: true }).length, 7);
  assert.equal(r.has('computer_click'), true);
  assert.equal(r.isHidden('computer_click'), true);
  const refused = await r.invoke('chat', 'seg', 'sage_browser_navigate', {});
  assert.deepEqual([refused.ok, refused.error.code], [false, 'unavailable']);
  assert.match(refused.error.message, /use the browser_\* tools for the built-in browser/);
  const ran = await r.invoke('chat', 'seg', 'browser_navigate', {});
  assert.deepEqual([ran.ok, ran.content], [true, [{ type: 'text', text: 'ran browser_navigate' }]]);
  // unknown tools are still unknown, not unavailable
  assert.equal((await r.invoke('chat', 'seg', 'nope', {})).error.code, 'unknown_tool');
});

test('Registry: a missing, failing or empty message falls back; a failing rule hides nothing; null clears it', async () => {
  const r = new Registry();
  r.register({ name: 'tool_a', policy: 'observe', handler: () => 'a' });
  assert.equal(r.isHidden('tool_a'), false);
  r.setHidden(() => true);
  assert.deepEqual((await r.invoke('c', 's', 'tool_a', {})).error, { code: 'unavailable', message: 'tool_a is unavailable' });
  r.setHidden(
    () => true,
    () => {
      throw new Error('boom');
    },
  );
  assert.equal((await r.invoke('c', 's', 'tool_a', {})).error.message, 'tool_a is unavailable');
  r.setHidden(
    () => true,
    () => '',
  );
  assert.equal((await r.invoke('c', 's', 'tool_a', {})).error.message, 'tool_a is unavailable');
  r.setHidden(() => true, 'not a function' as any);
  assert.equal(r.hiddenMessage, null);
  // only a strict true hides; a throwing rule shows the tool rather than failing every list
  r.setHidden(() => 'yes' as any);
  assert.equal(r.list().length, 1);
  r.setHidden(() => {
    throw new Error('flags not loaded');
  });
  assert.equal(r.isHidden('tool_a'), false);
  assert.equal((await r.invoke('c', 's', 'tool_a', {})).ok, true);
  r.setHidden(null);
  assert.equal(r.hidden, null);
  assert.equal(r.list().length, 1);
});

/* ---------- the same rule on every harness's channel ---------- */

/** Talks to a ToolSocket as sage-mcp would (Codex threads and ACP sessions both use it). */
async function sageMcpClient(socketPath: string, token: string) {
  const sock = net.createConnection(socketPath);
  sock.setEncoding('utf8');
  const waiting = new Map<number, (m: any) => void>();
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let next = 1;
  const request = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const hello = await request('hello', { token, pid: process.pid });
  assert.ok(hello.result, 'hello accepted');
  return { request, close: () => sock.destroy() };
}

const sockets: any[] = [];
after(() => sockets.forEach((s) => s.close()));

test('cross-harness: Codex managed, Codex native, ACP and Claude (with and without Claude in Chrome) each see one tool set per job', async () => {
  const { r, vis, state } = world();
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: r, verifyPeer: async () => null });
  sockets.push(socket);
  const path = await socket.listen();
  const listOn = async (hide: any) => {
    const { token } = sessions.open(`k${Math.random()}`, { harnessPid: process.pid, chatId: 'chat', segmentId: 'seg', hide });
    const c = await sageMcpClient(path, token);
    const out = names((await c.request('tools/list')).result.tools);
    const call = async (name: string) => (await c.request('tools/call', { name, arguments: {} })).result;
    return { out, call, close: c.close };
  };
  const everyone = ['browser_navigate', 'browser_tabs_context', 'desktop_click', 'desktop_screenshot', 'sage_debug_echo'];
  // a managed Codex thread and an ACP session: the app-wide rule only
  const managed = await listOn(null);
  assert.deepEqual(managed.out, everyone);
  // the legacy tool, cached in a list from before the switch, is refused with the rule's message
  const legacy = await managed.call('computer_click');
  assert.equal(legacy.isError, true);
  assert.match(legacy.content[0].text, /use the desktop_\* tools/);
  managed.close();
  // a native Codex thread (the vendor's Browser and Computer use): no desktop_* either; browser_* stay
  const native = await listOn(vis.forHost({ nativeChrome: true, nativeComputer: true }));
  assert.deepEqual(native.out, ['browser_navigate', 'browser_tabs_context', 'sage_debug_echo']);
  assert.equal((await native.call('desktop_click')).isError, true);
  assert.equal((await native.call('browser_navigate')).isError, false);
  native.close();

  // Claude Code: the SDK's in-process servers present the same visible set
  const sdk = {
    tool: (name: string, _d: string, _s: any, handler: Function) => ({ name, handler }),
    createSdkMcpServer: ({ name, tools }: any) => ({ name, tools }),
  };
  const z = { fromJSONSchema: (s: any) => s };
  const claudeTools = (hide: any) =>
    names(
      [
        ...sdkMcpServers({
          sdk,
          z,
          registry: r,
          serverName: 'sage_aaaaaaaaaaaa',
          owner: { chatId: 'chat', segmentId: 'seg' },
          hide,
        }).values(),
      ].flatMap((s: any) => s.tools.map((t: any) => ({ name: `${s.name}/${t.name}` }))),
    );
  const plain = claudeTools(null);
  assert.equal(
    plain.some((n) => n.endsWith('sage_browser_navigate') || n.endsWith('computer_click')),
    false,
  );
  assert.equal(
    plain.some((n) => n.endsWith('/sage_debug_echo')),
    true,
  );
  // Your Chrome on: a Claude session without Claude in Chrome keeps sage_browser_*, one with it does not
  state.chrome = true;
  assert.equal(
    claudeTools(null).some((n) => n.endsWith('/sage_browser_navigate')),
    true,
  );
  assert.equal(
    claudeTools(vis.forHost({ nativeChrome: true })).some((n) => n.endsWith('/sage_browser_navigate')),
    false,
  );
  // and over sage-mcp the same holds for a managed thread vs a native one
  const yours = await listOn(null);
  assert.ok(yours.out.includes('sage_browser_navigate'));
  yours.close();
  const nativeYours = await listOn(vis.forHost({ nativeChrome: true, nativeComputer: true }));
  assert.equal(nativeYours.out.includes('sage_browser_navigate'), false);
  nativeYours.close();
});

/* ---------- turn end ---------- */

test('hostTurnEnd runs every step once per end, even when one fails, and shares a run in flight', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const end = hostTurnEnd([
    async (chat: string) => {
      seen.push(`browser:${chat}`);
      await gate;
    },
    (chat: string) => {
      seen.push(`desktop:${chat}`);
      throw new Error('lock already gone');
    },
    async (chat: string) => {
      seen.push(`overlay:${chat}`);
      throw new Error('no window');
    },
  ]);
  const first = end('chat-1');
  const again = end('chat-1');
  assert.equal(again, first);
  const other = end('chat-2');
  assert.notEqual(other, first);
  await Promise.resolve();
  release();
  assert.equal(await first, undefined);
  await other;
  assert.deepEqual(seen.sort(), [
    'browser:chat-1',
    'browser:chat-2',
    'desktop:chat-1',
    'desktop:chat-2',
    'overlay:chat-1',
    'overlay:chat-2',
  ]);
  // a later end runs the steps again
  await end('chat-1');
  assert.equal(seen.filter((s) => s === 'desktop:chat-1').length, 2);
  // no chat: nothing runs
  await end(null);
  await end(undefined);
  await end('');
  assert.equal(seen.length, 9);
});

/** A turnLedger over recording steps; `gate(chat)` holds the browser step of that chat's runs until it is opened. */
function ledger(o: { chatOf?: (id: string) => string; running?: (chatId: string) => boolean; tracked?: (chatId: string) => boolean } = {}) {
  const seen: string[] = [];
  const aborted: string[][] = [];
  const hold = new Map<string, Promise<void>>();
  const l = turnLedger({
    steps: [
      async (chat: string) => {
        seen.push(`browser:${chat}`);
        await hold.get(chat);
      },
      (chat: string) => void seen.push(`desktop:${chat}`),
    ],
    abortChat: (chat: string, why: string) => void aborted.push([chat, why]),
    chatOf: o.chatOf ?? ((id: string) => `chat-${id}`),
    running: o.running ?? (() => false),
    tracked: o.tracked ?? (() => true),
  });
  return {
    l,
    seen,
    aborted,
    gate: (chat: string) => {
      let open!: () => void;
      hold.set(chat, new Promise<void>((r) => (open = r)));
      return () => {
        hold.delete(chat);
        open();
      };
    },
  };
}

test('turnLedger: a let-go run never rejects, even when the sessions cannot be read (before they open, after they close)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { l, seen } = ledger({
      tracked: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'has')");
      },
    });
    l.begin('c1');
    // nobody awaits a patch-driven end: its run must settle without an unhandled rejection
    l.sessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
    await l.end('c1');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['browser:c1', 'desktop:c1']);
    assert.deepEqual(unhandled, []);
    // the chat is kept (it could not be read as untracked), and a later turn still lets go
    assert.equal(l.chatsHeld(), 1);
    l.begin('c1');
    await l.end('c1');
    assert.deepEqual(seen, ['browser:c1', 'desktop:c1', 'browser:c1', 'desktop:c1']);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test("turnLedger: every report of one turn's end lets go once; the next turn lets go again", async () => {
  const { l, seen, aborted } = ledger();
  // the patch and the finish hook for the same turn
  l.sessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  await l.hooks.onFinished({ chatId: 'c' });
  assert.deepEqual(seen, ['browser:c', 'desktop:c']);
  assert.deepEqual(aborted, []);
  // a turn going running begins the next one; awaitingUser too
  l.sessionPatch({ chatId: 'c', patch: { turn: 'running' } });
  l.sessionPatch({ chatId: 'c', patch: { turn: 'awaitingUser' } });
  l.sessionPatch({ chatId: 'c', patch: { turn: 'crashed' } });
  await l.end('c');
  assert.deepEqual(seen, ['browser:c', 'desktop:c', 'browser:c', 'desktop:c']);
  // patches without a turn, or without a chat id, neither begin nor end
  l.sessionPatch({ chatId: 'c', patch: { title: 'x' } });
  l.sessionPatch({ chatId: 7, patch: { turn: 'running' } });
  l.sessionPatch(null);
  await l.end('c');
  assert.equal(seen.length, 4);
  // no chat: nothing runs
  await l.end(null);
  await l.end('');
  assert.equal(seen.length, 4);
});

test('turnLedger: a crash lets go once, also after the turn already went idle (work that outlived the turn)', async () => {
  const { l, seen, aborted } = ledger();
  // a crash mid-turn: the crashed patch, then onCrash; one release
  l.sessionPatch({ chatId: 'c', patch: { turn: 'running' } });
  l.sessionPatch({ chatId: 'c', patch: { turn: 'crashed' } });
  await l.hooks.onCrash('c');
  assert.deepEqual(seen, ['browser:c', 'desktop:c']);
  assert.deepEqual(aborted, [['c', 'quit']]);
  // the next turn ends idle; a background agent's approval outlived it, and then the harness quits
  l.sessionPatch({ chatId: 'c', patch: { turn: 'running' } });
  l.sessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  await l.end('c');
  assert.equal(seen.length, 4);
  l.sessionPatch({ chatId: 'c', patch: { turn: 'crashed' } });
  await l.hooks.onCrash('c');
  assert.equal(seen.length, 6, 'the crash lets go of what the outliving work held');
  // onCrash alone (no patch) after an idle end lets go too, once
  l.sessionPatch({ chatId: 'd', patch: { turn: 'idle' } });
  await l.hooks.onCrash('d');
  await l.hooks.onCrash('d');
  assert.deepEqual(
    seen.filter((x) => x.endsWith(':d')),
    ['browser:d', 'desktop:d', 'browser:d', 'desktop:d'],
  );
});

test('turnLedger: an end chained behind a run in flight is dropped once a newer turn began', async () => {
  const { l, seen, gate } = ledger();
  const open = gate('c');
  const first = l.end('c');
  l.begin('c');
  const second = l.end('c');
  // the next turn starts before the chained release runs: it would close that turn's tabs
  l.begin('c');
  open();
  await first;
  await second;
  assert.deepEqual(seen, ['browser:c', 'desktop:c']);
  // the newer turn's own end lets go
  await l.end('c');
  assert.equal(seen.length, 4);
});

test("turnLedger: a chat the sessions don't track is forgotten once let go; a tracked one keeps its last end", async () => {
  const tracked = new Set(['t']);
  const { l, seen } = ledger({ tracked: (chatId: string) => tracked.has(chatId) });
  await l.end('u');
  await l.end('t');
  assert.equal(l.chatsHeld(), 1, 'only the tracked chat is remembered');
  // the tracked chat's late duplicate report still does nothing
  await l.end('t');
  assert.equal(seen.filter((x) => x.endsWith(':t')).length, 2);
  // a begin only, with no end: remembered until its end
  l.begin('u');
  assert.equal(l.chatsHeld(), 2);
  await l.end('u');
  assert.equal(l.chatsHeld(), 1);
});

test('turnLedger: an end reported while the last one still lets go runs after it, never beside it', async () => {
  const { l, seen, gate } = ledger();
  const open = gate('c');
  const first = l.end('c');
  l.begin('c');
  const second = l.end('c');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['browser:c', 'desktop:c'], 'the second waits for the first');
  open();
  await first;
  await second;
  assert.deepEqual(seen, ['browser:c', 'desktop:c', 'browser:c', 'desktop:c']);
  // the same turn reported again shares the last run
  assert.equal(l.end('c'), second);
  // another chat is not held by a chat still letting go
  const block = gate('c2');
  const held = l.end('c2');
  await l.end('d');
  assert.ok(seen.includes('desktop:d'));
  block();
  await held;
  // a begin with no chat is ignored
  l.begin(null);
});

test('turnLedger: Codex turn/started begins a turn the controller may not track; a turn/completed it did not end lets go once', async () => {
  let running = false;
  const { l, seen } = ledger({
    chatOf: (id: string) => {
      if (id === 'stray') throw new Error('no chat');
      return `chat-${id}`;
    },
    running: () => running,
  });
  const done = (threadId: string) => ({ method: 'turn/completed', params: { threadId } });
  l.codexMessage(done('t1'));
  l.codexMessage(done('t1'));
  await l.end('chat-t1');
  assert.deepEqual(seen, ['browser:chat-t1', 'desktop:chat-t1']);
  l.codexMessage({ method: 'turn/started', params: { threadId: 't1' } });
  // still running (an older turn's late completion): nothing ends
  running = true;
  l.codexMessage(done('t1'));
  running = false;
  l.codexMessage(done('t1'));
  await l.end('chat-t1');
  assert.equal(seen.length, 4);
  // a thread no chat owns, a turn/started without a thread, other messages: nothing
  l.codexMessage({ method: 'turn/started', params: { threadId: 'stray' } });
  l.codexMessage({ method: 'turn/started', params: {} });
  l.codexMessage({ method: 'item/started', params: { threadId: 't1' } });
  l.codexMessage(null);
  await l.end('chat-t1');
  assert.equal(seen.length, 4);
});

test("turnLedger: Stop aborts the chat's running calls as stopped and leaves the end to the harness", async () => {
  const { l, seen, aborted } = ledger();
  assert.equal(l.hooks.onInterrupt('c'), undefined);
  assert.deepEqual(aborted, [['c', 'stopped']]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, []);
});

test('codexTurnEndedChat: only a turn/completed for a chat with no turn still running lets go', () => {
  const owners: Record<string, string> = { 'th-1': 'chat-1', 'th-2': 'chat-2' };
  const busy = new Set(['chat-2']);
  const o = { chatOf: (id: string) => owners[id], running: (chat: string) => busy.has(chat) };
  const done = (threadId?: string) => ({ method: 'turn/completed', params: threadId ? { threadId, turn: { id: 't' } } : {} });
  assert.equal(codexTurnEndedChat(done('th-1'), o), 'chat-1');
  // a late completion of an older turn while a newer one runs
  assert.equal(codexTurnEndedChat(done('th-2'), o), null);
  // a thread no chat owns
  assert.equal(codexTurnEndedChat(done('th-x'), o), null);
  assert.equal(codexTurnEndedChat(done(), o), null);
  assert.equal(codexTurnEndedChat({ method: 'turn/completed' }, o), null);
  assert.equal(codexTurnEndedChat({ method: 'turn/started', params: { threadId: 'th-1' } }, o), null);
  assert.equal(codexTurnEndedChat(null, o), null);
  assert.equal(
    codexTurnEndedChat(done('th-1'), {
      chatOf: () => {
        throw new Error('controller gone');
      },
      running: () => false,
    }),
    null,
  );
});

test('patchTurnEndedChat: a session patch that sets the turn idle or crashed names its chat (the browser turn-end hook)', () => {
  assert.equal(patchTurnEndedChat({ chatId: 'c', patch: { turn: 'idle' } }), 'c');
  assert.equal(patchTurnEndedChat({ chatId: 'c', patch: { turn: 'crashed' } }), 'c');
  for (const turn of ['running', 'awaitingUser', undefined])
    assert.equal(patchTurnEndedChat({ chatId: 'c', patch: { turn } }), null, String(turn));
  assert.equal(patchTurnEndedChat({ chatId: 'c', patch: { title: 'x' } }), null);
  assert.equal(patchTurnEndedChat({ chatId: 'c' }), null);
  assert.equal(patchTurnEndedChat({ chatId: '', patch: { turn: 'idle' } }), null);
  assert.equal(patchTurnEndedChat({ chatId: 7, patch: { turn: 'idle' } }), null);
  assert.equal(patchTurnEndedChat({ patch: { turn: 'idle' } }), null);
  assert.equal(patchTurnEndedChat(null), null);
  assert.equal(patchTurnEndedChat(undefined), null);
});

/* ---------- the native Codex thread's built-in browser note ---------- */

function injection(o: { native?: boolean; visible?: () => any; hide?: any; omitVisible?: boolean } = {}) {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => o.native ?? true,
    nativeHide: o.hide ?? null,
    ...(o.omitVisible ? {} : { visibleTools: o.visible ?? (() => ['sage_debug_echo', 'browser_tabs_context', 'browser_navigate']) }),
  });
  let id = 0;
  const load = (threadId: string, method = 'thread/start') => {
    const rid = ++id;
    const sent = inj.outgoing({ id: rid, method, params: method === 'thread/resume' ? { threadId } : {} });
    inj.observe({ id: rid, result: { thread: { id: threadId } } });
    return Object.keys(sent.params.config.mcp_servers).find((n) => n.startsWith('sage_'))!;
  };
  return { inj, sessions, load };
}

test('turnContext: a native thread gets the note once per load, naming its own sage-mcp server', () => {
  const { inj, load } = injection();
  const server = load('th-1');
  const note = inj.turnContext('th-1');
  assert.equal(note.key, IN_APP_BROWSER_CONTEXT);
  assert.deepEqual(note.context, { kind: 'application', value: `${scopeNote(server)}\n\n${inAppBrowserNote(server).value}` });
  assert.equal(note.context.kind, 'application');
  assert.match(note.context.value, new RegExp(`browser_\\* tools of the ${server} MCP server`));
  // not forwarded yet (the turn/start failed): asked again
  assert.ok(inj.turnContext('th-1'));
  // forwarded under another key, or for a thread that is not native: nothing recorded
  inj.contextForwarded('th-1', 'mopilot.native-runtime-state', inj.contextReceipt('th-1'));
  assert.ok(inj.turnContext('th-1'));
  inj.contextForwarded('th-unknown', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th-unknown'));
  assert.equal(inj.noted.has('th-unknown'), false);
  inj.contextForwarded('th-1', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th-1'));
  assert.equal(inj.turnContext('th-1'), null);
});

test('turnContext: the note returns after a reload, a compaction or a restart, never after other items', () => {
  const { inj, load } = injection();
  load('th-1');
  const forward = () => inj.contextForwarded('th-1', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th-1'));
  forward();
  inj.observe({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'agentMessage' } } });
  inj.observe({ method: 'item/completed', params: { threadId: 'th-1' } });
  inj.observe({ method: 'turn/completed', params: { threadId: 'th-1' } });
  assert.equal(inj.turnContext('th-1'), null);
  inj.observe({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'contextCompaction' } } });
  assert.ok(inj.turnContext('th-1'));
  forward();
  inj.observe({ method: 'thread/compacted', params: { threadId: 'th-1' } });
  assert.ok(inj.turnContext('th-1'));
  forward();
  // closed, then resumed: a new load of the thread
  inj.observe({ method: 'thread/closed', params: { threadId: 'th-1' } });
  assert.equal(inj.turnContext('th-1'), null, 'an unloaded thread is not native');
  load('th-1', 'thread/resume');
  assert.ok(inj.turnContext('th-1'));
  forward();
  inj.exited();
  assert.equal(inj.noted.size, 0);
});

test('turnContext: no in-app browser note for managed threads, unknown ids, lost sessions, or without visible browser_* tools', () => {
  // a native thread with Chrome still gets how to select it
  const chromeOnly = { key: IN_APP_BROWSER_CONTEXT, context: { kind: 'application', value: chromeSelectionNote(null) } };
  assert.equal(injection().inj.turnContext(undefined), null);
  // a managed thread gets the shared note on what MoPilot's tools reach, not the native routing (#1319 G3)
  const managed = injection({ native: false });
  managed.load('th-m');
  assert.doesNotMatch(managed.inj.turnContext('th-m')?.context.value ?? '', /Browser routing in MoPilot/);
  // a native thread whose session ended
  const lost = injection();
  lost.load('th-1');
  lost.sessions.end(lost.inj.byThread.get('th-1'));
  assert.deepEqual(lost.inj.turnContext('th-1'), chromeOnly);
  // no browser_* in the registry's visible set, a failing or empty reader, or non-string names
  for (const visible of [
    () => ['sage_debug_echo', 'desktop_click'],
    () => {
      throw new Error('registry gone');
    },
    () => null,
    () => [7, null],
  ]) {
    const x = injection({ visible });
    x.load('th-1');
    assert.deepEqual(x.inj.turnContext('th-1'), chromeOnly);
  }
  // the default reader lists nothing
  const bare = injection({ omitVisible: true });
  bare.load('th-1');
  assert.deepEqual(bare.inj.turnContext('th-1'), chromeOnly);
  // the thread's own hide leaves browser_* out (e.g. a future rule): no note
  const hidden = injection({ hide: (n: string) => n.startsWith('browser_') });
  hidden.load('th-1');
  assert.deepEqual(hidden.inj.turnContext('th-1'), chromeOnly);
  // a hide that keeps them: the note
  const kept = injection({ hide: (n: string) => n.startsWith('desktop_') });
  kept.load('th-1');
  assert.ok(kept.inj.turnContext('th-1'));
});

/* ---------- harness/codex.cjs: the note on turn/start ---------- */

function fakeServer(failTurn: () => boolean) {
  const s: any = {
    listeners: new Set<(e: any) => void>(),
    sent: [] as any[],
    proc: {},
    start() {},
    send(m: any) {
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        let msg: any;
        if (m.method === 'thread/start' || m.method === 'thread/resume')
          msg = { id: m.id, result: { thread: { id: m.params.threadId ?? 'th-1', cwd: '/w', name: null, preview: '', ephemeral: false } } };
        else if (m.method === 'turn/start' && failTurn()) msg = { id: m.id, error: { code: -32600, message: 'busy' } };
        else if (m.method === 'turn/start') msg = { id: m.id, result: { turn: { id: 'turn-1' } } };
        else msg = { id: m.id, result: m.method === 'initialize' ? { userAgent: 'fake', codexHome: '/h' } : {} };
        for (const l of s.listeners) l({ kind: 'message', msg });
      });
    },
  };
  return s;
}

function adapter(tools: any) {
  let fail = false;
  const server = fakeServer(() => fail);
  const a = new CodexAdapter({
    server,
    state: new SessionStore(),
    nativeOf: (c: string) => ({ kind: 'codex', id: c, key: c }),
    chatOf: (id: string) => id,
    probe: null,
    tools,
  });
  const turns = () => server.sent.filter((m: any) => m.method === 'turn/start').map((m: any) => m.params.additionalContext ?? null);
  return { a, server, turns, failNext: (v: boolean) => (fail = v) };
}

test("codex adapter: a native thread's first turn/start carries the note beside the caller's context; later turns do not", async () => {
  const { inj } = injection();
  const { a, turns, failNext } = adapter(inj);
  await a.request('thread/start', {});
  // a failed turn/start leaves it to the next turn
  failNext(true);
  await assert.rejects(
    a.request('turn/start', { threadId: 'th-1', input: [], additionalContext: { mine: { kind: 'application', value: 'x' } } }),
  );
  failNext(false);
  await a.request('turn/start', { threadId: 'th-1', input: [], additionalContext: { mine: { kind: 'application', value: 'x' } } });
  await a.request('turn/start', { threadId: 'th-1', input: [] });
  const [failed, first, second] = turns();
  assert.deepEqual(Object.keys(failed), ['mine', IN_APP_BROWSER_CONTEXT]);
  assert.deepEqual(Object.keys(first), ['mine', IN_APP_BROWSER_CONTEXT]);
  assert.match(first[IN_APP_BROWSER_CONTEXT].value, /Browser routing in MoPilot/);
  assert.equal(second, null);
  // a compaction: the next turn is told again
  inj.observe({ method: 'thread/compacted', params: { threadId: 'th-1' } });
  await a.request('turn/start', { threadId: 'th-1', input: [] });
  assert.ok(turns()[3][IN_APP_BROWSER_CONTEXT]);
  // a helper turn never gets it
  inj.observe({ method: 'thread/compacted', params: { threadId: 'th-1' } });
  await a.request('turn/start', { threadId: 'th-1', input: [] }, { helper: true });
  assert.equal(turns()[4], null);
});

test('codex adapter: a managed thread carries the shared note once; tool channels without turnContext and no tools at all send turn/start unchanged', async () => {
  const managed = injection({ native: false });
  const m = adapter(managed.inj);
  await m.a.request('thread/start', {});
  await m.a.request('turn/start', { threadId: 'th-1', input: [] });
  assert.match(m.turns()[0][IN_APP_BROWSER_CONTEXT].value, /^MoPilot's computer and browser tools:/);
  // an older tool channel (no turnContext / contextForwarded)
  const legacy = { outgoing: (msg: any) => msg, observe() {}, exited() {}, setUserServers() {}, isNativeThread: () => false };
  const l = adapter(legacy);
  await l.a.request('turn/start', { threadId: 'th-1', input: [] });
  assert.deepEqual(l.turns(), [null]);
  const none = adapter(null);
  await none.a.request('turn/start', { threadId: 'th-1', input: [] });
  assert.deepEqual(none.turns(), [null]);
  // a channel with turnContext but no contextForwarded still sends the note
  const partial = { ...legacy, turnContext: () => ({ key: 'k', context: { kind: 'application', value: 'v' } }) };
  const p = adapter(partial);
  await p.a.request('turn/start', { threadId: 'th-1', input: [] });
  assert.deepEqual(p.turns(), [{ k: { kind: 'application', value: 'v' } }]);
});

test('browser parity switched off hides browser_* (still registered) and says why when one is called', () => {
  const off = { browserParityOff: true };
  assert.equal(isToolHidden('browser_navigate', off), true);
  assert.equal(isToolHidden('browser_navigate', {}), false, 'shown while the switch is on');
  assert.equal(isToolHidden('sage_browser_navigate', off), false, 'the panel tools serve the built-in browser again');
  assert.equal(
    hiddenToolMessage('browser_navigate', off),
    'browser_navigate is unavailable: Browser control is turned off for these tools. Use the sage_browser_* tools for the built-in browser.',
  );
  // with Your Chrome as the channel sage_browser_* drive Chrome, so they are not offered for the pane
  assert.equal(
    hiddenToolMessage('browser_navigate', { ...off, drivesUserChrome: true }),
    'browser_navigate is unavailable: Browser control is turned off for these tools.',
  );
});
