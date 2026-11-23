// Site-permission contract unit cases for backend-policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IabBackend, IabBackends, Registry, inAppBrowserNote, S, CHAT, flush, iabTab, fs } from './fixture.ts';

export function registerBackendPolicy() {
  test('CM-P05: after a redirect to a refused or blocked site, the plugin can no longer read the page', async () => {
    const k = await iabTab();
    assert.deepEqual(await k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' }), {});
    // the page moved to a site the user denied in this chat
    k.g.denied.set(CHAT, new Set(['https://evil.test']));
    k.tab.url = 'https://evil.test/landing';
    for (const method of ['Runtime.evaluate', 'Page.captureScreenshot', 'DOMSnapshot.captureSnapshot'])
      await assert.rejects(
        k.cdp(k.tab, method),
        (e: any) => e.code === 'denied' && /<refusal reason="site_permission_denied"[^>]* browser="iab">/.test(e.message),
      );
    // a blocked risk class
    k.tab.url = 'http://169.254.169.254/latest/meta-data';
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate'), (e: any) => e.code === 'blocked');
    // a command for a child frame is about the frame's own page
    k.tab.url = 'https://shop.test/';
    await k.cdp(k.tab, 'Runtime.evaluate');
    const h = k.b.held.get(k.tab);
    k.tab.wc.debugger.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 's1',
      targetInfo: { targetId: 'f1', url: 'https://evil.test/frame' },
    });
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate', {}, { sessionId: 's1' }), (e: any) => e.code === 'denied');
    // a target id on a tab nothing holds yet names no frame
    await k.call('createTab');
    await assert.rejects(
      k.cdp(k.host.tabs[1], 'Runtime.evaluate', {}, { targetId: 'f9' }),
      /No debugger session is attached for target f9/,
    );
    // named by its target id, too
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate', {}, { targetId: 'f1' }), (e: any) => e.code === 'denied');
    // a write queued behind a browser_* action: the frame is checked again when its turn comes
    k.tab.wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'https://shop.test/frame' } }, 's1');
    let release = () => {};
    const held = k.host.run(k.tab, () => new Promise<void>((r) => (release = r)));
    const typing = k.cdp(k.tab, 'Input.insertText', { text: 'a' }, { sessionId: 's1' });
    await flush();
    k.tab.wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'https://evil.test/again' } }, 's1');
    release();
    await held;
    await assert.rejects(typing, (e: any) => e.code === 'denied');
    k.tab.wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'https://shop.test/ok' } }, 's1');
    assert.equal(h.urls.get('s1'), 'https://shop.test/ok');
    await k.cdp(k.tab, 'Runtime.evaluate', {}, { sessionId: 's1' });
    k.tab.wc.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 's1' });
    assert.equal(h.urls.has('s1'), false);
    // attach checks the page too
    k.tab.url = 'https://evil.test/';
    await assert.rejects(k.call('attach', { tabId: k.b.idOf(k.tab) }), (e: any) => e.code === 'denied');
  });

  test('CM-P06: accessibility actions and file uploads go through the write checks', async () => {
    const k = await iabTab();
    // a read-only site: an accessibility action with a user gesture is a write, and refused
    k.g.lowered.set(CHAT, new Map([['https://shop.test', 'turn']]));
    await assert.rejects(
      k.cdp(k.tab, 'Runtime.callFunctionOn', { functionDeclaration: 'function(){this.value="x"}', userGesture: true }),
      (e: any) => e.code === 'read_only',
    );
    // without the gesture it is a read
    await k.cdp(k.tab, 'Runtime.callFunctionOn', { functionDeclaration: 'function(){return this.value}' });
    k.g.lowered.delete(CHAT);
    // into a focused password field: refused
    k.host.focus = { secret: true };
    await assert.rejects(k.cdp(k.tab, 'Runtime.callFunctionOn', { userGesture: true }), (e: any) => e.code === 'password_field');
    k.host.focus = null;
    await k.cdp(k.tab, 'Runtime.callFunctionOn', { userGesture: true });
    // the focus moved to a password field while the action waited for its turn
    let release = () => {};
    const held = k.host.run(k.tab, () => new Promise<void>((r) => (release = r)));
    const action = k.cdp(k.tab, 'Runtime.callFunctionOn', { userGesture: true });
    await flush();
    k.host.focus = { secret: true };
    release();
    await held;
    await assert.rejects(action, (e: any) => e.code === 'password_field');
    k.host.focus = null;
    // a file upload asks the user, naming the files
    await k.cdp(k.tab, 'DOM.setFileInputFiles', { files: ['/tmp/x/report.pdf'], nodeId: 3 });
    assert.equal(k.confirmed.at(-1).sensitive.verb, 'upload files');
    assert.match(k.confirmed.at(-1).summary, /report\.pdf/);
    // declined: refused, and nothing reaches the page
    const no = await iabTab({ confirm: false });
    await assert.rejects(no.cdp(no.tab, 'DOM.setFileInputFiles', {}), (e: any) => e.code === 'denied');
    assert.equal(
      no.tab.sent.some(([m]: any) => m === 'DOM.setFileInputFiles'),
      false,
    );
    // with Full access the upload doesn't ask
    const full = await iabTab({ anchor: 'full' });
    await full.cdp(full.tab, 'DOM.setFileInputFiles', { files: [] });
    assert.equal(full.confirmed.length, 0);
    // a chat in a read-only mode refuses writes
    const ro = await iabTab({ anchor: 'readOnly' });
    await assert.rejects(ro.cdp(ro.tab, 'Input.insertText', { text: 'a' }), (e: any) => /read-only mode/.test(e.message));
  });

  test('CM-P27: a plugin write on a site allowed for reading asks instead of refusing; one waiting for its turn when the site went back to read only is refused (#1319 G22)', async () => {
    const k = await iabTab();
    const origin = 'https://shop.test';
    // allowed for reading only (a Read only answer kept for good): the plugin's write puts the card up; a yes lets it through
    k.g.chatGrants.delete(CHAT);
    k.g.grants.set(origin, 'read');
    const before = k.asked.length;
    await k.cdp(k.tab, 'Input.insertText', { text: 'a' });
    assert.equal(k.asked.length, before + 1);
    assert.equal(k.asked.at(-1).need, 'write');
    // the site goes back to read only while a write waits for its turn: refused when its turn comes, nothing typed
    let release = () => {};
    const held = k.host.run(k.tab, () => new Promise<void>((r) => (release = r)));
    const typing = k.cdp(k.tab, 'Input.insertText', { text: 'b' });
    await flush();
    k.g.chatGrants.delete(CHAT);
    const typed = k.tab.sent.filter(([m]: any) => m === 'Input.insertText').length;
    release();
    await held;
    await assert.rejects(typing, (e: any) => e.code === 'read_only' && /read only for this chat/.test(e.message));
    assert.equal(k.tab.sent.filter(([m]: any) => m === 'Input.insertText').length, typed);
    // "Allow once" isn't stored: the command's own re-check honours the yes on its card, and the next command asks again
    const once = await iabTab({ answer: { decision: 'allow', scope: 'once', level: 'write' } });
    once.g.chatGrants.delete(CHAT);
    once.g.grants.set(origin, 'read');
    const n = once.asked.length;
    await once.cdp(once.tab, 'Input.insertText', { text: 'c' });
    await once.cdp(once.tab, 'Input.insertText', { text: 'd' });
    assert.equal(once.tab.sent.filter(([m]: any) => m === 'Input.insertText').length, 2);
    assert.equal(once.asked.length, n + 2);
    // the same for a command sent to a child frame whose own site is allowed for reading
    once.tab.wc.debugger.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 's1',
      targetInfo: { targetId: 'f1', url: 'https://frame.test/x' },
    });
    once.g.grants.set('https://frame.test', 'read');
    await once.cdp(once.tab, 'Input.insertText', { text: 'e' }, { sessionId: 's1' });
    assert.equal(once.tab.sent.filter(([m]: any) => m === 'Input.insertText').length, 3);
    assert.equal(once.asked.at(-1).origin, 'https://frame.test');
  });

  test('CM-P07: switching the in-app browser off stops a loaded thread’s plugin, and the note follows the thread’s own backend', async () => {
    const k = await iabTab();
    k.off();
    await assert.rejects(k.call('getTabs'), (e: any) => e.code === 'disabled' && /browser_control_disabled/.test(e.message));
    assert.equal(await k.b.handle('moveMouse', { tabId: 1, x: 1, y: 1 }), null);
    assert.equal(await k.b.handle('ping', {}), 'pong');
    // Stop on the chat: an action already waiting for its turn reaches the page no more; reads still go
    const s2 = await iabTab();
    const registry = new Registry();
    const backends2 = new IabBackends({
      tabs: () => s2.host,
      grants: () => s2.g,
      chatOf: () => CHAT,
      harnessPid: () => 1,
      enabled: () => true,
      pluginEnv: () => ({ backends: ['iab'], flavor: null, version: null }),
      onStop: (fn: any) => registry.onAbort(fn),
      dir: fs.mkdtempSync('/tmp/p7s-'),
    });
    await backends2.loaded(S);
    const plugin = backends2.servers.get(S).backend;
    const tab2 = s2.host.tabs[0];
    const id2 = plugin.idOf(tab2);
    let release = () => {};
    const held = s2.host.run(tab2, () => new Promise<void>((r) => (release = r)));
    const typing = plugin.handle('executeCdp', {
      session_id: S,
      target: { tabId: id2 },
      method: 'Input.insertText',
      commandParams: { text: 'a' },
    });
    await flush();
    registry.onAbort(() => {
      throw new Error('a listener that fails');
    });
    registry.abortChat('another-chat', 'stopped');
    registry.abortChat(CHAT, 'stopped');
    release();
    await held;
    await assert.rejects(typing, (e: any) => e.code === 'stopped');
    assert.equal(
      tab2.sent.some(([m]: any) => m === 'Input.insertText'),
      false,
    );
    await plugin.handle('executeCdp', { session_id: S, target: { tabId: id2 }, method: 'Runtime.evaluate', commandParams: {} });
    backends2.exited();
    assert.equal(plugin.offStop, null);
    // a failing switch reads as off
    const broken = new IabBackend({
      threadId: S,
      chatOf: () => CHAT,
      tabs: () => null,
      grants: () => null,
      enabled: () => {
        throw new Error('x');
      },
    });
    await assert.rejects(broken.handle('getTabs', { session_id: S }), /turned off/);
    // IabBackends hands each backend the live switch
    let enabled = true;
    const backends = new IabBackends({
      tabs: () => ({}),
      grants: () => null,
      chatOf: (id: string) => id,
      harnessPid: () => 1,
      enabled: () => enabled,
      pluginEnv: () => ({ backends: ['iab'], flavor: null, version: null }),
      dir: fs.mkdtempSync('/tmp/p7-'),
    });
    // the host's downloads reach the backend while it is up, and stop with it
    const listeners = new Set<any>();
    backends.o.tabs = () => ({ onDownload: (fn: any) => (listeners.add(fn), () => listeners.delete(fn)) });
    await backends.loaded('t-1');
    assert.equal(listeners.size, 1);
    const live = backends.servers.get('t-1').backend;
    assert.equal(live.on(), true);
    enabled = false;
    assert.equal(live.on(), false);
    backends.exited();
    assert.equal(listeners.size, 0);
    // the routing note says iab only for a thread that has the backend
    assert.match(inAppBrowserNote('sage', true, true).value, /"iab" backend/);
    assert.doesNotMatch(inAppBrowserNote('sage', true, false).value, /"iab" backend/);
  });
}
