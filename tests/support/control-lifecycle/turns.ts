// Turn-end, stop, crash and switched-segment ownership cases.
import { test, assert, CU, IAB, flush, drive, browserHost, NOTES, rig, settle, within, mainApp } from './fixture.ts';

export function registerTurns() {
  test('CM-L01a: every turn-end report (session patch, Codex turn/completed, finish hook) lets go once per turn; a later crash once more', async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    await app.send(chat);
    // all of main's reports for one turn's end: the controller's patch, the app-server's turn/completed, the
    // finish hook PeerRuntime would replace
    app.codexCompleted(chat, 'T1');
    await app.turnEnds.hooks.onFinished({ chatId: chat });
    await settle();
    assert.deepEqual(app.ends, { tabs: [chat], cu: [chat] });
    // the next turn lets go again, once
    await app.send(chat);
    app.codexCompleted(chat, 'T2');
    await settle();
    assert.deepEqual(app.ends, { tabs: [chat, chat], cu: [chat, chat] });
    // the harness quitting after the turn went idle (work that outlived it held something) lets go once more
    await app.turnEnds.hooks.onCrash(chat);
    await app.turnEnds.hooks.onCrash(chat);
    await settle();
    assert.deepEqual(app.ends, { tabs: [chat, chat, chat], cu: [chat, chat, chat] });
  });

  async function twoAgentTabs(t: any, h: any, chatId: string) {
    const first = await drive(t, h.tabs.create(chatId));
    const second = await drive(t, h.tabs.create(chatId));
    await drive(t, h.tabs.ready(first, chatId));
    h.log.select.length = 0;
    return { first, second };
  }

  async function runOut(t: any) {
    for (let i = 0; i < 80; i++) {
      await flush();
      t.mock.timers.tick(50);
    }
  }

  test('CM-L01b: a Claude Code turn end lets go of the in-app browser and the desktop once, for the chat', async (t) => {
    const h = browserHost(t, { attachMs: 1000 });
    const app = mainApp({ tabs: (chatId) => h.tabs.turnEnded(chatId) });
    const chat = app.claudeChat('chat-1');
    await app.send(chat);
    assert.equal(app.turn(chat), 'running');
    const { first, second } = await twoAgentTabs(t, h, chat);
    app.claudeResult('claude:s0');
    await runOut(t);
    assert.equal(app.turn(chat), 'idle');
    assert.deepEqual(app.ends, { tabs: [chat], cu: [chat] });
    assert.equal(app.finished.length, 1, 'the finish hook PeerRuntime installed ran');
    assert.equal(second.closed, true);
    assert.equal(first.result, true, 'the tab acted on last stays as the result');
    assert.deepEqual(h.log.select, [first.id], 'and comes forward once');
  });

  test('CM-L01c: a Codex turn/completed lets go of the in-app browser and the desktop once, for the chat', async (t) => {
    const h = browserHost(t, { attachMs: 1000 });
    const app = mainApp({ tabs: (chatId) => h.tabs.turnEnded(chatId) });
    const chat = await app.codexChat();
    await app.send(chat);
    assert.equal(app.turn(chat), 'running');
    const { first, second } = await twoAgentTabs(t, h, chat);
    app.codexCompleted(chat, 'T1');
    await runOut(t);
    assert.equal(app.turn(chat), 'idle');
    assert.equal(second.closed, true);
    assert.deepEqual([first.result, second.result], [true, false], 'the tab acted on last stays as the result');
    assert.deepEqual(h.log.select, [first.id], 'only the result comes forward');
    assert.deepEqual(app.ends, { tabs: [chat], cu: [chat] });
  });

  test('CM-L01d: a Codex turn/completed the controller did not end (no window opened the chat) still lets go, once', async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    // the app-server's own turn, on a chat no window sent to: the controller has no state for it
    app.codexCompleted(chat, 'T9');
    await settle();
    assert.deepEqual(app.ends, { tabs: [chat], cu: [chat] });
  });

  test('CM-L01e: a switched chat (Claude → Codex) ends its Codex turn under the chat id, not the thread id', async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    const seg = await app.switchTo(chat, 'codex');
    await app.send(chat);
    assert.deepEqual(app.starts, [['codex', chat, seg.nativeId]]);
    app.codexCompleted(seg.nativeId, 'T1');
    await settle();
    assert.equal(app.turn(chat), 'idle');
    assert.ok(app.ends.tabs.length > 0 && app.ends.tabs.every((id) => id === chat), `ended for ${app.ends.tabs}`);
    assert.ok(app.ends.cu.every((id) => id === chat));
  });

  test('CM-L02a: Stop on a Claude Code chat aborts its running in-app browser step', async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    await app.send(chat);
    app.w.hold(IAB);
    const running = app.sw.claudeNow(chat).call(IAB);
    await settle();
    await app.controller.stopChat(chat);
    app.claudeResult('claude:s0', true);
    await settle();
    assert.deepEqual(app.stops, [['claude', chat]]);
    assert.equal(app.turn(chat), 'idle');
    const out = await within(running);
    app.w.release(IAB);
    assert.notEqual(out, 'still running');
  });

  test('CM-L02b: Stop on a Codex chat aborts its running in-app browser step', async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    await app.send(chat);
    app.w.hold(IAB);
    const s = await app.sw.codex.session(chat);
    const running = s.call(IAB);
    await settle();
    await app.controller.stopChat(chat);
    app.codexCompleted(chat, 'T1', 'interrupted');
    await settle();
    assert.deepEqual(app.stops, [['codex', chat]]);
    assert.equal(app.turn(chat), 'idle');
    const out = await within(running);
    const left = app.w.r.running.get(chat)?.size ?? 0;
    app.w.release(IAB);
    assert.notEqual(out, 'still running');
    assert.equal(left, 0, 'nothing still runs for the chat');
  });

  test("CM-L02c: Stop on a chat switched Claude → Codex aborts the new thread's running in-app browser step", async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    const seg = await app.switchTo(chat, 'codex');
    await app.send(chat);
    app.w.hold(IAB);
    const running = (await app.sw.codex.session(seg.nativeId)).call(IAB);
    await settle();
    await app.controller.stopChat(chat);
    app.codexCompleted(seg.nativeId, 'T1', 'interrupted');
    await settle();
    assert.deepEqual(app.stops, [['codex', chat]]);
    const out = await within(running);
    app.w.release(IAB);
    assert.notEqual(out, 'still running');
  });

  for (const harness of ['claude', 'codex'] as const) {
    test(`CM-L03${harness === 'claude' ? 'a' : 'b'}: Stop on a ${harness === 'claude' ? 'Claude Code' : 'Codex'} chat releases the desktop lock and its held keys and buttons, not another chat's`, async () => {
      const r = rig();
      const app = mainApp({ cu: (chatId) => r.d.turnEnded(chatId) });
      const chat = harness === 'claude' ? app.claudeChat('chat-1') : await app.codexChat();
      await app.send(chat);
      // the chat takes the desktop and holds Shift and the mouse button
      await r.grant([NOTES], chat);
      await r.call('desktop_screenshot', {}, { chatId: chat });
      r.d.session(chat).consent = true;
      await r.call('desktop_left_click', { coordinate: [10, 10] }, { chatId: chat });
      assert.equal(r.cu.controlling, chat);
      r.d.session(chat).held.keys.add('shift');
      r.d.session(chat).held.buttons.add('left');
      // another chat holds a key of its own (a background app, say)
      r.d.session('other').held.keys.add('cmd');
      await app.controller.stopChat(chat);
      if (harness === 'claude') app.claudeResult('claude:s0', true);
      else app.codexCompleted(chat, 'T1', 'interrupted');
      await settle(20);
      assert.equal(app.turn(chat), 'idle');
      assert.equal(r.cu.controlling, null, 'the desktop lock is free');
      assert.deepEqual(
        r.callsOf('releaseInput').map((c: any) => c.args[0]),
        [{ keys: ['shift'], buttons: ['left'] }],
      );
      assert.deepEqual([...r.d.session('other').held.keys], ['cmd'], "the other chat's key is not let go");
      assert.ok(
        r.released.every((id: string) => id === chat),
        `released for ${r.released}`,
      );
      assert.ok(r.ended.length > 0 && r.ended.every((id: string) => id === chat));
    });
  }

  test('CM-L04a: the Claude Code CLI dying mid-turn aborts its running tools and lets go of the browser and desktop', async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    await app.send(chat);
    app.w.hold(IAB);
    const running = app.sw.claudeNow(chat).call(IAB);
    await settle();
    app.claudeEvent('claude:s0', { kind: 'error', error: 'exited with code 1' });
    const out: any = await within(running);
    app.w.release(IAB);
    assert.notEqual(out, 'still running');
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /harness quit/);
    assert.equal(app.turn(chat), 'crashed');
    await settle();
    assert.ok(app.ends.tabs.includes(chat) && app.ends.cu.includes(chat));
    assert.ok([...app.ends.tabs, ...app.ends.cu].every((id) => id === chat));
  });

  test("CM-L04b: the Codex app-server exiting mid-turn aborts the chat's running tools and lets go of the browser and desktop", async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    await app.send(chat);
    app.w.hold(CU);
    void (await app.sw.codex.session(chat)).call(CU);
    await settle();
    assert.equal(app.w.r.running.get(chat)?.size, 1);
    // CodexAdapter.onServer on exit: the tool sessions end, then controller.onCodexExit (codexConnection.cjs:200-238)
    app.sw.codex.inj.exited();
    app.controller.onCodexExit();
    await settle();
    app.w.release(CU);
    assert.equal(app.w.r.running.has(chat), false, 'aborted');
    assert.equal(app.turn(chat), 'crashed');
    assert.ok(app.ends.tabs.includes(chat) && app.ends.cu.includes(chat));
  });

  test('CM-L04c: a crash lets go of the browser and desktop once', async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    await app.send(chat);
    app.claudeEvent('claude:s0', { kind: 'error', error: 'exited' });
    await settle();
    assert.deepEqual(app.ends, { tabs: [chat], cu: [chat] });
  });

  test("CM-L05a: Claude → Codex: the old Claude CLI waking for a background task, finishing and exiting doesn't end the Codex turn", async () => {
    const app = mainApp();
    const chat = app.claudeChat('chat-1');
    const seg = await app.switchTo(chat, 'codex');
    await app.send(chat);
    const active = app.state.get(chat).activeTurn;
    assert.equal(app.turn(chat), 'running');
    // the old CLI wakes up for a background task, answers, finishes, and its process ends
    app.claudeEvent('claude:s0', {
      kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'task done' }] } },
    });
    app.claudeResult('claude:s0');
    app.claudeEvent('claude:s0', { kind: 'closed' });
    app.claudeEvent('claude:s0', { kind: 'error', error: 'exited' });
    await settle();
    assert.equal(app.turn(chat), 'running');
    assert.deepEqual(app.state.get(chat).activeTurn, active);
    assert.deepEqual({ ...app.ends }, { tabs: [], cu: [] }, 'nothing the Codex turn holds is let go');
    // the Codex turn's own end still lets go
    app.codexCompleted(seg.nativeId, 'T1');
    await settle();
    assert.equal(app.turn(chat), 'idle');
    assert.ok(app.ends.tabs.includes(chat));
  });

  test("CM-L05b: Codex → Claude: the old thread's late turn/completed doesn't end the Claude turn or let go of its tools", async () => {
    const app = mainApp();
    const chat = await app.codexChat();
    await app.send(chat);
    app.codexCompleted(chat, 'T1');
    await settle();
    app.ends.tabs.length = app.ends.cu.length = 0;
    await app.switchTo(chat, 'claude');
    await app.send(chat);
    assert.equal(app.starts.at(-1)?.[0], 'claude');
    app.w.hold(IAB);
    const running = app.sw.claudeNow(chat).call(IAB);
    await settle();
    // the old thread finishes a turn of its own (an automation, a goal round) after the switch
    app.observe({ method: 'turn/started', params: { threadId: chat, turn: { id: 'T7' } } });
    app.codexCompleted(chat, 'T7');
    await settle();
    assert.equal(app.turn(chat), 'running');
    assert.deepEqual(app.ends, { tabs: [], cu: [] });
    assert.equal(await within(running, 20), 'still running', "the Claude turn's browser step goes on");
    app.w.release(IAB);
    await running;
  });

  test('CM-L05c: Codex → Codex thread of another chat cannot end this chat (chatOf maps the thread, never a guess)', async () => {
    const app = mainApp();
    const a = await app.codexChat();
    const b = await app.codexChat();
    await app.send(a);
    await app.send(b);
    app.codexCompleted(b, 'T2');
    await settle();
    assert.equal(app.turn(a), 'running');
    assert.ok(!app.ends.tabs.includes(a) && !app.ends.cu.includes(a));
  });
}
