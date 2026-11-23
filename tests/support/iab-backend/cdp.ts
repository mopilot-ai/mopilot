// In-app browser backend cdp unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBeforePage, S, tick, fakeTab, withTab } from './fixture';

export function registerCdpCases() {
  test('executeCdp: passes to the tab (or a child session), bounded by its timeout; emulated Target reads; refused methods', async () => {
    const { b, call, tab, host } = await withTab({ cdpMs: 50 });
    const cmd = (method: string, commandParams?: any, extra: any = {}) =>
      call('executeCdp', { target: { tabId: 1, ...(extra.target || {}) }, method, commandParams, ...extra.top });
    assert.deepEqual(await cmd('DOM.getDocument', { depth: 1 }), { ok: 'DOM.getDocument' });
    assert.deepEqual(tab.sends.at(-1), ['DOM.getDocument', { depth: 1 }, '']);
    await cmd('Runtime.evaluate', undefined, { target: { sessionId: 'c9' } });
    assert.deepEqual(tab.sends.at(-1), ['Runtime.evaluate', {}, 'c9']);
    tab.wc.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'c1', targetInfo: { targetId: 'f1' } }, '');
    await cmd('Runtime.evaluate', {}, { target: { targetId: 'f1' } });
    assert.deepEqual(tab.sends.at(-1), ['Runtime.evaluate', {}, 'c1']);
    await cmd('Runtime.evaluate', {}, { target: { targetId: 'mopilot-iab-tab:1' } });
    assert.deepEqual(tab.sends.at(-1), ['Runtime.evaluate', {}, '']);
    await assert.rejects(cmd('Runtime.evaluate', {}, { target: { targetId: 'f2' } }), /No debugger session is attached for target f2/);
    await assert.rejects(cmd('Target.createTarget'), /not supported/);
    await assert.rejects(call('executeCdp', { method: 'DOM.x' }), /Unknown tab: undefined/);
    // timeouts: the command's own (capped), else the default
    tab.reply['Page.slowCmd'] = () => new Promise(() => {});
    await assert.rejects(cmd('Page.slowCmd', {}, { top: { timeoutMs: 10 } }), /Timed out running CDP command "Page.slowCmd" for tab 1/);
    await assert.rejects(cmd('Page.slowCmd', {}, { top: { timeoutMs: -1 } }), /Timed out/);
    // a domain the classification doesn't name is refused
    await assert.rejects(cmd('Slow.cmd'), /not supported/);
    // emulated Target methods
    host.tabs.push(fakeTab('tab_2'));
    const info = await cmd('Target.getTargetInfo', {});
    assert.deepEqual(info.targetInfo, {
      targetId: 'mopilot-iab-tab:1',
      id: 'mopilot-iab-tab:1',
      tabId: 1,
      type: 'page',
      title: 'Example',
      url: 'https://example.com/',
      attached: true,
      canAccessOpener: false,
    });
    assert.equal(
      (await cmd('Target.getTargetInfo', { targetId: 'mopilot-iab-tab:1' }, { target: { targetId: 'mopilot-iab-tab:1' } })).targetInfo
        .tabId,
      1,
    );
    await assert.rejects(cmd('Target.getTargetInfo', {}, { target: { sessionId: 's' } }), /can only read the current tab/);
    await assert.rejects(cmd('Target.getTargetInfo', {}, { target: { targetId: 'x' } }), /can only read the current tab/);
    await assert.rejects(cmd('Target.getTargetInfo', { targetId: 'x' }), /can only read the current tab/);
    const targets = await cmd('Target.getTargets');
    assert.deepEqual(
      targets.targetInfos.map((t: any) => [t.targetId, t.type, t.tabId]),
      [
        ['mopilot-iab-tab:1', 'page', 1],
        ['mopilot-iab-tab:2', 'page', 2],
        ['f1', 'iframe', 1],
      ],
    );
    // a tab nobody attached lists no frames
    const t2 = await b.handle('executeCdp', { session_id: S, target: { tabId: 2 }, method: 'Target.getTargets' });
    assert.equal(t2.targetInfos.length, 2);
    await assert.rejects(cmd('Target.closeTarget', { targetId: 'x' }), /can only close the current tab/);
    assert.deepEqual(await cmd('Target.closeTarget', { targetId: 'mopilot-iab-tab:1' }), { success: true });
    assert.deepEqual(host.calls.at(-1), ['close', `chat:${S}`, 'tab_1']);
    assert.equal(b.held.has(tab), false);
  });

  test("a held tab learns of the frames its page's debugger attached before, with their sites; MoPilot's Page domain and early scripts stay on", async () => {
    const { b, call, tab, grants } = await withTab();
    const dbg = tab.wc.debugger;
    dbg.sendCommand = (m: string) => Promise.resolve(m === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '1' } : {});
    // the passkey watch's early script holds the debugger from the page's start (documentScripts.cjs)
    runBeforePage(tab.wc, 'S');
    dbg.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 'F1',
      targetInfo: { type: 'iframe', targetId: 'f1', url: 'https://frame.test/' },
    });
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'F2', targetInfo: { type: 'iframe', targetId: 'f2' } });
    await tick();
    await call('attach', { tabId: 1 });
    const h = b.held.get(tab);
    assert.deepEqual(
      [...h.children],
      [
        ['F1', 'f1'],
        ['F2', 'f2'],
      ],
    );
    assert.deepEqual([...h.urls], [['F1', 'https://frame.test/']]);
    // a command for the frame reaches its session, gated on the frame's own site too
    const cmd = (method: string, commandParams: any = {}, target: any = {}) =>
      call('executeCdp', { target: { tabId: 1, ...target }, method, commandParams });
    await cmd('Runtime.evaluate', {}, { targetId: 'f1' });
    assert.deepEqual(tab.sends.at(-1), ['Runtime.evaluate', {}, 'F1']);
    assert.ok(grants.calls.some((c: any[]) => c[0] === 'peek' && c[1] === 'https://frame.test/'));
    // switching off the Page domain or taking the early script away is answered here and never sent
    const sent = tab.sends.length;
    assert.deepEqual(await cmd('Page.disable'), {});
    assert.deepEqual(await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }), {});
    assert.equal(tab.sends.length, sent);
    // the plugin's own scripts are its to remove
    await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: '7' });
    assert.deepEqual(tab.sends.at(-1), ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '7' }, '']);
  });
}
