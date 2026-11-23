// The 3×3 control matrix: in-app browser (IAB, browser_*), computer use (CU, desktop_*) and browser use
// (BU, the user's Chrome: Your Chrome's sage_browser_*, or the harness's own Claude in Chrome / Codex
// Browser plugin) × a Claude Code chat, a Codex chat, and a chat that switches harness several times.
// Each cell checks the two things every flaky report comes down to: which tools the session is given
// (the visibility rule on that harness's channel) and which chat a call is charged to (tabs, grants,
// approval cards, Stop and turn-end cleanup are all keyed by the stable MoPilot chat id).
// The routing modules are real (Registry, ToolVisibility, the Claude SDK servers, the Codex thread
// injection and ToolSessions, SwitchRunner and ChatsStore); the harnesses and the tools' work are fakes.
// Tests marked `todo` reproduce known bugs: they run and report, but do not fail the suite until fixed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BU, CU, IAB, claudeSession, codexConnection, owners, switchingChat, world } from './support/control-matrix-kit.ts';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/', 'shared/'];

/* ====================================================================== */
/* Column 1: Claude Code                                                   */
/* ====================================================================== */

describe('Claude Code', () => {
  test('CM-K01: IAB × Claude: browser_* on mopilot_browser, charged to the chat, with or without Claude in Chrome', async () => {
    for (const nativeChrome of [false, true]) {
      const w = world();
      const s = claudeSession(w, { chatId: 'chat-A', segmentId: 's1' }, { nativeChrome });
      assert.ok(s.tools.includes(IAB), `in-app browser offered (Claude in Chrome ${nativeChrome})`);
      await s.call(IAB);
      assert.deepEqual(w.calls, [{ tool: IAB, chatId: 'chat-A', segmentId: 's1' }]);
    }
  });

  test('CM-K02: CU × Claude: desktop_* on mopilot_computer replace computer_*; Claude in Chrome never hides them', async () => {
    for (const nativeChrome of [false, true]) {
      const w = world();
      const s = claudeSession(w, { chatId: 'chat-A', segmentId: 's1' }, { nativeChrome });
      assert.ok(s.tools.includes(CU));
      assert.equal(s.tools.includes('computer_click'), false, 'one controller for the desktop');
      await s.call(CU);
      assert.deepEqual(owners(w.calls), [`${CU}@chat-A`]);
    }
  });

  test('CM-K03: BU × Claude: Your Chrome tools only without Claude in Chrome; never two controllers for Chrome', async () => {
    const w = world();
    // built-in channel: Your Chrome's tools give way to browser_*
    assert.equal(claudeSession(w, { chatId: 'c', segmentId: 's' }).tools.includes(BU), false);
    w.state.yourChrome = true;
    // API key / credits session (--no-chrome): MoPilot drives the user's Chrome
    const plain = claudeSession(w, { chatId: 'c', segmentId: 's' });
    assert.ok(plain.tools.includes(BU));
    await plain.call(BU);
    assert.deepEqual(owners(w.calls), [`${BU}@c`]);
    // claude.ai subscription with Claude in Chrome (--chrome): the CLI's own extension drives Chrome
    const native = claudeSession(w, { chatId: 'c', segmentId: 's' }, { nativeChrome: true });
    assert.equal(native.tools.includes(BU), false);
    assert.ok(native.tools.includes(IAB), 'the in-app browser stays');
  });

  test('CM-K04: BU × Claude: the user flips the browser channel while the session runs', async () => {
    const w = world();
    w.state.yourChrome = true;
    const s = claudeSession(w, { chatId: 'c', segmentId: 's' });
    assert.ok(s.tools.includes(BU));
    // back to the built-in browser: the listed tool is refused at call time, it never drives the old channel
    w.state.yourChrome = false;
    const refused = await s.call(BU);
    assert.equal(refused.isError, true);
    assert.deepEqual(w.calls, []);
    // the other way: the tool list is fixed per CLI process, so Your Chrome reaches the chat with its next process
    const built = claudeSession(w, { chatId: 'c', segmentId: 's' });
    w.state.yourChrome = true;
    assert.equal(built.tools.includes(BU), false, 'known limit: the live process keeps its list');
    assert.ok(claudeSession(w, { chatId: 'c', segmentId: 's' }).tools.includes(BU));
  });
});

/* ====================================================================== */
/* Column 2: Codex                                                         */
/* ====================================================================== */

