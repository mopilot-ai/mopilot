// The control matrix, group A (docs/control-plane/matrix.md): the ControllerPlan, a chat-level record of who controls
// the in-app browser (IAB), computer use (CU) and the user's Chrome (BU) on the chat's current segment. It is decided
// when a segment starts and again when that segment's own session loads, kept in the chat's meta and session state,
// and read by the credential route, "Continue in Chrome", the status strip and the switch sheet.
// The routing modules are real (Registry, ToolVisibility, the Claude SDK servers, the Codex thread injection,
// SessionMcp, ChatsStore, SwitchRunner, SessionStore, ControllerPlans); the harnesses and the tools' work are fakes.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { type World, claudeSession, codexConnection, sageMcpClient, switchingChat, world } from './support/control-matrix-kit.ts';
import { chromeLinkDropped, pickStrip } from '../src/lib/statusStrip.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { decidePlan, planChanges, changeLines, vendorChromeOf, SURFACES } = require('../shared/controllerPlan.mjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatsStore, toRendererSegment } = require('../electron/platform/chats.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');

const FLAG = {
  browserParity: 'shared.browser.parityTools',
  computer: 'shared.computerUse.enabled',
  computerParity: 'shared.computerUse.parityTools',
};
const NONE = { chrome: false, computer: false };
const names = (w: World) => w.r.list().map((t: { name: string }) => t.name);

/* ---------- an ACP session's sage-mcp, as main gives it ---------- */

const sockets: { close(): void }[] = [];
after(() => sockets.forEach((s) => s.close()));

async function acpTools(w: World) {
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: w.r, verifyPeer: async () => null });
  sockets.push(socket);
  const acp = new SessionMcp({ sessions, socket, command: '/bin/sage-mcp' });
  const { mcpServers } = await acp.prepare('acp:kimi:1', { harnessPid: 1, chatId: 'acp:kimi:1', segmentId: 'acp-seg' });
  const env = Object.fromEntries(mcpServers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
  const c = await sageMcpClient(env.SAGE_MCP_SOCKET, env.SAGE_MCP_TOKEN);
  return ((await c.request('tools/list')).result.tools.map((t: any) => t.name) as string[]).sort();
}

/* ---------- main's plan inputs over the world, with each harness's live sessions as fakes say ---------- */

type Live = {
  /** live Claude CLIs: key -> whether the process runs Claude in Chrome */
  claude: Map<string, boolean>;
  /** a new Claude CLI would run Claude in Chrome (a claude.ai subscription with the extension ready) */
  claudeChrome: boolean;
  /** what a Codex thread loaded now would get natively */
  codexNow: { chrome: boolean; computer: boolean };
  /** loaded Codex threads' paths (the real CodexToolInjection's loadedPath) */
  codexLoaded: (id: string) => { chrome: boolean; computer: boolean; iab: boolean; tools: boolean } | null;
};

function inputsFor(w: World, live: Live) {
  return planInputs({
    tools: () => names(w),
    yourChrome: () => w.state.yourChrome,
    claude: {
      channel: () => true,
      nativeChromeOf: (key: string) => live.claude.get(key) ?? null,
      nativeChromeFor: () => live.claudeChrome,
    },
    codex: {
      channel: () => true,
      loadedPath: (id: string) => live.codexLoaded(id),
      nativeSurfaces: () => live.codexNow,
      // no Browser plugin in-app browser backend here (CM-L14a covers it)
      iabAvailable: () => false,
    },
    acp: { channel: () => true },
  });
}

