// Extension sessions unit cases using shared fake Chrome, socket, timer, and page fixtures.
import { test, assert, RELEASES, GROUP_COLOR, tick, until, sessions, cmd, reply } from './fixture.ts';

export function registerSessions() {
  test('a chat’s session: its tabs open in its own titled group, and it reaches only those tabs', async () => {
    const { chrome, sent, s } = sessions();
    await s.handle({ chat: 'a', method: 'session.open', params: [{ title: 'MoPilot chat-a' }] });
    await s.handle({ chat: 'b', method: 'session.open' });
    assert.deepEqual(sent.splice(0), [
      { chat: 'a', method: 'extension.initialized', params: [] },
      { chat: 'b', method: 'extension.initialized', params: [] },
    ]);
    await cmd(s, 'a', 1, 'chrome.tabs.create', [{ url: 'about:blank', active: false }], 0);
    const a1 = reply(sent, 1).result;
    assert.equal(a1.url, 'about:blank');
    assert.ok(a1.groupId > 0);
    assert.deepEqual(chrome.groups.get(a1.groupId), { id: a1.groupId, windowId: 1, title: 'MoPilot chat-a', color: GROUP_COLOR });
    assert.ok(
      chrome.log.some((c) => c[0] === 'tabs.create' && c[1].active === false),
      'never brought to the front',
    );
    // the second tab joins the group in the group's window
    chrome.windowIds.add(7);
    chrome.groups.get(a1.groupId).windowId = 7;
    await cmd(s, 'a', 2, 'chrome.tabs.create', [], 0);
    const a2 = reply(sent, 2).result;
    assert.equal(a2.groupId, a1.groupId);
    assert.equal(a2.windowId, 7);
    await cmd(s, 'b', 3, 'chrome.tabs.create', [{}], 0);
    const b1 = reply(sent, 3).result;
    assert.notEqual(b1.groupId, a1.groupId, 'each chat its own group');
    assert.deepEqual(chrome.groups.get(b1.groupId).title, 'MoPilot', 'a session opened without a title');
    // chat a naming chat b's tab, or a tab of the user's, never reaches Chrome
    const user = chrome.addTab();
    const before = chrome.log.length;
    await cmd(s, 'a', 4, 'chrome.debugger.attach', [{ tabId: b1.id }, '1.3'], 0);
    await cmd(s, 'a', 5, 'chrome.debugger.sendCommand', [{ tabId: user.id }, 'Runtime.evaluate', {}], 0);
    await cmd(s, 'a', 6, 'chrome.tabs.remove', [user.id], 0);
    await cmd(s, 'a', 7, 'chrome.debugger.attach', [], 0);
    assert.match(reply(sent, 4).error.message, /not one of this chat's tabs/);
    assert.match(reply(sent, 5).error.message, /not one of this chat's tabs/);
    assert.match(reply(sent, 6).error.message, /not one of this chat's tabs/);
    assert.match(reply(sent, 7).error.message, /not one of this chat's tabs/);
    assert.equal(chrome.log.length, before);
    // only about:blank or a web page opens
    await cmd(s, 'a', 8, 'chrome.tabs.create', [{ url: 'chrome://settings' }], 0);
    assert.match(reply(sent, 8).error.message, /about:blank or a web page/);
  });

  test('commands: attach, CDP (with a child session), detach and close on the chat’s own tab; unknown ones are refused', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', { title: 't' });
    await cmd(s, 'a', 1, 'chrome.tabs.create', [{ url: 'https://example.com/' }]);
    const tab = reply(sent, 1).result.id;
    await cmd(s, 'a', 2, 'chrome.debugger.attach', [{ tabId: tab }]);
    assert.ok(
      chrome.log.some((c) => c[0] === 'debugger.attach' && c[2] === '1.3'),
      'the default protocol version',
    );
    chrome.cdp['Page.navigate'] = (p: any) => ({ frameId: 'F', url: p.url });
    await cmd(s, 'a', 3, 'chrome.debugger.sendCommand', [{ tabId: tab }, 'Page.navigate', { url: 'https://x.test/' }]);
    assert.deepEqual(reply(sent, 3).result, { frameId: 'F', url: 'https://x.test/' });
    await cmd(s, 'a', 4, 'chrome.debugger.sendCommand', [{ tabId: tab, sessionId: 'S1' }, 'Runtime.enable']);
    assert.deepEqual(chrome.log.at(-1), ['debugger.sendCommand', { tabId: tab, sessionId: 'S1' }, 'Runtime.enable', {}]);
    await cmd(s, 'a', 5, 'chrome.debugger.sendCommand', [{ tabId: tab, sessionId: '' }, 'Runtime.enable', { x: 1 }]);
    assert.deepEqual(chrome.log.at(-1), ['debugger.sendCommand', { tabId: tab }, 'Runtime.enable', { x: 1 }]);
    await cmd(s, 'a', 55, 'chrome.debugger.sendCommand', []);
    assert.match(reply(sent, 55).error.message, /not one of this chat's tabs/);
    // a command Chrome answers with nothing is answered with an empty result
    chrome.cdp['Page.bringToFront'] = () => undefined;
    await cmd(s, 'a', 56, 'chrome.debugger.sendCommand', [{ tabId: tab }, 'Page.bringToFront']);
    assert.deepEqual(reply(sent, 56).result, {});
    chrome.cdp['Bad.thing'] = new Error('nope');
    await cmd(s, 'a', 6, 'chrome.debugger.sendCommand', [{ tabId: tab }, 'Bad.thing']);
    assert.deepEqual(reply(sent, 6).error, { message: 'nope' });
    await cmd(s, 'a', 7, 'chrome.debugger.detach', [{ tabId: tab }]);
    assert.equal(chrome.attached.has(tab), false);
    // a debugger the chat no longer holds: nothing to let go of
    await cmd(s, 'a', 8, 'chrome.debugger.detach', [{ tabId: tab }]);
    await cmd(s, 'a', 9, 'chrome.debugger.detach', []);
    assert.deepEqual(reply(sent, 8).result, {});
    await cmd(s, 'a', 10, 'chrome.tabs.remove', [tab]);
    assert.equal(chrome.tabsById.has(tab), false);
    assert.equal(s.owner.has(tab), false);
    await cmd(s, 'a', 11, 'chrome.windows.create', []);
    assert.match(reply(sent, 11).error.message, /not a command of MoPilot's extension/);
    await cmd(s, 'nobody', 12, 'chrome.tabs.create', []);
    assert.match(reply(sent, 12).error.message, /no session in Chrome/);
    // a message without an id is not a command
    const n = sent.length;
    await s.handle({ chat: 'a', method: 'chrome.tabs.create' });
    assert.equal(sent.length, n);
    // a non-Error thrown by Chrome is still an answer
    chrome.debugger.attach = async () => {
      throw 'plain';
    };
    await cmd(s, 'a', 13, 'chrome.tabs.create', []);
    await cmd(s, 'a', 14, 'chrome.debugger.attach', [{ tabId: reply(sent, 13).result.id }, '1.2']);
    assert.deepEqual(reply(sent, 14).error, { message: 'plain' });
  });

  test('turns: a command from an older turn is refused in the extension too; letting go never is', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', [], 3);
    const tab = reply(sent, 1).result.id;
    await cmd(s, 'a', 2, 'chrome.debugger.attach', [{ tabId: tab }], 3);
    s.handle({ chat: 'a', method: 'session.advance', params: [5] });
    s.advance('a', 4);
    s.advance('a', 'x');
    s.advance('nobody', 9);
    assert.equal(s.chats.get('a').turn, 5);
    const before = chrome.log.length;
    await cmd(s, 'a', 3, 'chrome.debugger.sendCommand', [{ tabId: tab }, 'Input.dispatchKeyEvent', {}], 4);
    assert.match(reply(sent, 3).error.message, /turn that already ended/);
    assert.equal(chrome.log.length, before);
    for (const m of RELEASES) assert.ok(['chrome.debugger.detach', 'chrome.tabs.remove'].includes(m));
    await cmd(s, 'a', 4, 'chrome.debugger.detach', [{ tabId: tab }], 1);
    await cmd(s, 'a', 5, 'chrome.tabs.remove', [tab], 1);
    assert.deepEqual(reply(sent, 4).result, {});
    assert.deepEqual(reply(sent, 5).result, {});
    // a newer turn is taken up by its first command
    await cmd(s, 'a', 6, 'chrome.tabs.create', [], 6);
    assert.equal(s.chats.get('a').turn, 6);
    // MoPilot restarted: it counts the chat's turns from 0 again, and reopening the session says so
    await s.open('a', { turn: 0 });
    assert.equal(s.chats.get('a').turn, 0);
    await cmd(s, 'a', 7, 'chrome.tabs.create', [], 0);
    assert.ok(reply(sent, 7).result.id);
  });

  test('a closed chat: its debuggers let go and its tabs leave the group, the user’s again', async () => {
    const { chrome, sent, s, logged } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    await cmd(s, 'a', 2, 'chrome.tabs.create', []);
    const [t1, t2] = [reply(sent, 1).result.id, reply(sent, 2).result.id];
    await cmd(s, 'a', 3, 'chrome.debugger.attach', [{ tabId: t1 }]);
    await s.handle({ chat: 'a', method: 'session.close' });
    assert.equal(chrome.attached.has(t1), false);
    assert.equal(chrome.tabsById.get(t1).groupId, -1);
    assert.equal(chrome.tabsById.get(t2).groupId, -1);
    assert.equal(s.chats.has('a'), false);
    assert.equal(s.owner.size, 0);
    await s.close('a');
    // an empty session closes without ungrouping; failures are noted, never thrown
    await s.open('b', {});
    await s.close('b');
    await s.open('c', {});
    await cmd(s, 'c', 4, 'chrome.tabs.create', []);
    await cmd(s, 'c', 5, 'chrome.debugger.attach', [{ tabId: reply(sent, 4).result.id }]);
    chrome.fail['debugger.detach'] = new Error('gone');
    chrome.fail['tabs.ungroup'] = new Error('gone');
    await s.close('c');
    assert.ok(logged.includes('detach a closed chat’s tab'));
    assert.ok(logged.includes('ungroup a closed chat’s tabs'));
    assert.equal(chrome.log.filter((c) => c[0] === 'tabs.ungroup').length, 2);
  });

  test('MoPilot going away lets go of every debugger; the groups stay for its return', async () => {
    const { chrome, sent, s, logged } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    await cmd(s, 'a', 2, 'chrome.tabs.create', []);
    const [t1, t2] = [reply(sent, 1).result.id, reply(sent, 2).result.id];
    await cmd(s, 'a', 3, 'chrome.debugger.attach', [{ tabId: t1 }]);
    await cmd(s, 'a', 4, 'chrome.debugger.attach', [{ tabId: t2 }]);
    chrome.debugger.detach = async (t: any) => {
      chrome.attached.delete(t.tabId);
      if (t.tabId === t2) throw new Error('gone');
    };
    await s.peerGone();
    assert.equal(chrome.attached.size, 0);
    assert.equal(s.chats.get('a').attached.size, 0);
    assert.ok(logged.includes('let go of a tab'));
    assert.ok(chrome.tabsById.get(t1).groupId > 0, 'still grouped');
  });

  test('a service worker restart keeps the chats: their groups and tabs come back, and a reopened session reports the tabs still there', async () => {
    const first = sessions();
    await first.s.open('a', { title: 'A' });
    await cmd(first.s, 'a', 1, 'chrome.tabs.create', []);
    await cmd(first.s, 'a', 2, 'chrome.tabs.create', []);
    const [t1, t2] = [reply(first.sent, 1).result.id, reply(first.sent, 2).result.id];
    await tick();
    const saved = first.chrome.store.session.sessions;
    assert.deepEqual(saved.a.tabs, [t1, t2]);
    // the same Chrome after a restart: tab 2 was closed meanwhile
    const again = sessions();
    again.chrome.store.session.sessions = saved;
    again.chrome.tabsById.set(t1, { id: t1, url: 'https://kept.example/', groupId: saved.a.groupId });
    await again.s.restore();
    assert.equal(again.s.owner.get(t1), 'a');
    await again.s.handle({ chat: 'a', method: 'session.open', params: [{ title: 'A2' }] });
    assert.deepEqual(again.sent, [
      { chat: 'a', method: 'chrome.tabs.onCreated', params: [{ id: t1, url: 'https://kept.example/', groupId: saved.a.groupId }] },
      { chat: 'a', method: 'extension.initialized', params: [] },
    ]);
    assert.equal(again.s.owner.has(t2), false);
    assert.equal(again.s.chats.get('a').title, 'A2');
    // a reopened session without a title keeps its title
    await again.s.open('a', {});
    assert.equal(again.s.chats.get('a').title, 'A2');
  });

  test('restore reads only what it can: no storage, a failed read, nothing saved, or odd entries', async () => {
    const none = sessions({ storage: null });
    await none.s.restore();
    await none.s.open('a', {});
    assert.equal(none.s.chats.size, 1, 'works without storage');
    const failing = sessions();
    failing.chrome.fail['storage.session.get'] = new Error('locked');
    await failing.s.restore();
    assert.deepEqual(failing.logged, ['read the saved sessions']);
    const empty = sessions();
    await empty.s.restore();
    empty.chrome.store.session.sessions = 'junk';
    await empty.s.restore();
    assert.equal(empty.s.chats.size, 0);
    const odd = sessions();
    odd.chrome.store.session.sessions = { x: { tabs: 'no', groupId: 'g' }, y: null };
    await odd.s.restore();
    assert.deepEqual(odd.s.chats.get('x'), { title: 'MoPilot', groupId: null, tabs: new Set(), attached: new Set(), turn: 0 });
    assert.equal(odd.s.chats.get('y').title, 'MoPilot');
    // a save that fails is noted
    odd.chrome.fail['storage.session.set'] = new Error('full');
    await odd.s.open('z', {});
    await tick();
    assert.ok(odd.logged.includes('save the sessions'));
  });

  test('a closed group: the next tab starts a new one; a tab Chrome can’t group is still the chat’s', async () => {
    const { chrome, sent, s, logged } = sessions();
    await s.open('a', { title: 'A' });
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    const g1 = reply(sent, 1).result.groupId;
    chrome.groups.delete(g1);
    await cmd(s, 'a', 2, 'chrome.tabs.create', []);
    const g2 = reply(sent, 2).result.groupId;
    assert.notEqual(g2, g1);
    assert.equal(chrome.groups.get(g2).title, 'A');
    // the group vanishes between the window lookup and the grouping
    const get = chrome.tabGroups.get;
    let n = 0;
    chrome.tabGroups.get = async (id: number) => {
      if (n++ === 1) throw new Error('gone');
      return get(id);
    };
    await cmd(s, 'a', 3, 'chrome.tabs.create', []);
    assert.notEqual(reply(sent, 3).result.groupId, g2);
    chrome.tabGroups.get = get;
    // Chrome refuses to group (a popup window): the tab still opens and is the chat's
    chrome.fail['tabs.group'] = new Error('popup');
    s.chats.get('a').groupId = null;
    await cmd(s, 'a', 4, 'chrome.tabs.create', []);
    const t4 = reply(sent, 4).result;
    assert.equal(t4.groupId, -1);
    assert.equal(s.owner.get(t4.id), 'a');
    assert.ok(logged.includes('group a tab'));
  });

  test('Chrome’s events reach the chat that owns the tab, and only it', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    const tab = reply(sent, 1).result.id;
    await cmd(s, 'a', 2, 'chrome.debugger.attach', [{ tabId: tab }, '1.3']);
    sent.length = 0;
    s.onDebuggerEvent({ tabId: tab }, 'Page.frameNavigated', { frame: { id: 'F' } });
    s.onDebuggerEvent({ tabId: tab }, 'Page.loadEventFired');
    s.onDebuggerEvent({ tabId: 999 }, 'Page.frameNavigated', {});
    s.onDebuggerEvent(undefined, 'x', {});
    assert.deepEqual(sent, [
      { chat: 'a', method: 'chrome.debugger.onEvent', params: [{ tabId: tab }, 'Page.frameNavigated', { frame: { id: 'F' } }] },
      { chat: 'a', method: 'chrome.debugger.onEvent', params: [{ tabId: tab }, 'Page.loadEventFired', {}] },
    ]);
    sent.length = 0;
    s.onTabRemoved(999);
    s.onTabRemoved(tab);
    assert.deepEqual(sent, [{ chat: 'a', method: 'chrome.tabs.onRemoved', params: [tab] }]);
    assert.equal(s.owner.has(tab), false);
    void chrome;
  });

  test('the user takes a tab back: cancelling the debugging bar or dragging it out of the group ends the chat’s hold', async () => {
    const { chrome, sent, s, logged } = sessions();
    await s.open('a', {});
    for (const id of [1, 2, 3]) await cmd(s, 'a', id, 'chrome.tabs.create', []);
    const [t1, t2, t3] = [1, 2, 3].map((id) => reply(sent, id).result.id);
    const group = reply(sent, 1).result.groupId;
    await cmd(s, 'a', 4, 'chrome.debugger.attach', [{ tabId: t1 }]);
    await cmd(s, 'a', 5, 'chrome.debugger.attach', [{ tabId: t2 }]);
    sent.length = 0;
    // the debugging bar's Cancel: the tab leaves the group too
    s.onDebuggerDetach({ tabId: t1 }, 'canceled_by_user');
    assert.deepEqual(sent.at(-1), { chat: 'a', method: 'chrome.debugger.onDetach', params: [{ tabId: t1 }, 'canceled_by_user'] });
    assert.equal(chrome.tabsById.get(t1).groupId, -1);
    assert.equal(s.owner.has(t1), false);
    // Chrome closing the target: no ungroup; and a reason Chrome left out
    s.onDebuggerDetach({ tabId: t3 }, undefined);
    assert.deepEqual(sent.at(-1).params, [{ tabId: t3 }, '']);
    // the user closes a tab the agent is attached to: Chrome detaches first, and the tab stays the chat's until it is
    // removed, so MoPilot hears that it closed
    await cmd(s, 'a', 31, 'chrome.tabs.create', []);
    const closing = reply(sent, 31).result.id;
    await cmd(s, 'a', 32, 'chrome.debugger.attach', [{ tabId: closing }]);
    s.onDebuggerDetach({ tabId: closing }, 'target_closed');
    assert.equal(s.owner.get(closing), 'a');
    assert.equal(s.chats.get('a').attached.has(closing), false);
    assert.equal(chrome.tabsById.get(closing).groupId > 0, true, 'not ungrouped');
    s.onTabRemoved(closing);
    assert.deepEqual(sent.at(-1), { chat: 'a', method: 'chrome.tabs.onRemoved', params: [closing] });
    s.onDebuggerDetach({ tabId: 12345 }, 'target_closed');
    // dragged out of the group: its debugger goes, MoPilot is told
    s.onTabUpdated(t2, { groupId: -1 }, { ...chrome.tabsById.get(t2), groupId: -1 });
    assert.deepEqual(sent.at(-1), { chat: 'a', method: 'chrome.debugger.onDetach', params: [{ tabId: t2 }, 'removed_from_group'] });
    assert.equal(s.owner.has(t2), false, 'ownership retires synchronously');
    await until(() => !chrome.attached.has(t2));
    // ... and one with no debugger: just told
    await cmd(s, 'a', 6, 'chrome.tabs.create', []);
    const t6 = reply(sent, 6).result.id;
    s.onTabUpdated(t6, { groupId: 77 }, { ...chrome.tabsById.get(t6), groupId: 77 });
    assert.equal(s.owner.has(t6), false);
    // a failing ungroup or detach is noted
    await cmd(s, 'a', 7, 'chrome.tabs.create', []);
    await cmd(s, 'a', 8, 'chrome.tabs.create', []);
    const [t7, t8] = [reply(sent, 7).result.id, reply(sent, 8).result.id];
    await cmd(s, 'a', 9, 'chrome.debugger.attach', [{ tabId: t8 }]);
    chrome.fail['tabs.ungroup'] = new Error('x');
    chrome.fail['debugger.detach'] = new Error('x');
    s.onDebuggerDetach({ tabId: t7 }, 'canceled_by_user');
    s.onTabUpdated(t8, { groupId: -1 }, { ...chrome.tabsById.get(t8), groupId: -1 });
    await tick();
    assert.ok(logged.includes('ungroup a tab the user took back'));
    assert.ok(logged.includes('let go of a tab the user took back'));
    void group;
  });

  test('group events distinguish native mutations from user moves even before canonical allocation', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    const tab = reply(sent, 1).result.id;
    const n = sent.length;
    s.onTabUpdated(tab, { status: 'loading' }, {});
    s.onTabUpdated(tab, undefined, {});
    s.onTabUpdated(tab, { groupId: reply(sent, 1).result.groupId }, chrome.tabsById.get(tab));
    s.grouping.set(tab, {});
    s.onTabUpdated(tab, { groupId: -1 }, { id: tab, groupId: -1 });
    s.grouping.delete(tab);
    s.chats.get('a').groupId = null;
    s.onTabUpdated(tab, { groupId: -1 }, { id: tab, groupId: -1 });
    assert.equal(sent.length, n);
    assert.equal(s.owner.get(tab), 'a');
    s.onTabUpdated(tab, { groupId: 3 }, { id: tab, groupId: 3 });
    assert.equal(s.owner.has(tab), false, 'a user-directed move retires ownership even before first allocation');
    assert.deepEqual(sent.at(-1).params, [{ tabId: tab }, 'removed_from_group']);
    void chrome;
  });

  test('the user drags one of their tabs into a chat’s group: it becomes the chat’s; into another group, nothing', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', {});
    await s.open('b', {});
    await cmd(s, 'b', 1, 'chrome.tabs.create', []);
    const group = reply(sent, 1).result.groupId;
    const user = chrome.addTab({ url: 'https://mine.example/' });
    sent.length = 0;
    s.onTabUpdated(user.id, { groupId: -1 }, user);
    s.onTabUpdated(user.id, { groupId: 999 }, { ...user, groupId: 999 });
    assert.deepEqual(sent, []);
    s.onTabUpdated(user.id, { groupId: group }, { ...user, groupId: group });
    assert.deepEqual(sent, [{ chat: 'b', method: 'chrome.tabs.onCreated', params: [{ ...user, groupId: group }] }]);
    assert.equal(s.owner.get(user.id), 'b');
  });

  test('a popup a chat’s tab opens is the chat’s, in its group; other new tabs are not', async () => {
    const { chrome, sent, s } = sessions();
    await s.open('a', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    const opener = reply(sent, 1).result;
    sent.length = 0;
    s.onTabCreated(chrome.addTab({ openerTabId: 31337 }));
    s.onTabCreated(chrome.addTab({}));
    s.onTabCreated(undefined);
    const popup = chrome.addTab({ openerTabId: opener.id, url: 'https://pop.example/' });
    s.onTabCreated(popup);
    // reported twice (Chrome's onCreated and a restore): one adoption
    s.onTabCreated(popup);
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'chrome.tabs.onCreated');
    assert.equal(sent[0].params[0].id, popup.id);
    assert.equal(sent[0].params[0].groupId, opener.groupId);
    assert.equal(s.owner.get(popup.id), 'a');
    // a popup whose window can't be grouped is still the chat's, reported ungrouped
    chrome.fail['tabs.group'] = new Error('popup window');
    s.chats.get('a').groupId = null;
    const p2 = chrome.addTab({ openerTabId: opener.id });
    s.onTabCreated(p2);
    await tick();
    assert.equal(sent.at(-1).params[0].groupId, -1);
  });

  test('#1642: a link in a hidden chat tab opens a tab that is the chat’s by Chrome’s source, whatever tab is active', async () => {
    const { chrome, sent, logged, s } = sessions({ sourcedPopups: true });
    await s.open('a', {});
    await s.open('b', {});
    await cmd(s, 'a', 1, 'chrome.tabs.create', []);
    const hidden = reply(sent, 1).result;
    await cmd(s, 'b', 2, 'chrome.tabs.create', []);
    const front = reply(sent, 2).result;
    const user = chrome.addTab({ url: 'https://mine.example/' });
    sent.length = 0;
    // Chrome names the window's active tab as the opener: the user's tab, or another chat's in front
    const popup = chrome.addTab({ openerTabId: user.id, url: 'https://shop.example/order' });
    const misnamed = chrome.addTab({ openerTabId: front.id, url: 'https://shop.example/order2' });
    await s.onTabCreated(popup);
    await s.onTabCreated(misnamed);
    assert.deepEqual(sent, []);
    // not a chat's page, no tab id, or a tab that is someone's already: nothing
    await s.onNavigationTarget({ sourceTabId: user.id, tabId: popup.id });
    await s.onNavigationTarget({ sourceTabId: hidden.id });
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: hidden.id });
    await s.onNavigationTarget(undefined);
    assert.deepEqual(sent, []);
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: popup.id });
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: misnamed.id });
    assert.deepEqual(
      (sent as any[]).map((m) => [m.chat, m.method, m.params[0].id, m.params[0].openerTabId, m.params[0].groupId]),
      [
        ['a', 'chrome.tabs.onCreated', popup.id, hidden.id, hidden.groupId],
        ['a', 'chrome.tabs.onCreated', misnamed.id, hidden.id, hidden.groupId],
      ],
    );
    assert.equal(s.owner.get(popup.id), 'a');
    assert.equal(s.owner.get(misnamed.id), 'a');
    // Chrome put a popup of a's hidden tab in b's group (b's tab was in front): b took it as dragged in, the source wins
    const inherited = chrome.addTab({ openerTabId: front.id, url: 'https://shop.example/order3' });
    s.onTabUpdated(inherited.id, { groupId: front.groupId }, { ...inherited, groupId: front.groupId });
    assert.equal(s.owner.get(inherited.id), 'b');
    sent.length = 0;
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: inherited.id });
    assert.deepEqual(
      (sent as any[]).map((m) => [m.chat, m.method]),
      [
        ['b', 'chrome.debugger.onDetach'],
        ['a', 'chrome.tabs.onCreated'],
      ],
    );
    assert.equal(s.owner.get(inherited.id), 'a');
    assert.equal(chrome.tabsById.get(inherited.id).groupId, hidden.groupId);
    // the user dragged it into a's group while it was read: nothing to move, one report
    const dragged = chrome.addTab({});
    const read = chrome.tabs.get;
    chrome.tabs.get = async (id: number) => {
      s.onTabUpdated(dragged.id, { groupId: hidden.groupId }, { ...dragged, groupId: hidden.groupId });
      return read(id);
    };
    sent.length = 0;
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: dragged.id });
    chrome.tabs.get = read;
    assert.deepEqual(
      (sent as any[]).map((m) => [m.chat, m.method]),
      [['a', 'chrome.tabs.onCreated']],
    );
    // a tab gone before it could be read is noted, never adopted
    sent.length = 0;
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: 424242 });
    assert.deepEqual(sent, []);
    assert.ok(logged.includes('read a popup of a chat’s tab'));
    // the source chat closed while the tab was read: the tab stays the user's
    const late = chrome.addTab({});
    const get = chrome.tabs.get;
    chrome.tabs.get = async (id: number) => {
      await s.close('a');
      return get(id);
    };
    await s.onNavigationTarget({ sourceTabId: hidden.id, tabId: late.id });
    chrome.tabs.get = get;
    assert.deepEqual(sent, []);
    assert.equal(s.owner.has(late.id), false);
  });
}