describe('Codex', () => {
  const SURFACES = {
    managed: { chrome: false, computer: false },
    'native Chrome only': { chrome: true, computer: false },
    'native computer only': { chrome: false, computer: true },
    'fully native': { chrome: true, computer: true },
  };

  test('CM-K05: IAB × Codex: browser_* stay on every path (the plugin and browser_* share the pane)', async () => {
    for (const [label, surfaces] of Object.entries(SURFACES)) {
      const w = world();
      const cx = codexConnection(w, (id) => id, surfaces);
      const { thread } = await cx.startThread();
      const s = await cx.session(thread.id);
      assert.ok(s.tools.includes(IAB), `${label}: browser_* offered`);
      await s.call(IAB);
      assert.deepEqual(owners(w.calls), [`${IAB}@${thread.id}`], `${label}: a chat started on Codex is its first thread`);
    }
  });

  test('CM-K06: CU × Codex: desktop_* unless Codex Computer Use (Sky) serves this thread', async () => {
    for (const [label, surfaces] of Object.entries(SURFACES)) {
      const w = world();
      const cx = codexConnection(w, (id) => id, surfaces);
      const { thread } = await cx.startThread();
      const s = await cx.session(thread.id);
      assert.equal(s.tools.includes(CU), !surfaces.computer, `${label}: desktop_* ${surfaces.computer ? 'hidden' : 'offered'}`);
      assert.equal(s.tools.includes('computer_click'), false, `${label}: legacy computer_* never offered`);
      const r = await s.call(CU);
      assert.equal(!r.isError, !surfaces.computer, `${label}: a cached desktop_* call is refused on a native thread`);
    }
  });

  test("CM-K07: BU × Codex: Your Chrome's tools unless the Browser plugin serves Chrome on this thread", async () => {
    for (const [label, surfaces] of Object.entries(SURFACES)) {
      const w = world();
      w.state.yourChrome = true;
      const cx = codexConnection(w, (id) => id, surfaces);
      const { thread } = await cx.startThread();
      assert.equal(
        (await cx.session(thread.id)).tools.includes(BU),
        !surfaces.chrome,
        `${label}: sage_browser_* ${surfaces.chrome ? 'hidden' : 'offered'}`,
      );
    }
  });

  test("CM-B01: BU × Codex: Sky refusing Chrome's front tab is shown as a blocked page, also when the call completed", async () => {
    const { skyProblemOfItem } = await import('../shared/skyComputerUse.mjs');
    // seen after Claude in Chrome left a site OpenAI disables (wikiwand.com) in front, then the chat moved to Codex
    const item = {
      type: 'mcpToolCall',
      server: 'cua_repl',
      status: 'completed',
      result: {
        content: [
          {
            type: 'text',
            // as SkyComputerUseService words it (`strings`)
            text: 'This session has been stopped because Computer Use is not allowed on the current browser URL. Stop your work and send a final message noting why the session has been ended. Note that Computer Use is not allowed on this URL even if the user navigates to it themselves.',
          },
        ],
      },
    };
    const p = skyProblemOfItem(item)!;
    assert.deepEqual([p.kind, p.name, p.code], ['blockedUrl', 'blockedURL', -10015]);
    // the next step: another page in front, or the user does it
    assert.match(p.hint!, /Bring another tab or page to the front and try again/);
    // the instruction to the model stays in the tool result, not in what the user reads
    assert.doesNotMatch(p.message, /Stop your work/);
    assert.match(item.result.content[0].text, /Stop your work and send a final message/);
  });

  test('CM-K08: a loaded thread keeps its path when the Mac changes under it; the next load picks the new one', async () => {
    const w = world();
    const surfaces = { chrome: false, computer: false };
    const cx = codexConnection(w, (id) => id, surfaces);
    const { thread } = await cx.startThread();
    assert.ok((await cx.session(thread.id)).tools.includes(CU));
    // Codex Computer Use gets installed while the thread is loaded: nothing changes until it reloads
    surfaces.computer = true;
    cx.resume(thread.id);
    assert.ok((await cx.session(thread.id)).tools.includes(CU), 'still managed while loaded');
    cx.unload(thread.id);
    cx.resume(thread.id);
    assert.equal((await cx.session(thread.id)).tools.includes(CU), false, 'native after the reload');
  });
});

/* ====================================================================== */
/* Column 3: a chat that switches harness several times                    */
/* ====================================================================== */

