// Electron IPC control-routing unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { calls, ready } from './fixture';

export function registerControlRoutingCases() {
  test("Claude in Chrome's links: a change patches the chat and tells every window; the settings calls reach harness/claude/index.cjs", async () => {
    const h = await ready();
    const w = h.windows[0];
    const [[listen]] = calls(h.claude.setChromeLinkListener);
    const sessions = h.one('SessionStore');
    const ctl = h.one('ChatController');
    let ref: any = { kind: 'claude', id: 's1', key: 'claude:s1' };
    ctl.ref = () => ref;
    const link = { connected: true, browser: 'Chrome' };
    listen('c1', link, 'claude:s1');
    assert.deepEqual(calls(sessions.patch).at(-1), ['c1', { chromeLink: link }]);
    const patched = sessions.patch.mock.callCount();
    listen(null, null, 'claude:s1');
    assert.equal(sessions.patch.mock.callCount(), patched, 'no chat: nothing to patch');
    // a CLI of an earlier segment (the chat moved to Codex) no longer reaches the chat (CM-B02)
    ref = { kind: 'codex', id: 't1', key: 't1' };
    listen('c1', { connected: false, dropped: true }, 'claude:s1');
    assert.equal(sessions.patch.mock.callCount(), patched, "the old segment's reading is not the chat's");
    assert.equal(w.webContents.on_('claude:chromeLinksChanged').length, 3);
    // a switch's segment end hands the chat the new segment's link: none on Codex, the live CLI's on Claude
    const sw = h.one('SwitchRunner').opts;
    sw.segmentEnded({ chatId: 'c1', from: { kind: 'claude', key: 'claude:s1' }, to: ref });
    assert.deepEqual(calls(sessions.patch).at(-1), ['c1', { chromeLink: null }]);
    h.claude.chromeLinkOf.mock.mockImplementation((key: string) => ({ connected: true, key }));
    sw.segmentEnded({ chatId: 'c1', from: ref, to: { kind: 'claude', key: 'claude:s1' } });
    assert.deepEqual(calls(sessions.patch).at(-1), ['c1', { chromeLink: { connected: true, key: 'claude:s1' } }]);

    h.claude.chromeLinks.mock.mockImplementation(async (refresh: boolean) => [{ refresh }]);
    assert.deepEqual(await h.invoke('claude:chromeLinks', true), [{ refresh: true }]);
    assert.deepEqual(await h.invoke('claude:chromeLinks', 'yes'), [{ refresh: false }]);
    await h.invoke('claude:chromeReconnect', 'c1');
    await h.invoke('claude:chromeReconnect', '');
    await h.invoke('claude:chromeReconnect', 7);
    assert.deepEqual(calls(h.claude.chromeReconnect), [['c1'], [null], [null]]);
    await h.invoke('claude:chromeBrowsers');
    assert.equal(h.claude.chromeBrowsers.mock.callCount(), 1);
    await h.invoke('claude:chromeSelect', 3);
    assert.deepEqual(calls(h.claude.chromeSelect), [['3']]);
  });

  test("the controller plan: main's live services decide it, segment ends and every harness's session start reach it, the switch sheet asks it", async () => {
    // sage-mcp is there: ACP sessions get MoPilot's tools
    const h = await ready({ before: (h: any) => fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '') });
    const plans = h.one('ControllerPlans');
    const o = plans.opts;
    assert.equal(o.chats, h.one('ChatsStore'));
    assert.equal(o.sessions, h.one('SessionStore'));
    const ctl = h.one('ChatController');
    ctl.ref = (id: string) => ({ kind: 'claude', key: `claude:${id}` });
    ctl.chatOf = (key: string) => `chat-of-${key}`;
    assert.deepEqual(o.ref('c1'), { kind: 'claude', key: 'claude:c1' });
    assert.equal(o.chatOf('k'), 'chat-of-k');
    const [[inputs]] = calls(h.mod('session/controllerPlan.cjs').planInputs);
    assert.deepEqual(o.inputs, { planInputs: inputs });
    // what sessions are shown, the browser channel and each harness family's channel and vendor controllers
    h.one('Registry').list = () => [{ name: 'browser_navigate' }, { name: 'desktop_click' }];
    assert.deepEqual(inputs.tools(), ['browser_navigate', 'desktop_click']);
    h.one('BrowserControl').drivesUserChrome = () => true;
    assert.equal(inputs.yourChrome(), true);
    assert.equal(inputs.claude.channel(), true);
    h.claude.nativeChromeOf.mock.mockImplementation((key: string) => key === 'claude:s1');
    assert.equal(inputs.claude.nativeChromeOf('claude:s1'), true);
    h.one('ClaudeAdapter').accountOf = (chatId: string) => `account-of-${chatId}`;
    h.claude.nativeChromeFor.mock.mockImplementation((account: string) => account === 'account-of-c1');
    assert.equal(inputs.claude.nativeChromeFor('c1'), true);
    const cx = h.one('CodexToolInjection');
    cx.hasTools = () => true;
    cx.loadedPath = (id: string) => (id === 't1' ? { chrome: true, computer: false, tools: true } : undefined);
    assert.equal(inputs.codex.channel(), true);
    assert.deepEqual(inputs.codex.loadedPath('t1'), { chrome: true, computer: false, tools: true });
    assert.equal(inputs.codex.loadedPath('t2'), null);
    // a chat not loaded yet: the surfaces a native thread would load with now, without the plugin's Chrome while
    // MoPilot serves it (#1319 G28)
    cx.routedSurfaces = () => ({ surfaces: { chrome: false, computer: true }, cua: {} });
    assert.deepEqual(inputs.codex.nativeSurfaces(), { chrome: false, computer: true });
    // whether a native thread loaded now gets the Browser plugin's in-app browser backend (CM-L14a)
    cx.iabAvailable = () => true;
    assert.equal(inputs.codex.iabAvailable(), true);
    cx.iabAvailable = () => undefined;
    assert.equal(inputs.codex.iabAvailable(), false);
    assert.equal(inputs.acp.channel(), true);
    h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation((k: string) => k !== 'channel.acp.sessionMcp');
    assert.equal(inputs.acp.channel(), false, 'channel.acp.sessionMcp off');
    // a Claude CLI starting, a Codex thread loading and an ACP chat starting each decide its chat's plan again
    const [[processStarted]] = calls(h.claude.setProcessListener);
    processStarted('c1', 'claude:s1');
    h.one('CodexToolInjection').opts.onLoaded('t1');
    await h.invoke('session:acpNew', 'acp:kimi:1', {});
    assert.deepEqual(calls(plans.loaded), [['claude:s1', 'c1'], ['t1'], ['acp:kimi:1']]);
    // a switch's segment end decides the new segment's plan, after the Claude in Chrome link
    h.one('SwitchRunner').opts.segmentEnded({ chatId: 'c1', from: { kind: 'codex', key: 't1' }, to: { kind: 'claude', key: 'claude:c1' } });
    assert.deepEqual(calls(plans.segmentEnded), [
      [{ chatId: 'c1', from: { kind: 'codex', key: 't1' }, to: { kind: 'claude', key: 'claude:c1' } }],
    ]);
    // the switch sheet's lines
    plans.preview = mock.fn((chatId: string, harness: string) => ({ lines: [`${chatId}→${harness}`] }));
    assert.deepEqual(await h.invoke('session:controllerChanges', 7, 'codex'), ['7→codex']);
  });

  test('Codex Browser Use settings: the file under CODEX_HOME, the policy read only from a running Codex, and the IPC', async () => {
    const h = await ready();
    const bu = h.one('CodexBrowserUse');
    const env = h.mod('platform/env.cjs');
    assert.equal(bu.opts.home(), path.join(h.home, '.codex'));
    env.childEnv.mock.mockImplementation(() => ({ CODEX_HOME: '/codex-home' }));
    assert.equal(bu.opts.home(), '/codex-home');

    const codex = h.one('CodexAdapter');
    codex.init = null;
    assert.deepEqual(await bu.opts.policy(), { requirementsKnown: false });
    codex.init = Promise.resolve({});
    codex.request = mock.fn(async (m: string) => (m === 'configRequirements/read' ? { requirements: { r: 1 } } : { config: { c: 2 } }));
    assert.deepEqual(await bu.opts.policy(), { requirements: { r: 1 }, config: { c: 2 } });
    assert.deepEqual(calls(codex.request), [
      ['configRequirements/read', {}],
      ['config/read', { includeLayers: false }],
    ]);
    codex.request = mock.fn(async () => null);
    assert.deepEqual(await bu.opts.policy(), { requirements: null, config: null });
    codex.request = mock.fn(() => new Promise(() => {}));
    const slow = bu.opts.policy();
    mock.timers.tick(5000);
    await assert.rejects(slow, /Timed out/);

    // every answer goes through the blocks, so Settings shows each block the browser tools apply (#1319 G13)
    h.one('CodexSiteBlocks').shown = (v: any) => (typeof v === 'object' ? { ...v, shown: true } : `${v}+shown`);
    bu.state = mock.fn(async () => ({ file: 'browser/config.toml' }));
    assert.deepEqual(await h.invoke('browserUse:state'), { value: { file: 'browser/config.toml', shown: true } });
    bu.setPreference = mock.fn(async () => 'pref');
    assert.deepEqual(await h.invoke('browserUse:setPreference', 7, true), { value: 'pref+shown' });
    assert.deepEqual(calls(bu.setPreference), [['7', true]]);
    bu.setRule = mock.fn(async () => {
      throw Object.assign(new Error('fixed by policy'), { code: 'locked' });
    });
    assert.deepEqual(await h.invoke('browserUse:setRule', 'browse', 'https://a.com', 'allow'), {
      error: { message: 'fixed by policy', code: 'locked' },
    });
    await h.invoke('browserUse:setRule', 'browse', 'https://a.com');
    assert.deepEqual(calls(bu.setRule), [
      ['browse', 'https://a.com', 'allow'],
      ['browse', 'https://a.com', null],
    ]);
    bu.forget = mock.fn(async () => ({ forgot: true }));
    assert.deepEqual(await h.invoke('browserUse:forget', 'https://a.com'), { value: { forgot: true, shown: true } });
    assert.deepEqual(calls(bu.forget), [['https://a.com']]);
  });
}
