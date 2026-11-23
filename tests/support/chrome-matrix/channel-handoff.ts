// channel handoff browser control matrix cases using shared fake surfaces.
import { test, assert, claudeSession, switchingChat, until, tick, channelWorld, YC, instances } from './fixture.ts';

export function registerChannelHandoff() {
  /* ====================================================================== */
  /* Browser use: Your Chrome and "Continue in Chrome"                       */
  /* ====================================================================== */

  test("CM-B04a: Continue in Chrome switches the channel for every chat: another chat's Codex thread lists and runs Your Chrome next, charged to that chat", async () => {
    const cw = await channelWorld();
    const sw = switchingChat(cw.w);
    const { thread } = await sw.codex.startThread();
    assert.equal((await sw.codex.session(thread.id)).tools.includes(YC), false, 'built-in browser: no Your Chrome tools');
    // the user hands chat A's in-app page over to Chrome: it reopens on its page, without the OAuth code in its address
    const r = await cw.handoff('chat-A');
    assert.deepEqual(r, { ok: true, url: 'https://task.test/work', route: 'your-chrome', preferredChanged: true });
    assert.equal(cw.prefs().channel, 'chrome');
    assert.equal(cw.control.active, 'chrome');
    // another chat's Codex thread: sage-mcp lists per request, so its next call goes to Your Chrome, in its own instance
    const s = await sw.codex.session(thread.id);
    assert.ok(s.tools.includes(YC));
    const out = await s.call(YC);
    assert.notEqual(out.isError, true);
    assert.deepEqual(instances(cw.pw), ['chat-A', thread.id].sort());
    cw.pw.channel.stopAll();
  });

  test("CM-B04b: a Claude session's listed Your Chrome tool runs after the handoff and is refused at call time once the user switches back", async () => {
    const cw = await channelWorld();
    const before = claudeSession(cw.w, { chatId: 'chat-C', segmentId: 'sC' });
    assert.equal(before.tools.includes(YC), false);
    assert.equal((await cw.handoff('chat-A')).ok, true);
    // known limit: a live CLI keeps the tool list it started with; its next process gets Your Chrome
    assert.equal(before.tools.includes(YC), false);
    const d = claudeSession(cw.w, { chatId: 'chat-D', segmentId: 'sD' });
    assert.ok(d.tools.includes(YC));
    assert.notEqual((await d.call(YC)).isError, true);
    assert.deepEqual(instances(cw.pw), ['chat-A', 'chat-D']);
    const dChild = () => cw.pw.children.find((c: any) => c.calls.includes('browser_snapshot'));
    const calls = dChild().calls.length;
    // the user picks the built-in browser in Settings: the listed tool is refused, Chrome is not driven
    await cw.settings('builtin');
    const refused = await d.call(YC);
    assert.equal(refused.isError, true);
    assert.equal(dChild().calls.length, calls);
    assert.deepEqual(instances(cw.pw), [], 'leaving Your Chrome stops every instance');
  });

  test("CM-B04c: a handoff still connecting keeps the user's newer channel choice; Cancel leaves the channel and stops only the instance it started", async () => {
    // the user picks the built-in browser while Chrome is still opening the site
    {
      const cw = await channelWorld();
      let open!: () => void;
      cw.pw.gates['tools/call'] = new Promise<void>((r) => (open = r));
      const pending = cw.handoff('chat-A');
      await tick();
      await cw.settings('builtin');
      open();
      // leaving Your Chrome stops the instance the handoff was waiting on, so it fails either way
      assert.equal((await pending).ok, false);
      assert.deepEqual([cw.prefs().channel, cw.control.active, cw.control.drivesUserChrome()], ['builtin', 'builtin', false]);
      cw.pw.channel.stopAll();
    }
    // ... or while Your Chrome's tool list loads for the switch
    {
      const cw = await channelWorld();
      let open!: () => void;
      cw.pw.gates['tools/list'] = new Promise<void>((r) => (open = r));
      const pending = cw.handoff('chat-A');
      await until('the switch to load Your Chrome', () => cw.control.seq === 2);
      await cw.settings('builtin');
      open();
      assert.equal((await pending).ok, false);
      assert.deepEqual([cw.prefs().channel, cw.control.active, cw.control.drivesUserChrome()], ['builtin', 'builtin', false]);
      cw.pw.channel.stopAll();
    }
    // Cancel while Chrome is still opening the site: the channel stays, the instance the handoff started stops
    {
      const cw = await channelWorld();
      cw.pw.gates['tools/call'] = new Promise<void>(() => {});
      const pending = cw.handoff('chat-A');
      await until('the instance', () => cw.pw.channel.has('chat-A'));
      assert.equal(cw.cancel('chat-A'), true);
      assert.deepEqual(await pending, { ok: false, cancelled: true, message: 'Cancelled.' });
      assert.equal(cw.pw.channel.has('chat-A'), false);
      assert.deepEqual([cw.prefs().channel, cw.control.active], ['builtin', 'builtin']);
    }
  });

  test('CM-B05a: a chat started on Codex keeps one Your Chrome instance across a switch to Claude Code and back', async () => {
    const cw = await channelWorld();
    await cw.settings('chrome');
    const sw = switchingChat(cw.w);
    const { thread } = await sw.codex.startThread();
    const chatId = thread.id;
    await (await sw.codex.session(chatId)).call(YC);
    await sw.switchTo(chatId, 'claude');
    assert.notEqual((await sw.claudeNow(chatId).call(YC)).isError, true);
    await sw.switchTo(chatId, 'codex');
    sw.codex.resume(chatId);
    await (await sw.codex.session(chatId)).call(YC);
    assert.deepEqual(instances(cw.pw), [chatId], 'one tab group for the chat');
    cw.pw.channel.stopAll();
  });

  test("CM-B05b: Claude → Codex: the new Codex thread reaches the chat's Your Chrome instance, not a second one", async () => {
    const cw = await channelWorld();
    await cw.settings('chrome');
    const sw = switchingChat(cw.w);
    sw.startOnClaude('chat-b05');
    await sw.claudeNow('chat-b05').call(YC);
    assert.deepEqual(instances(cw.pw), ['chat-b05']);
    const seg = await sw.switchTo('chat-b05', 'codex');
    try {
      await (await sw.codex.session(seg.nativeId)).call(YC);
      assert.deepEqual(instances(cw.pw), ['chat-b05'], 'the same tab group, not one for the thread id');
    } finally {
      cw.pw.channel.stopAll();
    }
  });
}