describe('switching harness mid-chat', () => {
  test('CM-O01: Codex → Claude: the new Claude session charges IAB, CU and BU calls to the chat', async () => {
    const w = world();
    w.state.yourChrome = true;
    const sw = switchingChat(w);
    // a chat started on Codex: its id is its first thread's
    const { thread } = await sw.codex.startThread();
    const chatId = thread.id;
    await sw.switchTo(chatId, 'claude');
    const s = sw.claudeNow(chatId);
    for (const t of [IAB, CU, BU]) await s.call(t);
    assert.deepEqual(owners(w.calls), [`${IAB}@${chatId}`, `${CU}@${chatId}`, `${BU}@${chatId}`]);
  });

  test('CM-O02: Claude → Codex: the first Codex thread charges its calls to the chat, not to the new thread id', async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1');
    const seg = await sw.switchTo('chat-1', 'codex');
    const s = await sw.codex.session(seg.nativeId);
    assert.equal(s.owner.chatId, 'chat-1');
    await s.call(IAB);
    await s.call(CU);
    assert.deepEqual(owners(w.calls), [`${IAB}@chat-1`, `${CU}@chat-1`]);
  });

  test("CM-O03: Claude → Codex: approval cards for the new thread's tools go to the chat the user is looking at", async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1');
    const seg = await sw.switchTo('chat-1', 'codex');
    await (await sw.codex.session(seg.nativeId)).call(CU);
    assert.deepEqual(w.approvals, [`chat-1 ${CU}`]);
  });

  test("CM-O04: Claude → Codex: a crash or Stop on the chat aborts the new thread's running browser step", async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1');
    const seg = await sw.switchTo('chat-1', 'codex');
    w.hold(IAB);
    const running = (await sw.codex.session(seg.nativeId)).call(IAB);
    // the call crosses sage-mcp's socket: abort once the tool is actually running
    await waitFor(() => w.calls.length, 'the tool call');
    assert.deepEqual(owners(w.calls), [`${IAB}@chat-1`]);
    w.r.abortChat('chat-1');
    const out = await Promise.race([running, new Promise((r) => setTimeout(() => r('still running'), 1000))]);
    w.release(IAB);
    assert.notEqual(out, 'still running');
  });

  test('CM-O05: Claude → Codex: once Codex unloads and resumes the thread, its calls are charged to the chat again', async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1');
    const seg = await sw.switchTo('chat-1', 'codex');
    sw.codex.unload(seg.nativeId);
    sw.codex.resume(seg.nativeId);
    await (await sw.codex.session(seg.nativeId)).call(IAB);
    assert.deepEqual(owners(w.calls), [`${IAB}@chat-1`]);
  });

  test('CM-O07: Claude → Codex → Claude → Codex: every segment, including the resumed thread, charges the chat', async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1');
    const cx = await sw.switchTo('chat-1', 'codex');
    await (await sw.codex.session(cx.nativeId)).call(IAB);
    await sw.switchTo('chat-1', 'claude');
    await sw.claudeNow('chat-1').call(IAB);
    const back = await sw.switchTo('chat-1', 'codex');
    assert.equal(back.nativeId, cx.nativeId, 'returning resumes the same thread');
    // the thread was not idle long enough to unload: Codex resumes it as loaded
    sw.codex.resume(back.nativeId);
    await (await sw.codex.session(back.nativeId)).call(CU);
    assert.deepEqual(owners(w.calls), [`${IAB}@chat-1`, `${IAB}@chat-1`, `${CU}@chat-1`]);
  });

  test('CM-O12: Codex → Claude → Codex: a chat started on Codex keeps one owner across every switch', async () => {
    const w = world();
    const sw = switchingChat(w);
    const { thread } = await sw.codex.startThread();
    const chatId = thread.id;
    await (await sw.codex.session(chatId)).call(CU);
    await sw.switchTo(chatId, 'claude');
    await sw.claudeNow(chatId).call(CU);
    const back = await sw.switchTo(chatId, 'codex');
    assert.equal(back.nativeId, chatId);
    sw.codex.resume(chatId);
    await (await sw.codex.session(chatId)).call(CU);
    await sw.switchTo(chatId, 'claude');
    await sw.claudeNow(chatId).call(IAB);
    assert.deepEqual(owners(w.calls), [`${CU}@${chatId}`, `${CU}@${chatId}`, `${CU}@${chatId}`, `${IAB}@${chatId}`]);
    // the second Claude visit resumes the first Claude session, it does not start another
    assert.equal(sw.claudeKeys.length, 1);
  });

  test('CM-K09: switching changes which controller serves each surface: one per surface on every segment', async () => {
    const w = world();
    w.state.yourChrome = true;
    // this Mac runs Codex's plugin for both surfaces; the Claude session has Claude in Chrome
    const sw = switchingChat(w, { surfaces: { chrome: true, computer: true } });
    const { thread } = await sw.codex.startThread();
    const chatId = thread.id;
    const onCodex = (await sw.codex.session(chatId)).tools;
    assert.deepEqual(
      [onCodex.includes(IAB), onCodex.includes(CU), onCodex.includes(BU)],
      [true, false, false],
      'Codex: plugin for CU and BU',
    );
    await sw.switchTo(chatId, 'claude');
    const inChrome = sw.claudeNow(chatId, true).tools;
    assert.deepEqual(
      [inChrome.includes(IAB), inChrome.includes(CU), inChrome.includes(BU)],
      [true, true, false],
      'Claude in Chrome: desktop_* back',
    );
    // the same chat on an API-key Claude session (--no-chrome): Your Chrome comes back too
    const apiKey = sw.claudeNow(chatId, false).tools;
    assert.deepEqual([apiKey.includes(IAB), apiKey.includes(CU), apiKey.includes(BU)], [true, true, true]);
  });
});
