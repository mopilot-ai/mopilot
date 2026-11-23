// Form, JavaScript confirmation, console, network and dialog cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from '../defined';
import { registerBrowserTools, world, first, endsWithState, code } from './fixture';

export function registerPageOperationsCases() {
  // ---------------------------------------------------------------- forms, JavaScript, console, network

  test('browser_form_input sets a field by ref or target.ref', async () => {
    const w = world();
    let out = await w.call('browser_form_input', { ref: 'ref_1', value: 'x' });
    assert.equal(first(out), 'Set ref_1 to "x". Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('formInput'), [[w.tabs.tab, 'ref_1', 'x']]);
    assert.deepEqual(w.tabs.called('settle'), [[w.tabs.tab, { grace: 100 }]]);
    out = await w.call('browser_form_input', { target: { ref: 'ref_2' }, value: true });
    assert.equal(first(out), 'Set ref_2 to true. Tab t1 is at https://a.example/page (A page).');
    endsWithState(out);
  });

  test('browser_javascript_exec asks for confirmation and runs only when allowed', async () => {
    const asked: any[] = [];
    let ok = true;
    const w = world({ confirm: async (ctx: any, req: any) => (asked.push([ctx, req]), ok) });
    let out = await w.call('browser_javascript_exec', { text: 'document\n.title' });
    assert.equal(first(out), '42');
    endsWithState(out);
    // the call's own context: the chat and segment the card is for
    assert.deepEqual(
      asked.map(([c, req]: any[]) => [{ chatId: c.chatId, segmentId: c.segmentId }, req]),
      [[w.ctx, { tool: 'JavaScript', origin: 'https://a.example', summary: 'document .title' }]],
    );
    assert.deepEqual(w.tabs.called('exec'), [[w.tabs.tab, 'document\n.title']]);
    assert.deepEqual(w.tabs.called('settle'), [[w.tabs.tab, { grace: 100 }]]);

    // the next turn asks again
    w.ctx.segmentId = 's2';
    ok = false;
    await assert.rejects(w.call('browser_javascript_exec', { text: '1' }), code('denied', /^The user did not allow this\.$/));
    assert.equal(w.tabs.called('exec').length, 1);

    // a page without an http origin is named "this page"; long output is truncated
    ok = true;
    w.tabs.tab.url = 'about:blank';
    w.tabs.impl.exec = async () => 'x'.repeat(50001);
    out = await w.call('browser_javascript_exec', { text: '1' });
    assert.equal(defined(asked.at(-1))[1].origin, 'this page');
    assert.equal(first(out), `${'x'.repeat(50000)}\n[Result truncated at 50,000 characters.]`);
  });

  test('a yes to JavaScript covers that site for the rest of the turn, not other sites, uploads or the next turn', async () => {
    const asked: any[] = [];
    const w = world({ confirm: async (_ctx: any, req: any) => (asked.push(req.origin), true) });
    await w.call('browser_javascript_exec', { text: '1' });
    await w.call('browser_javascript_exec', { text: '2' });
    assert.deepEqual(asked, ['https://a.example']);
    assert.equal(w.tabs.called('exec').length, 2);
    // a change made by the page between runs is still gated
    w.st.anchor = 'readOnly';
    await assert.rejects(w.call('browser_javascript_exec', { text: '3' }), code('read_only'));
    w.st.anchor = undefined;
    // another site asks, and the first stays allowed
    w.tabs.tab.url = 'https://b.example/';
    await w.call('browser_javascript_exec', { text: '4' });
    w.tabs.tab.url = 'https://a.example/';
    await w.call('browser_javascript_exec', { text: '5' });
    assert.deepEqual(asked, ['https://a.example', 'https://b.example']);
    // a page without an origin is asked every time
    w.tabs.tab.url = 'about:blank';
    await w.call('browser_javascript_exec', { text: '6' });
    await w.call('browser_javascript_exec', { text: '7' });
    assert.deepEqual(asked.slice(2), ['this page', 'this page']);
    // a new turn asks again
    w.tabs.tab.url = 'https://a.example/';
    w.ctx.segmentId = 's2';
    await w.call('browser_javascript_exec', { text: '8' });
    assert.equal(asked.length, 5);
  });

  test('the next turn of the same thread asks again for JavaScript: a yes is for the turn it was given in', async () => {
    const registered = new Map<string, any>();
    const registry = { register: (t: any) => (registered.set(t.name, t), () => registered.delete(t.name)) };
    const asked: string[] = [];
    const w = world();
    const listeners = new Set<(chatId: string) => void>();
    w.tabs.onTurnEnd = (fn: any) => (listeners.add(fn), () => listeners.delete(fn));
    registerBrowserTools(registry, {
      tabs: w.tabs,
      grants: w.grants,
      confirm: async (_ctx: any, req: any) => (asked.push(req.origin), true),
      sessions: { end: () => undefined, endAll: () => undefined } as any,
      snapshots: { reset: () => undefined } as any,
    });
    const run = (text: string) => registered.get('browser_javascript_exec').handler({ text }, w.ctx);
    await run('1');
    await run('2');
    assert.deepEqual(asked, ['https://a.example']);
    // the turn ends; the thread (segment) is the same in the next one
    for (const fn of listeners) fn('c1');
    await run('3');
    assert.deepEqual(asked, ['https://a.example', 'https://a.example']);
    // another chat's turn ending leaves this one's yes alone
    for (const fn of listeners) fn('other');
    await run('4');
    assert.equal(asked.length, 2);
  });

  test('browser_javascript_exec without a confirm callback is disabled; Full access skips the confirmation', async () => {
    const w = world();
    await assert.rejects(w.call('browser_javascript_exec', { text: '1' }), code('disabled', /^JavaScript is turned off for this chat\.$/));
    assert.equal(w.tabs.called('exec').length, 0);

    let asked = 0;
    const w2 = world({ confirm: async () => (asked++, false) });
    w2.st.anchor = 'full';
    assert.equal(first(await w2.call('browser_javascript_exec', { text: '1' })), '42');
    assert.equal(asked, 0);
    w2.st.anchor = 'ask';
    await assert.rejects(w2.call('browser_javascript_exec', { text: '1' }), code('denied'));
    assert.equal(asked, 1);
  });

  test('when the grants anchor throws, Full access is off and the page gate names non-http pages by URL', async () => {
    let verdict = 'ok';
    const grants = {
      anchor: () => {
        throw new Error('chat gone');
      },
      peek: () => verdict,
      require: async () => {},
      riskOf: () => ({ level: 'normal' }),
      act: async () => {},
    };
    const w = world({ grants });
    await assert.rejects(w.call('browser_javascript_exec', { text: '1' }), code('disabled'));
    let asked = 0;
    const w2 = world({ grants, confirm: async () => (asked++, true) });
    assert.equal(first(await w2.call('browser_javascript_exec', { text: '1' })), '42');
    assert.equal(asked, 1);

    w2.tabs.tab.url = 'file:///etc/hosts';
    verdict = 'denied';
    await assert.rejects(w2.call('browser_read_page'), code('denied', /^The user did not allow file:\/\/\/etc\/hosts in this chat\.$/));
    verdict = 'read_only';
    await assert.rejects(
      w2.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
      code('read_only', /^file:\/\/\/etc\/hosts is read only/),
    );
  });

  test('browser_read_console_messages: empty, errors only, and formatted entries', async () => {
    const w = world();
    let out = await w.call('browser_read_console_messages');
    assert.equal(first(out), 'No console messages in t1 (messages are kept from when browser control first reached the tab).');
    assert.deepEqual(w.tabs.called('console')[0], [w.tabs.tab, { onlyErrors: false, pattern: null, limit: 100 }]);
    assert.deepEqual(w.tabs.called('ready')[0][2], { allowDialog: true });
    out = await w.call('browser_read_console_messages', { onlyErrors: true, pattern: 'boom', limit: 5 });
    assert.equal(first(out), 'No console messages with errors in t1 (messages are kept from when browser control first reached the tab).');
    assert.deepEqual(w.tabs.called('console')[1][1], { onlyErrors: true, pattern: 'boom', limit: 5 });

    const at = Date.UTC(2026, 0, 1, 12, 34, 56, 789);
    w.tabs.impl.console = () => [
      { at, level: 'error', text: 'boom\nline', source: 'app.js:1' },
      { at, level: 'log', text: 'hi' },
    ];
    out = await w.call('browser_read_console_messages');
    assert.equal(first(out), '[12:34:56.789] error: boom line (app.js:1)\n[12:34:56.789] log: hi');
    endsWithState(out);
  });

  test('browser_read_network_requests lists requests with redacted URLs', async () => {
    const w = world();
    let out = await w.call('browser_read_network_requests');
    assert.equal(first(out), 'No network requests in t1 (requests are kept from when browser control first reached the tab).');
    assert.deepEqual(w.tabs.called('requests')[0], [w.tabs.tab, { urlPattern: null, limit: 100 }]);
    assert.deepEqual(w.tabs.called('ready')[0][2], { allowDialog: true });
    out = await w.call('browser_read_network_requests', { urlPattern: 'api', limit: 7 });
    assert.equal(first(out), 'No network requests match in t1 (requests are kept from when browser control first reached the tab).');
    assert.deepEqual(w.tabs.called('requests')[1][1], { urlPattern: 'api', limit: 7 });

    w.tabs.impl.requests = () => [
      { id: 'r1', method: 'GET', status: 200, type: 'Document', url: 'https://u:p@a.example/x?token=abc&q=1', ms: 12 },
      { id: 'r2', method: 'POST', error: 'net::ERR_FAILED', type: '', url: 'https://a.example/y' },
      { id: 'r3', method: 'GET', status: null, type: 'XHR', url: 'https://a.example/z', ms: null },
    ];
    out = await w.call('browser_read_network_requests');
    assert.equal(
      first(out),
      'r1 GET 200 Document https://a.example/x?token=REDACTED&q=1 12ms\nr2 POST failed (net::ERR_FAILED) - https://a.example/y\nr3 GET pending XHR https://a.example/z',
    );
    endsWithState(out);
  });

  test('browser_read_network_requests returns one response body, redacted and truncated', async () => {
    const w = world();
    w.tabs.impl.responseBody = async () => ({
      request: { method: 'GET', url: 'https://a.example/x?key=1&a=2', status: 200, mime: 'text/plain' },
      body: 'hi',
    });
    let out = await w.call('browser_read_network_requests', { requestId: 7 });
    assert.deepEqual(w.tabs.called('responseBody')[0], [w.tabs.tab, '7']);
    assert.equal(first(out), 'GET https://a.example/x?key=REDACTED&a=2 → 200 text/plain\n\nhi');
    assert.equal(w.tabs.called('requests').length, 0);

    w.tabs.impl.responseBody = async () => ({
      request: { method: 'POST', url: 'https://a.example/y', mime: 'application/json' },
      body: 'b'.repeat(50001),
    });
    out = await w.call('browser_read_network_requests', { requestId: 'r2' });
    assert.equal(
      first(out),
      `POST https://a.example/y → ? application/json\n\n${'b'.repeat(50000)}\n[Body truncated at 50,000 characters.]`,
    );
  });

  test('browser_resize_window needs width and height or a preset', async () => {
    const w = world();
    await assert.rejects(w.call('browser_resize_window', {}), code('bad_args', /Give width and height, or a preset/));
    await assert.rejects(w.call('browser_resize_window', { width: 10 }), code('bad_args'));
    assert.equal(w.tabs.called('resize').length, 0);
    let out = await w.call('browser_resize_window', { preset: 'mobile' });
    assert.equal(first(out), 'Resized. Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('resize')[0], [w.tabs.tab, { preset: 'mobile' }]);
    out = await w.call('browser_resize_window', { width: 10, height: 20 });
    assert.deepEqual(w.tabs.called('resize')[1][1], { width: 10, height: 20 });
    endsWithState(out);
  });

  test('browser_handle_dialog answers without queueing behind the blocked action', async () => {
    const w = world();
    let out = await w.call('browser_handle_dialog', { accept: true, promptText: 'hi' });
    assert.equal(first(out), 'Accepted the dialog. Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('handleDialog')[0], [w.tabs.tab, true, 'hi', null]);
    assert.deepEqual(w.tabs.called('ready')[0], [w.tabs.tab, 'c1', { allowDialog: true }]);
    assert.equal(w.tabs.called('run').length, 0);
    out = await w.call('browser_handle_dialog', {});
    assert.deepEqual(w.tabs.called('handleDialog')[1], [w.tabs.tab, false, undefined, null]);
    assert.match(first(out), /^Dismissed the dialog\./);
    endsWithState(out);
    // a page dialog of MoPilot's: the answer goes only to the one the approval was about
    w.tabs.tab.dialog = { type: 'confirm', message: 'Sure?', own: 4 };
    await w.call('browser_handle_dialog', { accept: true });
    assert.equal(w.tabs.called('handleDialog')[2][3], 4);
  });
}
