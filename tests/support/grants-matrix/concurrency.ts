// concurrency matrix suite using shared fake browser, desktop, and switching-chat fixtures.
import { waitFor } from '../waitFor.ts';
import {
  describe,
  test,
  assert,
  BU,
  flush,
  IabBackend,
  codexTurnEndedChat,
  matrix,
  ok,
  refused,
  tabChats,
  onCodex,
  onClaude,
} from './fixture.ts';

export function registerConcurrency() {
  describe('concurrency', () => {
    test("CM-C01: chat A (Claude) holds the desktop; chat B (Codex) is refused until A's turn ends, then proceeds", async () => {
      const m = matrix();
      const a = onClaude(m, 'chat-A');
      const claude = m.claudeNow(a);
      const b = await onCodex(m);
      const codex = await m.codex(b);
      await m.desktopReady(claude);
      await m.desktopReady(codex);
      ok(await claude('desktop_left_click', { coordinate: [10, 10] }));
      assert.equal(m.cu.controlling, a);
      refused(await codex('desktop_left_click', { coordinate: [10, 10] }), /Another chat is controlling this Mac/);
      assert.equal(m.helper.calls.filter((c: any) => c.method === 'click').length, 1);
      await m.turnEnded(a);
      assert.equal(m.cu.controlling, null);
      ok(await codex('desktop_left_click', { coordinate: [10, 10] }));
      assert.equal(m.cu.controlling, b);
      m.done();
    });

    test('CM-C02: a chat holding the desktop keeps the lock under its chat id across a switch, and its turn end releases it', async () => {
      for (const start of ['claude', 'codex'] as const) {
        const m = matrix();
        const chat = start === 'claude' ? onClaude(m) : await onCodex(m);
        const first = start === 'claude' ? m.claudeNow(chat) : await m.codex(chat);
        await m.desktopReady(first);
        ok(await first('desktop_left_click', { coordinate: [10, 10] }));
        assert.equal(m.cu.controlling, chat);
        const seg = await m.sw.switchTo(chat, start === 'claude' ? 'codex' : 'claude');
        const next = start === 'claude' ? await m.codex(seg.nativeId) : m.claudeNow(chat);
        // not busy against itself
        ok(await next('desktop_left_click', { coordinate: [10, 10] }));
        assert.equal(m.cu.controlling, chat, `${start} first: held by the chat, never the native id`);
        // the turn end main sees: a Codex turn/completed (by thread) or the chat going idle (by chat)
        const ended =
          start === 'claude'
            ? codexTurnEndedChat(
                { method: 'turn/completed', params: { threadId: seg.nativeId } },
                { chatOf: m.sw.chatOf, running: () => false },
              )
            : chat;
        assert.equal(ended, chat);
        await m.turnEnded(ended);
        assert.equal(m.cu.controlling, null, `${start} first: released, not orphaned`);
        m.done();
      }
    });

    test("CM-C03: the Codex plugin's iab backend and browser_* on the same tab run one action at a time", async () => {
      const m = matrix({ surfaces: { chrome: true, computer: true } });
      const chat = await onCodex(m);
      const codex = await m.codex(chat);
      ok(await codex('browser_tabs_create', { url: 'https://app.test/' }));
      const tab = m.tabs.list(chat)[0];
      const backend = new IabBackend({
        threadId: chat,
        chatOf: (id: string) => m.sw.chatOf(id),
        tabs: () => m.tabs,
        grants: () => m.grants,
      });
      let release = () => {};
      m.tabs.held.click = new Promise<void>((r) => (release = r));
      const click = codex('browser_computer', { action: 'left_click', coordinate: [1, 1], tabId: tab.id });
      await waitFor(() => m.tabs.events.some((e: string) => e.endsWith('start')), 'the click to start');
      const press = backend.handle('executeCdp', {
        session_id: chat,
        target: { tabId: backend.idOf(tab) },
        method: 'Input.dispatchMouseEvent',
        commandParams: { type: 'mousePressed', x: 2, y: 2 },
      });
      for (let i = 0; i < 20; i++) await flush();
      release();
      await Promise.all([click, press]);
      assert.deepEqual(m.tabs.events, [
        `browser_* click ${tab.id} start`,
        `browser_* click ${tab.id} end`,
        'plugin Input.dispatchMouseEvent',
      ]);
      m.done();
    });

    test("CM-C04a: two chats on Your Chrome get their own instance (tab group); Codex → Claude keeps the chat's", async () => {
      const m = matrix();
      m.w.state.yourChrome = true;
      const a = onClaude(m, 'chat-A');
      const b = await onCodex(m);
      ok(await m.claudeNow(a)(BU, { url: 'https://a.test/' }));
      ok(await (await m.codex(b))(BU, { url: 'https://b.test/' }));
      assert.deepEqual([...m.chrome.chats.keys()].sort(), [b, a].sort());
      assert.equal(m.forks.children.length, 2);
      await m.turnEnded(b);
      await m.sw.switchTo(b, 'claude');
      ok(await m.claudeNow(b)(BU, { url: 'https://b.test/next' }));
      assert.equal(m.forks.children.length, 2, "the Claude segment drives the chat's tab group");
      m.done();
    });

    test("CM-C04b: Claude → Codex keeps the chat's Your Chrome instance", async () => {
      const m = matrix();
      m.w.state.yourChrome = true;
      const chat = onClaude(m);
      ok(await m.claudeNow(chat)(BU, { url: 'https://a.test/' }));
      await m.turnEnded(chat);
      const seg = await m.sw.switchTo(chat, 'codex');
      ok(await (await m.codex(seg.nativeId))(BU, { url: 'https://a.test/next' }));
      assert.deepEqual([...m.chrome.chats.keys()], [chat]);
      assert.equal(m.forks.children.length, 1);
      m.done();
    });

    test('CM-C05a: Codex → Claude: the still-loaded Codex thread and the new Claude session call at once and land in the chat', async () => {
      const m = matrix();
      const chat = await onCodex(m);
      const old = await m.codex(chat);
      await m.desktopReady(old);
      ok(await old('browser_tabs_create', { url: 'https://both.test/' }));
      await m.sw.switchTo(chat, 'claude');
      const claude = m.claudeNow(chat);
      const out = await Promise.all([
        old('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
        claude('browser_computer', { action: 'left_click', coordinate: [2, 2] }),
        old('desktop_left_click', { coordinate: [10, 10] }),
        claude('desktop_left_click', { coordinate: [10, 10] }),
      ]);
      out.forEach(ok);
      assert.deepEqual(tabChats(m), [`${chat}:1`], "one tab, the chat's");
      assert.equal(m.cu.controlling, chat);
      m.done();
    });

    test("CM-C05b: Claude → Codex: the old Claude CLI and the new Codex thread share the chat's desktop without deadlock", async () => {
      const m = matrix();
      const chat = onClaude(m);
      const old = m.claudeNow(chat);
      await m.desktopReady(old);
      const seg = await m.sw.switchTo(chat, 'codex');
      const codex = await m.codex(seg.nativeId);
      const out = await Promise.all([
        old('desktop_left_click', { coordinate: [10, 10] }),
        codex('desktop_left_click', { coordinate: [10, 10] }),
      ]);
      out.forEach(ok);
      assert.equal(m.cu.controlling, chat);
      m.done();
    });

    test("CM-C05c: Claude → Codex: the old Claude CLI and the new Codex thread drive the chat's browser tabs", async () => {
      const m = matrix();
      const chat = onClaude(m);
      const old = m.claudeNow(chat);
      ok(await old('browser_tabs_create', { url: 'https://both.test/' }));
      const seg = await m.sw.switchTo(chat, 'codex');
      const codex = await m.codex(seg.nativeId);
      const out = await Promise.all([
        old('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
        codex('browser_computer', { action: 'left_click', coordinate: [2, 2] }),
      ]);
      out.forEach(ok);
      assert.deepEqual(tabChats(m), [`${chat}:1`]);
      m.done();
    });
  });
}