/** A switching chat (the kit's real ChatsStore and SwitchRunner) whose segment end and session loads decide its plan. */
function planned(w: World, o: { surfaces?: { chrome: boolean; computer: boolean }; live?: Partial<Live> } = {}) {
  const store = new SessionStore();
  let plans: any = null;
  const sc = switchingChat(w, { surfaces: o.surfaces, segmentEnded: (e) => plans.segmentEnded(e) });
  const live: Live = {
    claude: new Map(),
    claudeChrome: false,
    codexNow: o.surfaces ?? NONE,
    codexLoaded: (id) => sc.codex.inj.loadedPath(id),
    ...o.live,
  };
  const ref = (chatId: string) => {
    const seg = sc.chats.record(chatId).segments.at(-1);
    return { kind: seg.kind, id: seg.nativeId, instance: null, key: toRendererSegment(seg).nativeId };
  };
  plans = new ControllerPlans({ chats: sc.chats, sessions: store, ref, chatOf: sc.chatOf, inputs: inputsFor(w, live) });
  /** A Claude CLI starts for the chat's current Claude segment (harness/claude/sessions.cjs tells main through setProcessListener). */
  const claudeStarts = (chatId: string, runsClaudeInChrome: boolean) => {
    const key = ref(chatId).key;
    live.claude.set(key, runsClaudeInChrome);
    plans.loaded(key, chatId);
    return key;
  };
  return { ...sc, store, plans, live, ref, claudeStarts, meta: (chatId: string) => sc.chats.record(chatId).meta.controllerPlan };
}

/* ====================================================================== */
/* CM-A01: the plan names exactly the controllers each session is given    */
/* ====================================================================== */

type Harness = {
  label: string;
  family: 'claude' | 'codex' | 'acp';
  nativeChrome?: boolean;
  surfaces?: { chrome: boolean; computer: boolean };
};
const HARNESSES: Harness[] = [
  { label: 'Claude', family: 'claude', nativeChrome: false },
  { label: 'Claude with Claude in Chrome', family: 'claude', nativeChrome: true },
  { label: 'Codex managed', family: 'codex', surfaces: NONE },
  { label: 'Codex native Chrome only', family: 'codex', surfaces: { chrome: true, computer: false } },
  { label: 'Codex native computer only', family: 'codex', surfaces: { chrome: false, computer: true } },
  { label: 'Codex fully native', family: 'codex', surfaces: { chrome: true, computer: true } },
  { label: 'ACP sage-mcp', family: 'acp' },
];

/** The session's tools, what its harness serves itself, and the plan main decides for its segment. */
async function sessionAndPlan(w: World, h: Harness) {
  const live: Live = { claude: new Map(), claudeChrome: false, codexNow: NONE, codexLoaded: () => null };
  const inputs = inputsFor(w, live);
  if (h.family === 'claude') {
    live.claude.set('claude:s', !!h.nativeChrome);
    const tools = claudeSession(w, { chatId: 'c', segmentId: 's' }, { nativeChrome: !!h.nativeChrome }).tools;
    return {
      tools,
      vendor: { chrome: !!h.nativeChrome, computer: false },
      inputs: inputs({ kind: 'claude', id: 's', key: 'claude:s' }, 'c'),
    };
  }
  if (h.family === 'codex') {
    const cx = codexConnection(w, (id) => id, { ...h.surfaces! });
    const { thread } = await cx.startThread();
    live.codexLoaded = (id) => cx.inj.loadedPath(id);
    // the thread keeps the path it loaded with, whatever this Mac offers now
    live.codexNow = { chrome: !h.surfaces!.chrome, computer: !h.surfaces!.computer };
    const tools = (await cx.session(thread.id)).tools;
    return { tools, vendor: { ...h.surfaces! }, inputs: inputs({ kind: 'codex', id: thread.id, key: thread.id }, thread.id) };
  }
  return { tools: await acpTools(w), vendor: NONE, inputs: inputs({ kind: 'acp:kimi', id: '1', key: 'acp:kimi:1' }, 'acp:kimi:1') };
}

/** Who controls each surface in a session, counted from what it was really given (as CM-X01 counts). */
function given(tools: string[], vendor: { chrome: boolean; computer: boolean }, yourChrome: boolean, family: string) {
  const has = (p: string) => tools.some((t) => t.startsWith(p));
  const iab = [has('browser_'), !yourChrome && has('sage_browser_')].filter(Boolean).length;
  const cu = [has('desktop_') || has('computer_'), vendor.computer].filter(Boolean).length;
  const bu = [yourChrome && has('sage_browser_'), vendor.chrome].filter(Boolean).length;
  return {
    counts: { iab, cu, bu },
    plan: {
      iab: iab ? 'mopilot-browser' : null,
      cu: vendor.computer ? 'codex-computer-use' : cu ? 'mopilot-computer' : null,
      bu: vendor.chrome ? (family === 'claude' ? 'claude-in-chrome' : 'codex-browser-plugin') : bu ? 'your-chrome' : null,
    },
  };
}

