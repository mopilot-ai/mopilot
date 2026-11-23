// Browser-script permissions-stop unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScriptOps, createBrowserTools, OriginGrants, ToolError, code, loc, fakeTabs, ops, answers, tool } from './fixture';

export function registerPermissionsStopCases() {
  test("browser_script: calls go through the browser tools' own gates (navigation, read-only sites, JavaScript confirmation)", async () => {
    const t = tool((w) => {
      w.send({ t: 'call', id: 1, op: 'tab.goto', args: { tab: 't1', url: 'https://a.test/next' } });
      w.send({ t: 'call', id: 2, op: 'tab.evaluate', args: { tab: 't1', expression: '1' } });
      w.send({ t: 'call', id: 3, op: 'loc.act', args: { tab: 't1', steps: [], desc: 'x', action: 'click' } });
      setTimeout(() => w.send({ t: 'done', ok: true, value: '1', undef: false }), 20);
    });
    await t.call({ code: 'x' });
    const posted = answers(t.worker()).sort((a: any, b: any) => a.id - b.id);
    assert.deepEqual(posted[0], { id: 1, ok: true, value: { url: 'https://a.test/', title: 'A' } });
    assert.deepEqual(
      t.tabs.called('navigate').map((c: any) => c[1]),
      ['https://a.test/next'],
    );
    // the refusal says why and what to do instead
    assert.equal(posted[1].error.code, 'disabled');
    assert.match(
      posted[1].error.message,
      /^JavaScript is turned off for this chat\.\n<refusal reason="tool_disabled" retryable="false">\nnext: .+\nDo not try to achieve the same outcome/,
    );
    assert.deepEqual(posted[2], { id: 3, ok: true, value: null });
    // a read-only site refuses the click: the click's card (#1319 G22) is answered Read only again
    const ro = tool(
      (w) => {
        w.send({ t: 'call', id: 1, op: 'loc.act', args: { tab: 't1', steps: [], desc: 'x', action: 'click' } });
        setTimeout(() => w.send({ t: 'done', ok: true, value: '1', undef: false }), 20);
      },
      { ask: async () => ({ decision: 'allow', scope: 'once', level: 'read' }) },
    );
    ro.tabs.tab.url = 'https://ro.test/';
    ro.grants.set('https://ro.test', 'read');
    await ro.call({ code: 'x' });
    assert.equal(answers(ro.worker())[0].error.code, 'read_only');
    assert.match(answers(ro.worker())[0].error.message, /<refusal reason="site_read_only" retryable="false">/);
  });

  test('sleep in a stopped turn does not wait (the real pause)', async () => {
    const ac = new AbortController();
    ac.abort();
    const d = createScriptOps({ tabs: fakeTabs(), ctx: { chatId: 'c1', signal: ac.signal }, images: [], deadline: Date.now() + 60_000 });
    const t0 = Date.now();
    assert.equal(await d('sleep', { ms: 30_000 }), null);
    assert.ok(Date.now() - t0 < 1000);
  });

  test('browser_script: a call that starts a new session after one was lost says that earlier variables are gone', async () => {
    const t = tool((w) => w.send({ t: 'done', ok: true, value: '1', undef: false }));
    t.sessions.get('c1').lost = 'a script timed out';
    assert.match(
      (await t.call({ code: 'x' }))[0].text,
      /^Script finished in \d+\.\d s\.\nNote: this call started a new script session, so variables from earlier browser_script calls are gone \(a script timed out\)\.\nResult: 1$/,
    );
    const f = tool((w) => w.send({ t: 'done', ok: false, error: { message: 'boom' } }));
    f.sessions.get('c1').lost = 'its worker stopped';
    await assert.rejects(
      f.call({ code: 'x' }),
      code('script_failed', /^browser_script failed\nboom\nNote: this call started a new script session/),
    );
  });

  test('browser_script is not a batch step', async () => {
    const tabs = fakeTabs();
    const grants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({}) });
    const batch = createBrowserTools({ tabs, grants }).find((x: any) => x.name === 'browser_batch');
    await assert.rejects(
      batch.handler({ actions: [{ name: 'script', input: { code: '1' } }] }, { chatId: 'c1', segmentId: 's1' }),
      code('batch_failed', /browser_script is not a browser tool that can run in a batch/),
    );
  });

  test('a locator click the user approved on a card goes to the element where it is now', async () => {
    // a card was shown (act answers true): the list scrolled while it was open
    const w = ops({ act: async () => true });
    const { d, tabs } = w;
    const boxes = [
      { x: 10, y: 20, w: 4, h: 4 },
      { x: 10, y: 220, w: 4, h: 4 },
    ];
    tabs.impl.locate = async () => (boxes.length > 1 ? boxes.shift() : boxes[0]);
    await d('loc.act', loc({ action: 'click' }));
    assert.deepEqual(tabs.called('click').at(-1)[1], { x: 10, y: 220 });
  });

  test('site risk: every step that changes the page is checked first (act), with what it does', async () => {
    const acts: any[] = [];
    let refuse = false;
    const w = ops({
      act: async (tab: any, a: any) => {
        acts.push([tab.id, a]);
        if (refuse) throw new ToolError('The user did not allow this action (delete something) on https://a.test.', 'denied');
      },
    });
    const { d, tabs } = w;
    await d('loc.act', loc({ action: 'click' }));
    tabs.st = { ...tabs.st, tag: 'input', editable: true };
    await d('loc.act', loc({ action: 'fill', value: 'x' }));
    await d('loc.act', loc({ action: 'type', value: 'abc' }));
    await d('loc.act', loc({ action: 'press', value: 'Enter' }));
    tabs.st = { ...tabs.st, tag: 'select' };
    await d('loc.act', loc({ action: 'select', value: ['a'] }));
    tabs.st = { visible: true, enabled: true, editable: false, checked: false, tag: 'input', type: 'checkbox' };
    tabs.impl.click = async () => {
      tabs.st = { ...tabs.st, checked: true };
    };
    await d('loc.act', loc({ action: 'check', value: true }));
    await d('cua.click', { tab: 't1', x: 3.4, y: 4.6 });
    await d('cua.type', { tab: 't1', text: 'hi' });
    await d('cua.keys', { tab: 't1', keys: 'ctrl+a' });
    await d('cua.drag', {
      tab: 't1',
      path: [
        { x: 1, y: 2 },
        { x: 5, y: 6 },
      ],
    });
    tabs.tab.dialog = { type: 'confirm', message: 'Delete it?' };
    await d('tab.dialog.answer', { tab: 't1', accept: true });
    // hovering, focusing and scrolling only read
    tabs.st = { visible: true, enabled: true, editable: true, checked: null, tag: 'button', type: '' };
    for (const action of ['hover', 'focus', 'scroll']) await d('loc.act', loc({ action }));
    const desc = 'locator("button")';
    assert.deepEqual(
      acts.map(([id, a]) => [id, a]),
      [
        ['t1', { kind: 'click', target: { ref: 'ref_1' }, summary: `click ${desc}`, messageKind: undefined }],
        ['t1', { kind: 'fill', value: 'x', target: { ref: 'ref_1' }, summary: `fill ${desc}` }],
        ['t1', { kind: 'type', text: 'abc', target: { ref: 'ref_1' }, summary: `type into ${desc}` }],
        ['t1', { kind: 'key', keys: 'Enter', target: { ref: 'ref_1' }, summary: `press Enter in ${desc}`, messageKind: undefined }],
        ['t1', { kind: 'select', summary: `choose an option in ${desc}` }],
        ['t1', { kind: 'check', target: { ref: 'ref_1' }, summary: `check ${desc}` }],
        ['t1', { kind: 'click', target: { point: { x: 3.4, y: 4.6 } }, summary: 'click at (3, 5)' }],
        ['t1', { kind: 'type', text: 'hi', summary: 'type 2 characters' }],
        ['t1', { kind: 'key', keys: 'ctrl+a', summary: 'press ctrl+a' }],
        ['t1', { kind: 'drag', target: { point: { x: 1, y: 2 } }, summary: 'drag from (1, 2) to (5, 6)' }],
        ['t1', { kind: 'dialog', accept: true, message: 'Delete it?', summary: 'accept the dialog "Delete it?"' }],
      ],
    );
    // a refusal stops the step before it reaches the page
    refuse = true;
    const clicks = tabs.called('click').length;
    await assert.rejects(d('loc.act', loc({ action: 'click' })), code('denied'));
    await assert.rejects(d('tab.dialog.answer', { tab: 't1', accept: true }), code('denied'));
    assert.equal(tabs.called('click').length, clicks);
    assert.equal(tabs.called('handleDialog').length, 1);
  });

  test('site risk: the page gate may ask (a high-risk site), so steps wait for it', async () => {
    let release: () => void = () => {};
    const gated: string[] = [];
    const tabs = fakeTabs();
    const d = createScriptOps({
      tabs,
      ctx: { chatId: 'c1', segmentId: 's1' },
      images: [],
      deadline: Date.now() + 60_000,
      gate: (_tab: any, need: string) =>
        new Promise<void>((r) => {
          gated.push(need);
          release = r;
        }),
      navigate: async () => '',
      confirmed: async () => {},
    });
    let done = false;
    const p = d('tab.domSnapshot', { tab: 't1' }).then((v: any) => ((done = true), v));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([gated, done, tabs.called('readPage').length], [['read'], false, 0]);
    release();
    assert.equal(await p, '- button "Go" [ref_1]');
  });
}
