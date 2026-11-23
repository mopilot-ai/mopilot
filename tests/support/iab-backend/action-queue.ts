// In-app browser backend action-queue unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, tick, backend, withTab } from './fixture';

export function registerActionQueueCases() {
  test("cua.createBrowserTab's sequence works in a fresh chat, shown or hidden", async () => {
    for (const visible of [true, false]) {
      const { call, host } = backend();
      assert.deepEqual(await call('executeUnhandledCommand', { type: 'browser_visibility_set', visible }), {});
      const created = await call('createTab');
      assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: visible }]);
      await call('executeCdp', {
        target: { tabId: created.id },
        method: 'Page.navigate',
        commandParams: { url: 'http://127.0.0.1:8801/game' },
      });
      assert.deepEqual(host.tabs[0].sends.at(-1), ['Page.navigate', { url: 'http://127.0.0.1:8801/game' }, '']);
    }
  });

  // The vendor's cua.createBrowserTab('iab', url, { visible: true }) shows the browser before it opens a tab: in a
  // fresh chat there is no tab yet, and that must not fail the whole call.
  test('a fresh chat: showing the browser before any tab shows the tab opened next', async () => {
    const { b, call, host } = backend();
    const cmd = (p: any) => call('executeUnhandledCommand', p);
    assert.deepEqual(await cmd({ type: 'browser_visibility_set', visible: true }), {});
    assert.equal(
      host.calls.some((c: any) => c[0] === 'select'),
      false,
    );
    const created = await call('createTab');
    assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: true }]);
    assert.equal(created.active, true);
    // the chat's tabs closed: none to show, so a request waits for the next tab
    const closeAll = () => {
      for (const t of host.tabs) t.closed = true;
      host.cur = null;
    };
    // hidden again before the next tab: it opens in the background
    closeAll();
    await cmd({ type: 'browser_visibility_set', visible: true });
    await cmd({ type: 'browser_visibility_set', visible: false });
    await call('createTab');
    assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: false }]);
    // shown once: the tab after it opens in the background again
    closeAll();
    await cmd({ type: 'browser_visibility_set', visible: true });
    await call('createTab');
    assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: true }]);
    await call('createTab');
    assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: false }]);
    // a turn's end, or a Stop, forgets a pending show
    for (const forget of [() => call('turnEnded', {}), () => b.stopped()]) {
      closeAll();
      await cmd({ type: 'browser_visibility_set', visible: true });
      await forget();
      await call('createTab');
      assert.deepEqual(host.calls.at(-1), ['create', `chat:${S}`, { focus: false }]);
    }
    // tabs but none current: the last one is shown
    host.cur = null;
    assert.deepEqual(await cmd({ type: 'browser_visibility_set', visible: true }), {});
    assert.deepEqual(host.calls.at(-1), ['select', `chat:${S}`, host.tabs.at(-1).id]);
    // a failed open keeps the request for the next one
    const { call: call2, host: host2 } = backend();
    await call2('executeUnhandledCommand', { type: 'browser_visibility_set', visible: true });
    const create = host2.create;
    host2.create = async () => {
      throw new Error('no window');
    };
    await assert.rejects(call2('createTab'), /no window/);
    host2.create = create;
    await call2('createTab');
    assert.deepEqual(host2.calls.at(-1), ['create', `chat:${S}`, { focus: true }]);
  });

  test("actions wait for the tab's queue (a browser_* action holds it); reads, interception and dialogs do not", async () => {
    const { call, tab, host } = await withTab();
    const cmd = (method: string, commandParams: any = {}) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
    await call('attach', { tabId: 1 });
    // a browser_* action on the tab, held until released
    let release = () => {};
    const action = host.run(tab, () => new Promise<void>((r) => (release = r)));
    const acts = [
      cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }),
      cmd('Page.navigate', { url: 'https://example.com/next' }),
      cmd('Emulation.setDeviceMetricsOverride', { width: 1 }),
      call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 400, height: 800 }),
      call('executeUnhandledCommand', { type: 'browser_viewport_reset' }),
    ];
    // not actions: they go through while the queue is held (an action may be waiting on them)
    await cmd('Runtime.evaluate', { expression: '1' });
    await cmd('Page.handleJavaScriptDialog', { accept: true });
    await cmd('Fetch.continueRequest', { requestId: 'r' });
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(
      tab.sends.map((s: any) => s[0]),
      ['Runtime.evaluate', 'Page.handleJavaScriptDialog', 'Fetch.continueRequest'],
    );
    release();
    await action;
    await Promise.all(acts);
    // each in its turn once the action let go (in the order their site gates finished); the plugin's viewport was
    // reset before its turn came, so nothing of it reaches the page
    assert.deepEqual(
      tab.sends
        .slice(3)
        .map((s: any) => s[0])
        .sort(),
      ['Emulation.setDeviceMetricsOverride', 'Input.dispatchMouseEvent', 'Page.navigate'],
    );
  });

  test("a site gate that asks the user waits outside the tab's queue, so browser_* actions keep running meanwhile", async () => {
    const { call, tab, host, grants } = await withTab();
    let approve = () => {};
    grants.act = async () => new Promise<void>((r) => (approve = r));
    host.intentOf = { button: true, name: 'Delete account' };
    const press = call('executeCdp', {
      target: { tabId: 1 },
      method: 'Input.dispatchMouseEvent',
      commandParams: { type: 'mousePressed', x: 1, y: 1 },
    });
    for (let i = 0; i < 10; i++) await tick();
    // the card is up: a browser_* action on the tab is not held behind it
    assert.equal(await host.run(tab, async () => 'ran'), 'ran');
    approve();
    await press;
    assert.deepEqual(
      tab.sends.map((s: any) => s[0]),
      ['Input.dispatchMouseEvent'],
    );
  });

  test('a queued action is checked when its turn comes: a tab closed or taken over meanwhile is not acted on', async () => {
    const { call, tab, host } = await withTab();
    const cmd = (method: string, commandParams: any = {}) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
    /** A browser_* action holding the tab until `release`. */
    const holding = () => {
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      return { done: host.run(tab, () => gate), release };
    };
    const first = holding();
    const refused = Promise.all([
      assert.rejects(cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }), /The user took over tab 1/),
      assert.rejects(cmd('Page.reload'), /The user took over tab 1/),
    ]);
    tab.takenOver = true;
    first.release();
    await first.done;
    await refused;
    tab.takenOver = false;
    const second = holding();
    const typed = assert.rejects(cmd('Input.insertText', { text: 'a' }), /Unknown tab: 1/);
    tab.closed = true;
    second.release();
    await second.done;
    await typed;
    tab.closed = false;
    // a browser_* action navigated the tab: the plugin's input was meant for the page it saw
    const third = holding();
    const moved = assert.rejects(
      cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }),
      /Tab 1 changed while this action waited for its turn: it is at https:\/\/other.test\/x now/,
    );
    const reload = assert.rejects(cmd('Page.reload'), /Tab 1 changed/);
    // a navigation to a URL of its own, and the viewport, still go
    const go = cmd('Page.navigate', { url: 'https://example.com/next' });
    const size = cmd('Emulation.setDeviceMetricsOverride', { width: 1 });
    for (let i = 0; i < 10; i++) await tick();
    tab.url = 'https://other.test/x';
    third.release();
    await third.done;
    await Promise.all([moved, reload, go, size]);
    // the page moved its own URL on the same site (pushState mid-drag): the rest of the drag still goes
    tab.url = 'https://example.com/';
    const drag = holding();
    const released = cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2 });
    for (let i = 0; i < 10; i++) await tick();
    tab.url = 'https://example.com/#@1,2';
    drag.release();
    await drag.done;
    await released;
    // a value that is no URL is compared as written
    tab.url = 'not a url';
    const odd = holding();
    const oddMove = cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
    odd.release();
    await odd.done;
    await oddMove;
    // a password field appeared under the text while it waited
    host.intentOf = { editable: true };
    const fourth = holding();
    const secret = assert.rejects(cmd('Input.insertText', { text: 'hunter2' }), /password field: agents never type passwords/);
    for (let i = 0; i < 10; i++) await tick();
    host.intentOf = { editable: true, secret: true };
    fourth.release();
    await fourth.done;
    await secret;
    assert.deepEqual(tab.sends.map((s: any) => s[0]).sort(), [
      'Emulation.setDeviceMetricsOverride',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      // each refused reload read the tab's history first (whether it would resubmit a form): no page action
      'Page.getNavigationHistory',
      'Page.getNavigationHistory',
      'Page.navigate',
    ]);
  });

  test('moveMouse moves the agent cursor on a known tab, and ignores the rest', async () => {
    const { b, host } = await withTab();
    assert.equal(await b.handle('moveMouse', { tabId: 1, x: 3, y: 4 }), null);
    assert.deepEqual(host.o.cursor.acts.at(-1), ['tab_1', { kind: 'hover', x: 3, y: 4 }]);
    assert.equal(await b.handle('moveMouse', { tabId: 9, x: 3, y: 4 }), null);
    assert.equal(await b.handle('moveMouse', { tabId: 1, x: 'a', y: 4 }), null);
    assert.equal(await b.handle('moveMouse', { tabId: 1, x: 1, y: null }), null);
    assert.equal(await b.handle('moveMouse', null), null);
    host.tabs[0].closed = true;
    assert.equal(await b.handle('moveMouse', { tabId: 1, x: 3, y: 4 }), null);
    host.tabs[0].closed = false;
    host.o.cursor = null;
    assert.equal(await b.handle('moveMouse', { tabId: 1, x: 3, y: 4 }), null);
    assert.equal(host.calls.filter((c: any) => c[0] !== 'create').length, 0);
  });

  test("input waits for the agent cursor to arrive (the plugin's moveMouse glide); a drag's held moves and other commands don't", async () => {
    const { call, tab, host } = await withTab();
    const input = (method: string, commandParams: any) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
    let arrive: () => void = () => {};
    host.o.cursor.arrival = (t: any) => (host.o.cursor.arrivals.push(t.id), new Promise<void>((r) => (arrive = r)));
    const sent = () => tab.sends.filter((c: any) => c[0] === 'Input.dispatchMouseEvent').map((c: any) => c[1].type);
    const press = input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 6 });
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(host.o.cursor.arrivals, ['tab_1']);
    assert.deepEqual(sent(), [], 'the press waits while the pointer is on its way');
    arrive();
    await press;
    assert.deepEqual(sent(), ['mousePressed'], 'and lands once it has arrived');
    host.o.cursor.arrival = async (t: any) => host.o.cursor.arrivals.push(t.id);
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 7, buttons: 1 });
    await input('Input.insertText', { text: 'x' });
    await call('executeCdp', { target: { tabId: 1 }, method: 'Runtime.evaluate', commandParams: { expression: '1' } });
    assert.deepEqual(host.o.cursor.arrivals, ['tab_1', 'tab_1'], 'typing waits too; a held move and a read do not');
    host.o.cursor = null;
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    assert.equal(sent().at(-1), 'mouseMoved', 'no cursor: input goes at once');
  });
}