const bools = [false, true];
const flagCombos = bools.flatMap((browserParity) =>
  bools.flatMap((computer) => bools.map((computerParity) => ({ browserParity, computer, computerParity }))),
);

describe('CM-A01: the plan names exactly the controllers each session is given', () => {
  test('CM-A01: every harness × browser channel × remote switch × computer health: one controller per surface, the one the session really gets', async () => {
    const problems: string[] = [];
    let cells = 0;
    for (const h of HARNESSES)
      for (const yourChrome of bools)
        for (const f of flagCombos)
          for (const unavailable of bools) {
            const w = world();
            w.flags[FLAG.browserParity] = f.browserParity;
            w.flags[FLAG.computer] = f.computer;
            w.flags[FLAG.computerParity] = f.computerParity;
            w.state.yourChrome = yourChrome;
            w.state.computerUnavailable = unavailable ? 'the helper is not installed' : null;
            const { tools, vendor, inputs } = await sessionAndPlan(w, h);
            const plan = decidePlan(inputs);
            const real = given(tools, vendor, yourChrome, h.family);
            const cell = `${h.label} / ${yourChrome ? 'Your Chrome' : 'built-in'} / ${JSON.stringify(f)}${unavailable ? ' / helper unavailable' : ''}`;
            cells++;
            for (const s of SURFACES)
              if (real.counts[s as 'iab'] > 1) problems.push(`${cell}: ${real.counts[s as 'iab']} controllers for ${s}`);
            if (JSON.stringify(plan) !== JSON.stringify(real.plan))
              problems.push(`${cell}: plan ${JSON.stringify(plan)}, session ${JSON.stringify(real.plan)}`);
          }
    assert.equal(cells, HARNESSES.length * 2 * 8 * 2);
    assert.deepEqual(problems, []);
  });

  test("CM-A01a: without MoPilot's tool channel, only the harness's own controllers are in the plan", () => {
    const tools = ['browser_navigate', 'desktop_click', 'sage_browser_navigate'];
    const off = { channel: false, tools, yourChrome: true };
    assert.deepEqual(decidePlan({ ...off, vendor: { chrome: null, computer: null } }), { iab: null, cu: null, bu: null });
    assert.deepEqual(decidePlan({ ...off, vendor: { chrome: 'codex-browser-plugin', computer: 'codex-computer-use' } }), {
      iab: null,
      cu: 'codex-computer-use',
      bu: 'codex-browser-plugin',
    });
    assert.deepEqual(decidePlan({ ...off, vendor: { chrome: 'claude-in-chrome', computer: null } }), {
      iab: null,
      cu: null,
      bu: 'claude-in-chrome',
    });
  });
});

/* ====================================================================== */
/* CM-A02, A03: decided at segment start, kept to the current segment      */
/* ====================================================================== */

