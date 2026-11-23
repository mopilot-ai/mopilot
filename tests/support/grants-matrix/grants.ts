// grants matrix suite using shared fake browser, desktop, and switching-chat fixtures.
import {
  describe,
  test,
  assert,
  BU,
  NOTES,
  IabBackend,
  pluginSiteConsent,
  chatAnchorOf,
  ACT,
  matrix,
  ok,
  refused,
  asksFor,
  tabChats,
  onCodex,
  onClaude,
} from './fixture.ts';

export function registerGrants() {
  describe('grants and approvals', () => {
    test('CM-G01a: a site allowed in this chat on Codex is honored on the later Claude segment (grants keyed by chat)', async () => {
      const m = matrix();
      const chat = await onCodex(m);
      ok(await (await m.codex(chat))('browser_tabs_create', { url: 'https://shop.test/' }));
      assert.deepEqual(asksFor(m), [`${chat} https://shop.test`]);
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://shop.test/cart' }));
      ok(await claude('browser_computer', { action: 'left_click', coordinate: [5, 5] }));
      assert.deepEqual(asksFor(m), [`${chat} https://shop.test`], 'no second card on the Claude segment');
      assert.deepEqual(tabChats(m), [`${chat}:2`], "both segments' tabs are the chat's");
      // another chat has no such grant
      ok(await m.claude({ chatId: 'other', segmentId: 'o1' })('browser_tabs_create', { url: 'https://shop.test/' }));
      assert.equal(m.siteAsks.length, 2);
      m.done();
    });

    test('CM-G01b: a site allowed in this chat on Claude is honored on the later Codex segment', async () => {
      const m = matrix();
      const chat = onClaude(m);
      ok(await m.claudeNow(chat)('browser_tabs_create', { url: 'https://shop.test/' }));
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      const codex = await m.codex(seg.nativeId);
      ok(await codex('browser_tabs_create', { url: 'https://shop.test/cart' }));
      assert.deepEqual(asksFor(m), [`${chat} https://shop.test`], 'no second card on the Codex segment');
      assert.deepEqual(tabChats(m), [`${chat}:2`]);
      m.done();
    });

    test("CM-G02a: Codex Browser plugin consent becomes the chat's grant and is honored by browser_* on a later Claude segment", async () => {
      const m = matrix({ surfaces: { chrome: true, computer: true } });
      // as main wires it (electron/app/agentTools.cjs): a subagent's card is about its parent's chat
      const consent = pluginSiteConsent({
        grants: () => m.grants,
        chatOf: (id: string) => m.sw.chatOf(m.sw.codex.inj.chatThreadOf(id) ?? id),
        // the thread's plugin works in the in-app browser (it has an iab backend)
        inApp: () => true,
      });
      const chat = onClaude(m);
      const seg = await m.sw.switchTo(chat, 'codex');
      const card = (id: number, origin: string) =>
        consent.observe({
          id,
          method: 'mcpServer/elicitation/request',
          params: { threadId: seg.nativeId, _meta: { connector_id: 'browser-use', tool_name: 'access_browser_origin', origin } },
        });
      card(1, 'https://news.test');
      assert.equal(consent.answered(1, { action: 'accept' }), true);
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://news.test/today' }));
      ok(await claude('browser_computer', { action: 'left_click', coordinate: [1, 1] }));
      assert.deepEqual(m.siteAsks, [], "the plugin's answer covered the Claude segment");
      assert.equal(m.grants.get('https://news.test'), null, 'a plain accept stays in the chat');
      ok(await m.claude({ chatId: 'chat-2', segmentId: 's9' })('browser_tabs_create', { url: 'https://news.test/' }));
      assert.deepEqual(asksFor(m), ['chat-2 https://news.test'], 'and only in that chat');
      m.done();
    });

    test('CM-G02b: plugin consent with persist "always" is permanent; a high-risk site or a local server stays chat-only', async () => {
      const m = matrix({ surfaces: { chrome: true, computer: true } });
      const consent = pluginSiteConsent({
        grants: () => m.grants,
        chatOf: (id: string) => m.sw.chatOf(m.sw.codex.inj.chatThreadOf(id) ?? id),
        // the thread's plugin works in the in-app browser (it has an iab backend)
        inApp: () => true,
      });
      const chat = await onCodex(m);
      const always = { action: 'accept', _meta: { persist: 'always' } };
      ['https://docs.test', 'https://www.chase.com', 'http://127.0.0.1:3000'].forEach((origin, i) => {
        consent.observe({
          id: i + 1,
          method: 'mcpServer/elicitation/request',
          params: { threadId: chat, _meta: { connector_id: 'browser-use', tool_name: 'access_browser_origin', origin } },
        });
        assert.equal(consent.answered(i + 1, always), true);
      });
      assert.deepEqual(m.grants.list(), [{ origin: 'https://docs.test', level: 'write' }]);
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      for (const url of ['https://docs.test/', 'https://www.chase.com/', 'http://127.0.0.1:3000/'])
        ok(await claude('browser_tabs_create', { url }));
      assert.deepEqual(m.siteAsks, [], 'all three are allowed in the chat, on its Claude segment');
      const other = m.claude({ chatId: 'chat-2', segmentId: 's9' });
      for (const url of ['https://docs.test/', 'https://www.chase.com/', 'http://127.0.0.1:3000/'])
        ok(await other('browser_tabs_create', { url }));
      assert.deepEqual(
        asksFor(m),
        ['chat-2 https://www.chase.com', 'chat-2 http://127.0.0.1:3000'],
        'another chat: only "always" carries over',
      );
      m.done();
    });

    test('CM-G03a: "always" site and app grants are global across chats and harnesses', async () => {
      const m = matrix({ computerParity: false });
      m.st.siteAnswer = { decision: 'allow', scope: 'always', level: 'write' };
      m.cuAnswers.computerAccess = { decision: 'allow', scope: 'always', level: 'click' };
      const a = onClaude(m, 'chat-A');
      const claude = m.claudeNow(a);
      ok(await claude('browser_tabs_create', { url: 'https://docs.test/' }));
      ok(await claude('computer_click', { x: 1, y: 1 }));
      await m.turnEnded(a);
      const b = await onCodex(m);
      const codex = await m.codex(b);
      ok(await codex('browser_tabs_create', { url: 'https://docs.test/b' }));
      ok(await codex('computer_click', { x: 1, y: 1 }));
      assert.equal(m.siteAsks.length, 1, 'one site card for every chat');
      assert.deepEqual(
        m.cuAsks.map((q) => `${q.chatId} ${q.kind}`),
        ['chat-A computerAccess'],
        'one app card for every chat',
      );
      m.done();
    });

    test("CM-G03b: one-time site answers and the plugin's once pass don't leak into the next turn or the next segment", async () => {
      const m = matrix();
      m.st.siteAnswer = { decision: 'allow', scope: 'once', level: 'write' };
      const chat = await onCodex(m);
      const codex = await m.codex(chat);
      ok(await codex('browser_tabs_create', { url: 'https://once.test/' }));
      ok(await codex('browser_tabs_create', { url: 'https://once.test/again' }));
      assert.equal(m.siteAsks.length, 2, 'once covers that call only');
      // a pass recorded for the chat and not used before its turn ends
      assert.equal(m.grants.consented(chat, 'https://pass.test', 'once'), true);
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://once.test/' }));
      ok(await claude('browser_tabs_create', { url: 'https://pass.test/' }));
      assert.deepEqual(asksFor(m).slice(2), [`${chat} https://once.test`, `${chat} https://pass.test`], 'the Claude segment asks again');
      m.done();
    });

    test('CM-G04a: computer-use app grants "in this chat" survive a harness switch, both directions', async () => {
      for (const start of ['claude', 'codex'] as const) {
        const m = matrix({ computerParity: false });
        const chat = start === 'claude' ? onClaude(m) : await onCodex(m);
        const first = start === 'claude' ? m.claudeNow(chat) : await m.codex(chat);
        ok(await first('computer_click', { x: 1, y: 1 }));
        await m.turnEnded(chat);
        const seg = await m.sw.switchTo(chat, start === 'claude' ? 'codex' : 'claude');
        const next = start === 'claude' ? await m.codex(seg.nativeId) : m.claudeNow(chat);
        ok(await next('computer_click', { x: 1, y: 1 }));
        assert.deepEqual(
          m.cuAsks.map((q) => `${q.chatId} ${q.kind}`),
          [`${chat} computerAccess`],
          `${start} first: the other segment uses the chat's grant`,
        );
        assert.deepEqual(
          m.store.chat(chat).map((g: any) => g.bundleId),
          [NOTES.bundleId],
        );
        m.done();
      }
    });

    test('CM-G04b: computer-use "allow once" covers its call only, so it ends with the turn and never reaches the next segment', async () => {
      const m = matrix({ computerParity: false });
      m.cuAnswers.computerAccess = { decision: 'allow', scope: 'once', level: 'click' };
      const chat = onClaude(m);
      const claude = m.claudeNow(chat);
      ok(await claude('computer_click', { x: 1, y: 1 }));
      ok(await claude('computer_click', { x: 1, y: 1 }));
      assert.equal(m.cuAsks.length, 2);
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      ok(await (await m.codex(seg.nativeId))('computer_click', { x: 1, y: 1 }));
      assert.equal(m.cuAsks.length, 3, 'asked again on the Codex segment');
      assert.deepEqual(m.store.chat(chat), [], 'nothing stored for the chat');
      assert.deepEqual(m.store.global(), []);
      m.done();
    });

    test("CM-G04c: desktop_* access is the chat's across a switch; Always allow on its card reaches other chats on any harness", async () => {
      const m = matrix();
      const chat = onClaude(m);
      await m.desktopReady(m.claudeNow(chat));
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      ok(await (await m.codex(seg.nativeId))('desktop_screenshot', {}));
      assert.deepEqual(
        m.cuAsks.map((q) => q.kind),
        ['computerAccessSet'],
        'the Codex segment needs no new card',
      );
      // Always allow on another chat's card: a third chat on Codex gets Notes without a card
      m.cuAnswers.computerAccessSet = { decision: 'allow', remember: true };
      await m.desktopReady(m.claude({ chatId: 'chat-2', segmentId: 's2' }));
      await m.desktopReady(await m.codex(await onCodex(m)));
      assert.deepEqual(
        m.cuAsks.map((q) => `${q.chatId} ${q.kind}`),
        [`${chat} computerAccessSet`, 'chat-2 computerAccessSet'],
      );
      m.done();
    });

    test("CM-G05a: the browser permission anchor follows the chat's current segment and live mode after each switch", async () => {
      const m = matrix();
      const seen: string[] = [];
      const ref = m.ref;
      const controller = { ref: (id: string) => (seen.push(`${id}:${ref(id).kind}`), ref(id)) };
      const anchor = (chatId: string) =>
        chatAnchorOf(chatId, {
          sessions: { get: (id: string) => ({ permission: m.perms.get(id) ?? null }) },
          controller,
          prefs: () => ({ permission: 'default' }),
        });
      const chat = onClaude(m);
      m.perms.set(chat, 'bypassPermissions');
      assert.equal(anchor(chat), 'full');
      await m.sw.switchTo(chat, 'codex');
      m.perms.set(chat, 'read-only');
      assert.equal(anchor(chat), 'readOnly');
      await m.sw.switchTo(chat, 'claude');
      m.perms.set(chat, 'default');
      assert.equal(anchor(chat), 'ask');
      assert.deepEqual(seen, [`${chat}:claude`, `${chat}:codex`, `${chat}:claude`]);
      m.done();
    });

    test('CM-G05b: Codex → Claude: browser_* run under the anchor of the segment that calls', async () => {
      const m = matrix();
      const chat = await onCodex(m);
      m.perms.set(chat, 'full-access');
      ok(await (await m.codex(chat))('browser_tabs_create', { url: 'https://full.test/' }));
      assert.deepEqual(m.siteAsks, [], 'Full access on Codex: no card');
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      m.perms.set(chat, 'plan');
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://full.test/' }));
      refused(await claude('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /read only for this chat/);
      m.done();
    });

    test('CM-G05c: Claude → Codex: browser_* run under the anchor of the segment that calls', async () => {
      const m = matrix();
      const chat = onClaude(m);
      m.perms.set(chat, 'bypassPermissions');
      ok(await m.claudeNow(chat)('browser_tabs_create', { url: 'https://full.test/' }));
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      m.perms.set(chat, 'read-only');
      const codex = await m.codex(seg.nativeId);
      ok(await codex('browser_tabs_create', { url: 'https://full.test/' }));
      refused(await codex('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /read only for this chat/);
      m.done();
    });

    test('CM-G06a: on Claude and on Codex, site, approval and app cards reach the chat the user sees', async () => {
      for (const start of ['claude', 'codex'] as const) {
        const m = matrix();
        const chat = start === 'claude' ? onClaude(m) : await onCodex(m);
        const call = start === 'claude' ? m.claudeNow(chat) : await m.codex(chat);
        ok(await call('browser_tabs_create', { url: 'https://card.test/' }));
        ok(await call(ACT, {}));
        await m.desktopReady(call);
        assert.deepEqual(asksFor(m), [`${chat} https://card.test`], `${start}: site card`);
        assert.deepEqual(m.w.approvals, [`${chat} ${ACT}`], `${start}: approval`);
        assert.deepEqual(
          m.cuAsks.map((q) => q.chatId),
          [chat],
          `${start}: computer-use card`,
        );
        m.done();
      }
    });

    test("CM-G06b: the Codex Browser plugin's iab backend asks in the chat, on a thread a Claude → Codex switch started", async () => {
      const m = matrix({ surfaces: { chrome: true, computer: true } });
      const chat = onClaude(m);
      const seg = await m.sw.switchTo(chat, 'codex');
      const backend = new IabBackend({
        threadId: seg.nativeId,
        chatOf: (id: string) => m.sw.chatOf(id),
        tabs: () => m.tabs,
        grants: () => m.grants,
      });
      await backend.gateUrl('https://www.chase.com/', 'read');
      assert.deepEqual(asksFor(m), [`${chat} https://www.chase.com`]);
      // its tabs are the chat's, shown in the chat's pane
      await m.tabs.create(chat);
      assert.equal((await backend.handle('getTabs', { session_id: seg.nativeId })).length, 1);
      // an action on a high-risk page confirms in the chat too
      const tab = m.tabs.list(chat)[0];
      tab.url = 'https://www.chase.com/';
      await backend.handle('executeCdp', {
        session_id: seg.nativeId,
        target: { tabId: backend.idOf(tab) },
        method: 'Input.dispatchMouseEvent',
        commandParams: { type: 'mousePressed', x: 1, y: 1 },
      });
      assert.deepEqual(
        m.confirms.map((q) => q.chatId),
        [chat],
      );
      m.done();
    });

    test("CM-G06c: Claude → Codex: the new thread's computer-use cards reach the chat (resolved at call time)", async () => {
      const m = matrix();
      const chat = onClaude(m);
      const seg = await m.sw.switchTo(chat, 'codex');
      await m.desktopReady(await m.codex(seg.nativeId));
      ok(await (await m.codex(seg.nativeId))('desktop_left_click', { coordinate: [10, 10] }));
      assert.deepEqual(
        m.cuAsks.map((q) => `${q.chatId} ${q.kind}`),
        [`${chat} computerAccessSet`, `${chat} computerTakeover`],
      );
      m.done();
    });

    test("CM-G06d: Claude → Codex: the new thread's site cards and tool approvals reach the chat", async () => {
      const m = matrix();
      const chat = onClaude(m);
      const seg = await m.sw.switchTo(chat, 'codex');
      const codex = await m.codex(seg.nativeId);
      ok(await codex('browser_tabs_create', { url: 'https://card.test/' }));
      ok(await codex(ACT, {}));
      assert.deepEqual(asksFor(m), [`${chat} https://card.test`]);
      assert.deepEqual(m.w.approvals, [`${chat} ${ACT}`]);
      m.done();
    });

    test('CM-G07a: Codex → Claude: a site lowered to read only refuses writes for the rest of the turn, per chat; the Claude segment keeps the rule', async () => {
      const m = matrix();
      const chat = await onCodex(m);
      m.siteAnswers.push({ decision: 'allow', scope: 'chat', level: 'read' });
      const codex = await m.codex(chat);
      ok(await codex('browser_tabs_create', { url: 'https://wiki.test/' }));
      refused(await codex('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /read only/);
      refused(await codex('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /read only/);
      assert.equal(m.siteAsks.length, 1, 'no second card in the turn');
      // another chat on the same site has its own answer
      const other = m.claude({ chatId: 'chat-2', segmentId: 's2' });
      ok(await other('browser_tabs_create', { url: 'https://wiki.test/' }));
      ok(await other('browser_computer', { action: 'left_click', coordinate: [1, 1] }));
      await m.turnEnded(chat);
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://wiki.test/page' }));
      assert.equal(m.siteAsks.length, 2, 'reading needs no card on the Claude segment');
      m.siteAnswers.push({ decision: 'deny' });
      refused(await claude('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /did not allow/);
      assert.deepEqual(
        asksFor(m),
        [`${chat} https://wiki.test`, 'chat-2 https://wiki.test', `${chat} https://wiki.test`],
        'a write asks again',
      );
      m.done();
    });

    test('CM-G07b: Claude → Codex: the read-only answer given on Claude is the rule on the Codex segment', async () => {
      const m = matrix();
      const chat = onClaude(m);
      m.siteAnswers.push({ decision: 'allow', scope: 'chat', level: 'read' });
      const claude = m.claudeNow(chat);
      ok(await claude('browser_tabs_create', { url: 'https://wiki.test/' }));
      refused(await claude('browser_computer', { action: 'left_click', coordinate: [1, 1] }), /read only/);
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      const codex = await m.codex(seg.nativeId);
      ok(await codex('browser_tabs_create', { url: 'https://wiki.test/page' }));
      assert.equal(m.siteAsks.length, 1, 'reading needs no card on the Codex segment');
      m.done();
    });

    test("CM-G08: Claude in Chrome's own site approvals are not MoPilot grants: a Your Chrome segment after it asks again", async () => {
      const m = matrix();
      m.w.state.yourChrome = true;
      const chat = await onCodex(m);
      await m.sw.switchTo(chat, 'claude');
      // a claude.ai subscription session: Claude in Chrome drives Chrome and approves sites in its own extension
      const inChrome = m.claudeNow(chat, { nativeChrome: true });
      assert.equal(inChrome.has(BU), false, 'no Your Chrome tools beside Claude in Chrome');
      assert.deepEqual([m.grants.list(), m.grants.chatGrants.get(chat) ?? null], [[], null], 'nothing MoPilot could honor later');
      await m.turnEnded(chat);
      const back = await m.sw.switchTo(chat, 'codex');
      m.sw.codex.resume(back.nativeId);
      const codex = await m.codex(back.nativeId);
      assert.ok(codex.has(BU));
      ok(await codex(BU, { url: 'https://mail.test/' }));
      assert.deepEqual(asksFor(m), [`${chat} https://mail.test`], 'documented: asked again on the Your Chrome segment');
      m.done();
    });
  });
}
