// ownership matrix suite using shared fake browser, desktop, and switching-chat fixtures.
import {
  describe,
  test,
  assert,
  fakeBin,
  fakes,
  lastQuery,
  load,
  ToolSessions,
  IabBackend,
  pluginSiteConsent,
  ChatController,
  ACT,
  matrix,
  type Caller,
  ok,
  refused,
  asksFor,
  tabChats,
  onCodex,
  onClaude,
} from './fixture.ts';

export function registerOwnership() {
  describe('ownership', () => {
    test('CM-O06: after a Codex app-server exit and restart, the resumed thread of a switched chat is owned by the chat', async () => {
      const m = matrix();
      const a = onClaude(m);
      const segA = await m.sw.switchTo(a, 'codex');
      const b = await onCodex(m);
      await m.sw.switchTo(b, 'claude');
      const segB = await m.sw.switchTo(b, 'codex');
      m.sw.codex.inj.exited();
      m.sw.codex.resume(segA.nativeId);
      m.sw.codex.resume(segB.nativeId);
      const ca = await m.codex(segA.nativeId);
      const cb = await m.codex(segB.nativeId);
      assert.deepEqual([ca.owner.chatId, cb.owner.chatId], [a, b]);
      ok(await ca('browser_tabs_create', { url: 'https://r.test/' }));
      ok(await cb(ACT, {}));
      assert.deepEqual(tabChats(m), [`${a}:1`]);
      assert.deepEqual(m.w.approvals, [`${b} ${ACT}`]);
      m.done();
    });

    test("CM-O08: a Codex subagent thread of a switched chat: its approvals, plugin consent, iab backend and computer use resolve to the parent's chat", async () => {
      // the Browser plugin serves Chrome natively; MoPilot's desktop_* stay (no Codex Computer Use here)
      const m = matrix({ surfaces: { chrome: true, computer: false } });
      const chat = onClaude(m);
      const seg = await m.sw.switchTo(chat, 'codex');
      const parent = seg.nativeId;
      const child = `${parent}-sub`;
      // Codex names the subagent's parent (thread/started)
      m.sw.codex.inj.observe({ method: 'thread/started', params: { thread: { id: child, parentThreadId: parent } } });
      assert.equal(m.sw.codex.inj.chatThreadOf(child), parent);
      // the controller reads the injection's sub-agent map (one map, codexParents.cjs)
      const controller = { parents: m.sw.codex.inj.parents, chats: m.sw.chats, chatOf: (k: string) => m.sw.chatOf(k) };
      assert.equal(ChatController.prototype.requestChat.call(controller, child), chat, 'approval cards: requestChat');
      assert.equal(m.cu.chatOf(child), child, 'computerUse resolves with chatOf, which never follows a subagent link');
      // plugin site consent from the subagent's card
      const consent = pluginSiteConsent({
        grants: () => m.grants,
        chatOf: (id: string) => m.sw.chatOf(m.sw.codex.inj.chatThreadOf(id) ?? id),
        // the thread's plugin works in the in-app browser (it has an iab backend)
        inApp: () => true,
      });
      consent.observe({
        id: 9,
        method: 'mcpServer/elicitation/request',
        params: { threadId: child, _meta: { connector_id: 'browser-use', tool_name: 'access_browser_origin', origin: 'https://sub.test' } },
      });
      assert.equal(consent.answered(9, { action: 'accept' }), true);
      assert.equal(m.grants.peek('https://sub.test/', 'write', { chatId: chat, segmentId: parent }), 'ok');
      // the subagent's own iab backend works in its parent's chat
      const backend = new IabBackend({
        threadId: child,
        parent,
        chatOf: (id: string) => m.sw.chatOf(id),
        tabs: () => m.tabs,
        grants: () => m.grants,
      });
      assert.deepEqual(backend.ctx, { chatId: chat, segmentId: parent });
      // its sage-mcp calls arrive on the parent thread's session (Codex hands the subagent its parent's MCP config):
      // computer use resolves that owner to the chat at call time
      const codex = await m.codex(parent);
      await m.desktopReady(codex);
      assert.deepEqual(
        m.cuAsks.map((q) => q.chatId),
        [chat],
      );
      m.done();
    });

    test("CM-O09: a Claude side chat (forkFrom) has its own chat id: its tabs and grants don't mix with the parent's", async () => {
      const m = matrix();
      const t = load();
      t.claude.setTools({ registry: m.w.r, sessions: new ToolSessions(), enabled: () => true });
      const bin = fakeBin('matrix/claude');
      fakes.onQuery = (q: any) => (q.reply = null);
      await t.claude.send(
        'claude:parent',
        { bin, sessionId: 'parent', chatId: 'chat-1', ephemeral: true },
        { role: 'user', content: 'hi' },
      );
      const parent = lastQuery();
      await t.claude.send('claude:side', { bin, forkFrom: 'parent', sessionId: 'side', chatId: 'side-1' }, { role: 'user', content: 'hi' });
      const side = lastQuery();
      assert.equal(side.options.forkSession, true);
      const call = (q: any) => async (short: string, args: any) =>
        q.options.mcpServers.mopilot_browser.tools.find((x: any) => x.name === short).handler(args, { _meta: {} });
      ok(await call(parent)('tabs_create', { url: 'https://p.test/' }));
      ok(await call(side)('tabs_create', { url: 'https://p.test/' }));
      ok(await call(side)('tabs_create', { url: 'https://s.test/' }));
      assert.deepEqual(tabChats(m), ['chat-1:1', 'side-1:2']);
      assert.deepEqual(
        asksFor(m),
        ['chat-1 https://p.test', 'side-1 https://p.test', 'side-1 https://s.test'],
        "the parent's grant is not the side chat's",
      );
      t.claude.closeAll();
      m.done();
    });

    test('CM-O10: two chats at once (Claude+Claude, Codex+Codex, Claude+Codex): calls, tabs and grants stay isolated', async () => {
      for (const pair of [
        ['claude', 'claude'],
        ['codex', 'codex'],
        ['claude', 'codex'],
      ] as const) {
        const m = matrix();
        const chats: string[] = [];
        const calls: Caller[] = [];
        for (const [i, kind] of pair.entries()) {
          const id = kind === 'claude' ? onClaude(m, `chat-${i}`) : await onCodex(m);
          chats.push(id);
          calls.push(kind === 'claude' ? m.claudeNow(id) : await m.codex(id));
        }
        const label = pair.join('+');
        (await Promise.all(calls.map((c) => c('browser_tabs_create', { url: 'https://same.test/' })))).forEach(ok);
        (await Promise.all(calls.map((c) => c(ACT, {})))).forEach(ok);
        assert.deepEqual(asksFor(m).sort(), chats.map((c) => `${c} https://same.test`).sort(), `${label}: one card per chat`);
        assert.deepEqual(tabChats(m).sort(), chats.map((c) => `${c}:1`).sort(), `${label}: one tab per chat`);
        assert.deepEqual(m.w.approvals.sort(), chats.map((c) => `${c} ${ACT}`).sort(), `${label}: approvals per chat`);
        // a denial in one chat stays there
        m.siteAnswers.push({ decision: 'deny' });
        refused(await calls[0]('browser_tabs_create', { url: 'https://no.test/' }), /did not allow/);
        ok(await calls[1]('browser_tabs_create', { url: 'https://no.test/' }));
        m.done();
      }
    });

    test('CM-O11a: a Claude process restart mid-chat (reaped, closed for an account or billing change) keeps the owner chat id', async () => {
      const m = matrix();
      const t = load();
      t.claude.setTools({ registry: m.w.r, sessions: new ToolSessions(), enabled: () => true });
      const bin = fakeBin('matrix/claude-restart');
      fakes.onQuery = (q: any) => (q.reply = null);
      const key = 'claude:switched';
      const act = async () => {
        const q = lastQuery();
        return q.options.mcpServers[Object.keys(q.options.mcpServers).find((n) => n.startsWith('sage_'))!].tools
          .find((x: any) => x.name === ACT)
          .handler({}, { _meta: {} });
      };
      // a chat started on Codex (cx-1) that switched to Claude: its key is not its chat id
      await t.claude.send(key, { bin, sessionId: 'switched', chatId: 'cx-1' }, { role: 'user', content: 'one' });
      const first = lastQuery();
      ok(await act());
      // the reaper (or an account switch) ends the process; the next message starts a new one
      await t.call('claude:control', key, 'close');
      await t.claude.send(key, { bin, sessionId: 'switched', resume: true, chatId: 'cx-1' }, { role: 'user', content: 'two' });
      assert.notEqual(lastQuery(), first);
      ok(await act());
      assert.deepEqual(
        m.w.calls.map((c) => c.chatId),
        ['cx-1', 'cx-1'],
      );
      t.claude.closeAll();
      m.done();
    });

    test('CM-O11b: a Claude process started by an edit-message rewind and then reused keeps the owner chat id', async () => {
      const m = matrix();
      const t = load();
      t.claude.setTools({ registry: m.w.r, sessions: new ToolSessions(), enabled: () => true });
      // main's controller.chatOf (electron/app/agentTools.cjs): the switched chat's Claude segment
      t.claude.setChatOf((k: string) => (k === 'claude:edited' ? 'cx-1' : k));
      const bin = fakeBin('matrix/claude-rewind');
      fakes.onQuery = (q: any) => (q.reply = null);
      const key = 'claude:edited';
      // the chat's CLI was reaped; the user edits a message and the dry run finds nothing to rewind
      const r = await t.call('claude:rewind', key, { bin, sessionId: 'edited', resume: true }, 'm1', true);
      assert.equal(r.canRewind, false);
      const dry = lastQuery();
      await t.claude.send(key, { bin, sessionId: 'edited', chatId: 'cx-1' }, { role: 'user', content: 'next' });
      assert.equal(lastQuery(), dry, 'the process the rewind started is reused');
      const sage = Object.keys(dry.options.mcpServers).find((n) => n.startsWith('sage_'))!;
      ok(await dry.options.mcpServers[sage].tools.find((x: any) => x.name === ACT).handler({}, { _meta: {} }));
      assert.deepEqual(
        m.w.calls.map((c) => c.chatId),
        ['cx-1'],
      );
      t.claude.closeAll();
      m.done();
    });
  });
}