describe('CM-A02: the plan follows the chat across switches', () => {
  test("CM-A02: Claude (Claude in Chrome) → Codex (fully native) → Claude: each segment end decides the new segment's plan, kept in meta and session state", async () => {
    const w = world();
    const p = planned(w, { surfaces: { chrome: true, computer: true } });
    p.startOnClaude('chat');
    const claudeKey = p.claudeStarts('chat', true);
    const onClaude = { key: claudeKey, iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'claude-in-chrome' };
    assert.deepEqual(p.meta('chat'), onClaude);
    assert.deepEqual(p.store.get('chat').controllerPlan, onClaude);

    const seg = await p.switchTo('chat', 'codex');
    const onCodex = { key: seg.nativeId, iab: 'mopilot-browser', cu: 'codex-computer-use', bu: 'codex-browser-plugin' };
    assert.deepEqual(p.meta('chat'), onCodex);
    assert.deepEqual(p.store.get('chat').controllerPlan, onCodex);
    assert.equal(vendorChromeOf(p.plans.current('chat')), 'the Codex Browser plugin');

    // back on Claude: the resumed CLI still runs Claude in Chrome
    await p.switchTo('chat', 'claude');
    assert.deepEqual(p.meta('chat'), onClaude);
    assert.equal(vendorChromeOf(p.plans.current('chat')), 'Claude in Chrome');
  });

  test("CM-A03: an earlier segment's session loading again never changes the plan; the current one's does", async () => {
    const w = world();
    w.state.yourChrome = true;
    const p = planned(w);
    p.startOnClaude('chat');
    const claudeKey = p.claudeStarts('chat', true);
    const seg = await p.switchTo('chat', 'codex');
    const onCodex = { key: seg.nativeId, iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'your-chrome' };
    assert.deepEqual(p.meta('chat'), onCodex);
    // the old Claude CLI (left up after the switch) starts again for a background task: still the Codex segment's plan
    p.live.claude.set(claudeKey, true);
    p.plans.loaded(claudeKey);
    assert.deepEqual(p.meta('chat'), onCodex);
    assert.equal(vendorChromeOf(p.plans.current('chat')), null, 'the credential route names no Claude in Chrome on Codex (CM-B03)');
    // the current thread loading again (its resume) decides it again from what it really got
    p.codex.unload(seg.nativeId);
    w.state.yourChrome = false;
    p.codex.resume(seg.nativeId);
    p.plans.loaded(seg.nativeId);
    assert.deepEqual(p.meta('chat'), { ...onCodex, bu: null });
  });
});

/* ====================================================================== */
/* CM-A04: a running session answers for itself                            */
/* ====================================================================== */

describe('CM-A04: what a running session got wins over what a new one would get', () => {
  test("CM-A04: a new Claude segment is planned as a new CLI would run, and its CLI's own Claude in Chrome replaces that when it starts", async () => {
    const w = world();
    w.state.yourChrome = true;
    const p = planned(w, { live: { claudeChrome: true } });
    // nothing decided for the Codex chat yet: its plan is what its segment gets now
    assert.deepEqual(p.plans.current('chat'), { key: 'chat', iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'your-chrome' });
    // the sheet's preview of a first switch to Claude Code: a new CLI's plan, against what the Codex chat gets now
    assert.deepEqual(p.plans.preview('chat', 'claude').lines, [
      "After the switch, your Chrome is controlled by Claude in Chrome instead of MoPilot's Your Chrome tools. Its tabs and site permissions there don't carry over, so it asks again.",
    ]);
    await p.switchTo('chat', 'claude');
    const key = p.ref('chat').key;
    assert.equal(p.meta('chat').bu, 'claude-in-chrome', 'a subscription with the extension ready: a new CLI runs Claude in Chrome');
    // the extension went away before the CLI started: it runs without, and Your Chrome's tools are its
    p.claudeStarts('chat', false);
    assert.deepEqual(p.meta('chat'), { key, iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'your-chrome' });
  });

  test('CM-A04a: a loaded Codex thread keeps the plan of the path it loaded with until it loads again', async () => {
    const w = world();
    const p = planned(w, { surfaces: { chrome: true, computer: false } });
    p.startOnClaude('chat');
    const seg = await p.switchTo('chat', 'codex');
    assert.equal(p.meta('chat').bu, 'codex-browser-plugin');
    // the Mac no longer offers the plugin's Chrome: the loaded thread still runs it
    p.live.codexNow = NONE;
    p.plans.decide('chat');
    assert.equal(p.meta('chat').bu, 'codex-browser-plugin');
    // unloaded: the chat's next load gets what this Mac offers now
    p.codex.unload(seg.nativeId);
    p.plans.decide('chat');
    assert.equal(p.meta('chat').bu, null);
  });

  test('CM-A04b: a thread the Codex adapter loads tells main, which reads its path: native surfaces and whether it has sage-mcp', () => {
    const loaded: string[] = [];
    const sessions = new ToolSessions();
    const make = (o: any) =>
      new CodexToolInjection({ sessions, command: '/bin/sage-mcp', socketPath: '/tmp/s.sock', harnessPid: () => 1, ...o });
    const native = make({
      hasTools: () => false,
      nativeEnabled: () => true,
      nativeSurfaces: () => ({ chrome: true, computer: false }),
      onLoaded: (id: string) => loaded.push(id),
    });
    native.outgoing({ id: 1, method: 'thread/start', params: {} });
    assert.equal(native.loadedPath('t1'), null, 'not loaded yet');
    native.observe({ id: 1, result: { thread: { id: 't1' } } });
    assert.deepEqual(loaded, ['t1']);
    assert.deepEqual(native.loadedPath('t1'), { chrome: true, computer: false, iab: false, tools: false });
    const managed = make({ hasTools: () => true });
    managed.outgoing({ id: 2, method: 'thread/start', params: {} });
    managed.observe({ id: 2, result: { thread: { id: 't2' } } });
    assert.deepEqual(managed.loadedPath('t2'), { chrome: false, computer: false, iab: false, tools: true });
  });
});

