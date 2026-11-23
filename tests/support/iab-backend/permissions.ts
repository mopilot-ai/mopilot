// In-app browser backend permissions unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require, S, backend, withTab } from './fixture';

export function registerPermissionsCases() {
  test('navigation: URL policy (with a navigationBlocked event), take-over, history entries, and the site gate', async () => {
    const { call, tab, notes, grants } = await withTab();
    const nav = (method: string, commandParams: any = {}) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
    await assert.rejects(
      nav('Page.navigate', { url: 'file:///etc/hosts' }),
      /Blocked browser navigation by Browser Use URL policy: file:\/\/\/etc\/hosts/,
    );
    assert.deepEqual(notes.at(-1), [
      'onCDPEvent',
      {
        source: { tabId: 1 },
        method: 'Page.navigationBlocked',
        params: { errorText: 'Blocked browser navigation by Browser Use URL policy: file:///etc/hosts', url: 'file:///etc/hosts' },
      },
    ]);
    await nav('Page.navigate', { url: 'https://b.test/' });
    assert.deepEqual(grants.calls.at(-1).slice(0, 3), ['peek', 'https://b.test/', 'read']);
    tab.reply['Page.getNavigationHistory'] = () => ({ entries: [{ id: 3, url: 'https://c.test/' }] });
    await nav('Page.navigateToHistoryEntry', { entryId: 3 });
    assert.deepEqual(grants.calls.at(-1).slice(0, 2), ['peek', 'https://c.test/']);
    await assert.rejects(nav('Page.navigateToHistoryEntry', { entryId: 4 }), /URL policy: undefined/);
    tab.reply['Page.getNavigationHistory'] = () => null;
    await assert.rejects(nav('Page.navigateToHistoryEntry', { entryId: 4 }), /URL policy: undefined/);
    await nav('Page.reload');
    assert.deepEqual(grants.calls.at(-1).slice(0, 2), ['peek', 'https://example.com/']);
    // a reload of a form result would send the form again (CDP's reload doesn't ask): only the user resubmits
    const sent = () => tab.sends.filter((s: any[]) => s[0] === 'Page.reload').length;
    const before = sent();
    tab.reply['Page.getNavigationHistory'] = () => ({ currentIndex: 0, entries: [{ transitionType: 'form_submit' }] });
    await assert.rejects(nav('Page.reload'), /Didn't reload tab 1: its page is the result of a form submission/);
    tab.failure = 'ERR_CACHE_MISS';
    tab.reply['Page.getNavigationHistory'] = () => null;
    await assert.rejects(nav('Page.reload'), /form submission/);
    assert.equal(sent(), before, 'never sent');
    tab.failure = null;
    tab.takenOver = true;
    await assert.rejects(nav('Page.reload'), /The user took over tab 1/);
  });

  test('site gate: blocked, denied and read-only refuse; a high-risk or credentialed site, or a re-ask, asks the user', async () => {
    const { b, grants } = backend();
    await b.gateUrl('', 'read');
    await b.gateUrl('about:blank', 'read');
    assert.deepEqual(grants.calls, []);
    grants.verdict = 'blocked';
    grants.risk = { level: 'blocked', label: 'Weapons' };
    await assert.rejects(
      b.gateUrl('https://bad.test/', 'read'),
      (e: any) =>
        e.code === 'blocked' &&
        /^Weapons: blocked. https:\/\/bad.test\/\n<refusal reason="site_blocked" retryable="false" browser="iab">/.test(e.message),
    );
    grants.risk = {};
    await assert.rejects(b.gateUrl('https://bad.test/', 'read'), /^Error: Blocked. https:\/\/bad.test\//);
    grants.verdict = 'denied';
    await assert.rejects(b.gateUrl('https://d.test/x', 'read'), /The user did not allow https:\/\/d.test in this chat/);
    grants.verdict = 'read_only';
    await assert.rejects(b.gateUrl('https://r.test/x', 'write'), /https:\/\/r.test is read only for this chat/);
    // a refusal from asking the user is explained too
    grants.verdict = 'reask';
    grants.require = async () => {
      const { ToolError } = require('../../../electron/capabilities/contract/registry.cjs');
      throw new ToolError('The user did not allow https://a.test.', 'denied');
    };
    await assert.rejects(b.gateUrl('https://a.test/', 'write'), /browser="iab"/);
    delete grants.require;
    grants.require = async (url: string, need: string, ctx: any, opts: any) => {
      grants.calls.push(['require', url, need, ctx, opts]);
    };
    const asks = () => grants.calls.filter((c: any) => c[0] === 'require').length;
    grants.verdict = 'ask';
    grants.risk = { level: 'low', credentials: false };
    await b.gateUrl('https://a.test/', 'read');
    assert.equal(asks(), 0);
    grants.risk = { level: 'high' };
    await b.gateUrl('https://bank.test/', 'read');
    grants.risk = { level: 'low', credentials: true };
    await b.gateUrl('https://u:p@a.test/', 'read');
    grants.verdict = 'reask';
    grants.risk = { level: 'low' };
    await b.gateUrl('https://a.test/', 'write');
    assert.equal(asks(), 3);
    assert.deepEqual(grants.calls.at(-1), [
      'require',
      'https://a.test/',
      'write',
      // outside a request there is no request signal (#1865: a request's own is the one its Stop aborts)
      { chatId: `chat:${S}`, segmentId: S, signal: null },
      { offer: 'write', localAlways: false },
    ]);
  });

  test('input: take-over refuses; password fields refuse typing; sensitive or high-risk acts ask; clicks show the cursor', async () => {
    const { call, tab, host, grants } = await withTab();
    const input = (method: string, commandParams: any) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
    const acts = () => grants.calls.filter((c: any) => c[0] === 'act');
    // plain input events: only the site gate
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 });
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' });
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', text: '' });
    assert.equal(host.calls.filter((c: any) => c[0] === 'intent').length, 0);
    // a click: the element under the point, and the cursor
    host.intentOf = { button: true, name: 'Learn more' };
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 6 });
    assert.deepEqual(host.calls.at(-1), ['intent', 'tab_1', { point: { x: 5, y: 6 }, session: '' }]);
    assert.deepEqual(host.o.cursor.acts.at(-1), ['tab_1', { kind: 'click', x: 5, y: 6 }]);
    // a wheel turn glides to its point, typed text to its field; a key typed alone draws nothing more
    await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 7, y: 8, deltaY: -100 });
    assert.deepEqual(host.o.cursor.acts.at(-1), ['tab_1', { kind: 'scroll', x: 7, y: 8, direction: 'up' }]);
    await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 7, y: 8, deltaY: 100 });
    assert.deepEqual(host.o.cursor.acts.at(-1)[1].direction, 'down');
    host.intentOf = { editable: true };
    await input('Input.insertText', { text: 'Ada' });
    assert.deepEqual(host.o.cursor.acts.at(-1), ['tab_1', { kind: 'type' }]);
    const before = host.o.cursor.acts.length;
    await input('Input.dispatchKeyEvent', { type: 'char', text: 'a' });
    assert.equal(host.o.cursor.acts.length, before);
    host.intentOf = { button: true, name: 'Learn more' };
    assert.equal(acts().length, 0);
    // a sensitive click asks
    host.intentOf = { button: true, name: 'Delete account' };
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 6 });
    assert.equal(acts().length, 1);
    assert.equal(acts()[0][3].tool, 'click');
    // the card names what is pressed, as browser_*'s cards do (#1384)
    assert.equal(acts()[0][3].summary, 'click on https://example.com ("Delete account")');
    // typing into a password field
    host.intentOf = { editable: true, secret: true };
    await assert.rejects(input('Input.insertText', { text: 'hunter2' }), /password field: agents never type passwords/);
    await assert.rejects(input('Input.dispatchKeyEvent', { type: 'char', text: 'h' }), /password field/);
    assert.deepEqual(host.calls.at(-1), ['intent', 'tab_1', {}]);
    // Enter in a form that submits
    host.intentOf = { editable: true, form: { submit: 'Send', secrets: 0 } };
    await input('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter' });
    await input('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r' });
    assert.equal(acts().length, 3);
    // a high-risk site asks for any act
    host.intentOf = null;
    grants.risk = { level: 'high' };
    grants.verdict = 'ok';
    await input('Input.insertText', { text: 'x' });
    assert.equal(acts().length, 4);
    // nothing to ask about on a blank page
    tab.url = 'about:blank';
    await input('Input.insertText', { text: 'x' });
    tab.url = '';
    await input('Input.insertText', { text: 'x' });
    assert.equal(acts().length, 4);
    // no cursor: clicks still go
    host.o.cursor = null;
    grants.risk = { level: 'low' };
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    tab.takenOver = true;
    await assert.rejects(input('Input.insertText', { text: 'x' }), /The user took over tab 1/);
  });
}