/* ====================================================================== */
/* CM-A05: the switch sheet lists the surfaces whose controller changes    */
/* ====================================================================== */

describe('CM-A05: the switch sheet', () => {
  test('CM-A05: a switch lists each surface whose controller changes, and nothing when none does', async () => {
    const w = world();
    w.state.yourChrome = true;
    const p = planned(w, { surfaces: { chrome: true, computer: true } });
    p.startOnClaude('chat');
    p.claudeStarts('chat', true);
    assert.deepEqual(p.plans.preview('chat', 'codex').lines, [
      "After the switch, the computer is controlled by Codex Computer Use instead of MoPilot's computer use.",
      "After the switch, your Chrome is controlled by the Codex Browser plugin instead of Claude in Chrome. Its tabs and site permissions there don't carry over, so it asks again.",
    ]);
    // the preview decides nothing: the chat is still on Claude Code
    assert.equal(p.meta('chat').bu, 'claude-in-chrome');
    const seg = await p.switchTo('chat', 'codex');
    // back to Claude: the earlier session's CLI is still up with Claude in Chrome
    assert.deepEqual(p.plans.preview('chat', 'claude').lines, [
      "After the switch, the computer is controlled by MoPilot's computer use instead of Codex Computer Use.",
      "After the switch, your Chrome is controlled by Claude in Chrome instead of the Codex Browser plugin. Its tabs and site permissions there don't carry over, so it asks again.",
    ]);
    // a switch to the harness the chat is on changes nothing listed
    assert.deepEqual(p.plans.preview('chat', 'codex').lines, []);
    assert.deepEqual(p.plans.preview('chat', 'future').lines, [], 'a harness this build does not know lists nothing');
    assert.equal(p.plans.preview('chat', 'codex').next.key, seg.nativeId, 'the thread it would resume');
  });

  test('CM-A05a: a surface the target leaves without a controller, or gains one on, is named', () => {
    const from = { iab: 'mopilot-browser', cu: 'codex-computer-use', bu: null };
    const to = { iab: 'mopilot-browser', cu: null, bu: 'your-chrome' };
    assert.deepEqual(changeLines(planChanges(from, to)), [
      'After the switch, nothing controls the computer (Codex Computer Use does now).',
      "After the switch, your Chrome is controlled by MoPilot's Your Chrome tools.",
    ]);
  });

  test("CM-A05b: a setting changed since the plan was decided (Your Chrome chosen) is not listed as the switch's doing", async () => {
    const w = world();
    const p = planned(w);
    p.startOnClaude('chat');
    p.claudeStarts('chat', false);
    assert.equal(p.meta('chat').bu, null, 'decided on the built-in browser channel');
    // the user picks Your Chrome mid-segment: both harnesses would drive it with Your Chrome's tools
    w.state.yourChrome = true;
    assert.deepEqual(p.plans.preview('chat', 'codex').lines, []);
  });
});

/* ====================================================================== */
/* CM-A06: the status strip reads the current segment's plan              */
/* ====================================================================== */

describe('CM-A06: the status strip', () => {
  test('CM-A06: "Claude in Chrome disconnected" shows only while the current segment\'s plan says Claude in Chrome', async () => {
    const w = world();
    w.state.yourChrome = true;
    const p = planned(w);
    p.startOnClaude('chat');
    p.claudeStarts('chat', true);
    const strip = () => pickStrip({ chromeLink: chromeLinkDropped(p.store.get('chat')) });
    p.store.patch('chat', { chromeLink: { connected: false, dropped: true } });
    assert.equal(strip(), 'chromeLink');
    // on Codex, a drop the old segment left in the chat's state is not the chat's strip
    await p.switchTo('chat', 'codex');
    p.store.patch('chat', { chromeLink: { connected: false, dropped: true } });
    assert.equal(strip(), null);
    // a CLI that runs no Claude in Chrome has no such strip either
    await p.switchTo('chat', 'claude');
    p.claudeStarts('chat', false);
    assert.equal(strip(), null);
  });
});

/* ====================================================================== */
/* CM-A07, A08, A09: no window, unreadable chats, ACP                      */
/* ====================================================================== */

describe('CM-A07: main keeps the plan with no chat window open', () => {
  test("CM-A07: the plan decided at a switch is in the chat's file and read back after a restart without deciding again", async () => {
    const w = world();
    const p = planned(w, { surfaces: { chrome: false, computer: true } });
    p.startOnClaude('chat');
    p.claudeStarts('chat', false);
    const seg = await p.switchTo('chat', 'codex');
    const kept = { key: seg.nativeId, iab: 'mopilot-browser', cu: 'codex-computer-use', bu: null };
    const again = new ChatsStore(p.chats.dir);
    assert.deepEqual(again.record('chat').meta.controllerPlan, kept);
    let asked = 0;
    const plans = new ControllerPlans({
      chats: again,
      sessions: new SessionStore(),
      ref: p.ref,
      chatOf: (k: string) => k,
      inputs: () => (asked++, {}),
    });
    assert.deepEqual(plans.current('chat'), kept);
    assert.equal(asked, 0, 'the kept plan is read, not decided again');
  });
});

describe('CM-A08: a chat whose segment cannot be read', () => {
  test('CM-A08: has no plan and no vendor for Chrome, and a session load for it changes nothing', () => {
    const store = new SessionStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-plan-'));
    const chats = new ChatsStore(path.join(dir, 'threads'));
    const plans = new ControllerPlans({
      chats,
      sessions: store,
      ref: () => {
        throw new Error('Unknown harness kind: "future"');
      },
      chatOf: (k: string) => k,
      inputs: () => {
        throw new Error('not asked');
      },
    });
    assert.equal(plans.current('x'), null);
    assert.equal(vendorChromeOf(plans.current('x')), null);
    assert.deepEqual(plans.preview('x', 'codex'), { current: null, next: null, changes: [], lines: [] });
    plans.loaded('claude:x');
    assert.equal(store.has('claude:x'), false);
    assert.equal(chats.records.size, 0, 'no chat file written');
  });
});

describe('CM-A09: ACP', () => {
  test("CM-A09: an ACP chat's plan is decided when its session starts: MoPilot's tools for every surface", () => {
    const w = world();
    w.state.yourChrome = true;
    const p = planned(w);
    const plan = { key: 'acp:kimi:1', iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'your-chrome' };
    // the window saves the new chat's record when it follows it; the session may start first
    p.plans.loaded('acp:kimi:1');
    assert.deepEqual(p.store.get('acp:kimi:1').controllerPlan, plan);
    assert.deepEqual(p.plans.current('acp:kimi:1'), plan);
    p.chats.ensure('acp:kimi:1');
    p.plans.loaded('acp:kimi:1');
    assert.deepEqual(p.meta('acp:kimi:1'), plan);
  });
});

describe('CM-A10: a temporary chat', () => {
  test('CM-A10: a temporary chat (no file of its own) gets its plan in memory and session state, never a chat file', async () => {
    const w = world();
    const p = planned(w);
    // a Claude side chat: its record lives only in memory (electron/app/ipc/sessions.cjs session:snapshot)
    p.chats.records.set('claude:side', p.chats.record('claude:side'));
    const key = p.claudeStarts('claude:side', true);
    const plan = { key, iab: 'mopilot-browser', cu: 'mopilot-computer', bu: 'claude-in-chrome' };
    assert.equal(p.chats.saved('claude:side'), false, 'no chat file written');
    assert.deepEqual(p.store.get('claude:side').controllerPlan, plan);
    assert.deepEqual(p.plans.current('claude:side'), plan);
    assert.equal(vendorChromeOf(p.plans.current('claude:side')), 'Claude in Chrome');
  });
});
