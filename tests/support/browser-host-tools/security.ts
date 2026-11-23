// Site-risk confirmations, credentials and stale-permission cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { browserToolSpecs, OriginGrants, ToolError, world, first, endsWithState, code } from './fixture';
import { DONE_CONTINUE, HANDOFF_CONTINUES } from '../../../shared/doneContinue.mjs';

const { CREDENTIAL_FIELD } = createRequire(import.meta.url)('../../../electron/capabilities/browser/userTurn.cjs');

export function registerSecurityCases() {
  // ---------------------------------------------------------------- site risk and secure sign-in (IAB-03, IAB-05)

  /** The tools over a real OriginGrants that records site cards (st.asks) and per-action cards (st.confirms). */
  function riskWorld() {
    const st: any = {
      asks: [] as any[],
      confirms: [] as any[],
      answer: { decision: 'allow', scope: 'chat', level: 'write' },
      ok: true,
      anchor: 'ask',
    };
    const grants = new OriginGrants({
      file: null,
      anchor: () => st.anchor,
      // a card's signal (#1865) is not part of what it shows
      ask: async ({ signal: _signal, ...q }: any) => (st.asks.push(q), st.answer),
      confirmAction: async ({ signal: _signal, ...q }: any) => (st.confirms.push(q), st.ok),
    });
    grants.set('https://a.example', 'write');
    return { ...world({ grants }), st };
  }

  test('high-risk pages: reading asks in this chat first (Full access too), every action asks, a blocked page refuses', async () => {
    const w = riskWorld();
    w.st.anchor = 'full';
    w.tabs.tab.url = 'https://www.chase.com/accounts';
    assert.match(first(await w.call('browser_read_page')), /^Page t1/);
    assert.deepEqual(
      [w.st.asks.length, w.st.asks[0].risk.category, w.st.asks[0].allowAlways, w.st.asks[0].need],
      // the card may save it for good (#5464); this chat's answer is "once"/"chat" here
      [1, 'banking', undefined, 'write'],
    );
    await w.call('browser_get_page_text');
    assert.equal(w.st.asks.length, 1, 'allowed for this chat now');
    // each action asks, naming what it does
    await w.call('browser_computer', { action: 'left_click', coordinate: [5, 6] });
    await w.call('browser_computer', { action: 'double_click', ref: 'ref_1' });
    assert.deepEqual(
      w.st.confirms.map((c: any) => [c.tool, c.summary, c.sensitive, c.risk.category]),
      [
        ['click', 'left click at (5, 6)', null, 'banking'],
        ['click', 'double click "Submit"', null, 'banking'],
      ],
    );
    assert.deepEqual(
      w.tabs.called('intent').map((c: any) => c[1]),
      [{ point: { x: 5, y: 6 } }, { ref: 'ref_1' }],
    );
    w.st.ok = false;
    await assert.rejects(
      w.call('browser_computer', { action: 'left_click', coordinate: [5, 6] }),
      code('denied', /Banking site: high risk/),
    );
    assert.equal(w.tabs.called('click').length, 2);
    // drags, keys, form input and JavaScript ask too (JavaScript once, even with Full access)
    w.st.ok = true;
    w.st.confirms.length = 0;
    await w.call('browser_computer', { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] });
    await w.call('browser_computer', { action: 'key', text: 'Tab' });
    await w.call('browser_computer', { action: 'type', text: 'a' });
    await w.call('browser_form_input', { ref: 'ref_3', value: 'x' });
    await w.call('browser_javascript_exec', { text: 'document.title' });
    assert.deepEqual(
      w.st.confirms.map((c: any) => [c.tool, c.summary]),
      [
        ['drag', 'drag from (1, 2) to (3, 4)'],
        ['key', 'press Tab'],
        ['type', 'type 1 character'],
        ['fill', 'set ref_3'],
        ['JavaScript', 'JavaScript: document.title'],
      ],
    );
    // hovering and scrolling only read
    await w.call('browser_computer', { action: 'scroll' });
    assert.equal(w.st.confirms.length, 5);
    // a blocked page: nothing reads or acts on it
    w.tabs.tab.url = 'http://169.254.169.254/latest/';
    await assert.rejects(w.call('browser_read_page'), code('blocked', /^Cloud metadata endpoint/));
    await assert.rejects(w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }), code('blocked'));
  });

  test('password fields refuse agent typing; Enter and clicks there are fine', async () => {
    const w = riskWorld();
    w.tabs.intentValue = { tag: 'input', name: 'Password', secret: true, editable: true, button: false };
    await assert.rejects(
      w.call('browser_computer', { action: 'type', text: 'hunter2' }),
      code(
        'password_field',
        /^"Password" is a password field: agents never type passwords\. Call browser_request_signin so the user signs in themselves\.$/,
      ),
    );
    await assert.rejects(w.call('browser_computer', { action: 'key', text: 'h' }), code('password_field'));
    w.tabs.intentValue = { tag: 'input', name: '', secret: true };
    await assert.rejects(
      w.call('browser_form_input', { ref: 'ref_2', value: 'pw' }),
      code('password_field', /^This field is a password field/),
    );
    assert.equal(w.tabs.called('typeText').length + w.tabs.called('keys').length + w.tabs.called('formInput').length, 0);
    assert.deepEqual(
      w.tabs.called('intent').map((c: any) => c[1]),
      [{}, {}, { ref: 'ref_2' }],
    );
    await w.call('browser_computer', { action: 'key', text: 'Enter' });
    await w.call('browser_computer', { action: 'left_click', ref: 'ref_2' });
    assert.equal(w.tabs.called('keys').length, 1);
    assert.equal(w.st.confirms.length, 0);
    // keys that type nothing don't look at the element
    const before = w.tabs.called('intent').length;
    await w.call('browser_computer', { action: 'key', text: 'Tab' });
    assert.equal(w.tabs.called('intent').length, before);
  });

  test('a click or drag the user approved on a card goes to the element where it is now, not where it was before the card', async () => {
    const w = world();
    const at = [
      { x: 10, y: 20, name: 'Delete item 3' },
      { x: 10, y: 220, name: 'Delete item 3' },
    ];
    w.tabs.impl.point = async (_tab: any, _st: any, target: any) =>
      target.ref ? (at.length > 1 ? at.shift() : at[0]) : { x: target.coordinate[0], y: target.coordinate[1] };
    // a card is shown (a sensitive action): the list scrolled under it
    w.grants.act = async () => true;
    await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
    assert.deepEqual(w.tabs.called('click').at(-1)[1], { x: 10, y: 220, name: 'Delete item 3' });
    at.splice(0, at.length, { x: 5, y: 5, name: 'Item' }, { x: 5, y: 300, name: 'Item' });
    await w.call('browser_computer', { action: 'left_click_drag', start_coordinate: [1, 2], ref: 'ref_1' });
    assert.deepEqual(w.tabs.called('drag').at(-1)[2], { x: 5, y: 300, name: 'Item' });
    // no card: the element is found once, and clicked there
    w.grants.act = async () => false;
    const before = w.tabs.called('point').length;
    await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
    assert.equal(w.tabs.called('point').length - before, 1);
    // a coordinate is what the card named: it stays
    w.grants.act = async () => true;
    await w.call('browser_computer', { action: 'left_click', coordinate: [7, 8] });
    assert.deepEqual(w.tabs.called('click').at(-1)[1], { x: 7, y: 8 });
    delete w.grants.act;
  });

  test('every question to the user waits through tabs.awaitUser for its tab, so the action keeps its place and time', async () => {
    const w = riskWorld();
    const waits = () => w.tabs.called('awaitUser').map((c: any) => c[0]);
    // a read on a high-risk page, then an action on it, and its JavaScript
    w.tabs.tab.url = 'https://www.chase.com/accounts';
    await w.call('browser_read_page');
    await w.call('browser_computer', { action: 'left_click', coordinate: [5, 6] });
    await w.call('browser_javascript_exec', { text: '1' });
    assert.deepEqual([w.st.asks.length, w.st.confirms.length], [1, 2]);
    // a navigation to a new site, and the site a redirect lands on
    w.tabs.tab.url = 'https://a.example/page';
    w.tabs.impl.navigate = async () => ({ url: 'https://c.example/landing', title: '' });
    await w.call('browser_navigate', { url: 'https://b.example/' });
    assert.equal(w.st.asks.length, 3);
    assert.equal(waits().length, 5);
    assert.ok(waits().every((tab: any) => tab === w.tabs.tab));
    // each wait carries the call's signal, so a call that ends stops waiting
    const signal = new AbortController().signal;
    w.tabs.tab.url = 'https://a.example/page';
    await w.call('browser_navigate', { url: 'https://d.example/' }, { ...w.ctx, signal });
    assert.equal(w.tabs.called('awaitUser').at(-1)[2], signal);
    // the JavaScript card of an ordinary site
    const c = world({ confirm: async () => true });
    await c.call('browser_javascript_exec', { text: '1' });
    assert.deepEqual(
      c.tabs.called('awaitUser').map((x: any) => x[0]),
      [c.tabs.tab],
    );
    // a refusal on the card still reaches the caller through the wait
    w.tabs.impl.awaitUser = async () => {
      throw new ToolError('Tab t1 moved to https://x.example/ while the user was being asked.', 'tab_changed');
    };
    w.tabs.tab.url = 'https://www.chase.com/accounts';
    const clicks = w.tabs.called('click').length;
    await assert.rejects(w.call('browser_computer', { action: 'left_click', coordinate: [5, 6] }), code('tab_changed'));
    assert.equal(w.tabs.called('click').length, clicks, 'no click after the tab changed under the card');
  });

  test('typing after a card looks at the focus again: it may have moved to a password field meanwhile', async () => {
    const w = riskWorld();
    w.tabs.tab.url = 'https://www.chase.com/accounts';
    await w.call('browser_read_page');
    const focus = [
      { tag: 'input', name: 'Search', secret: false },
      { tag: 'input', name: 'Password', secret: true },
    ];
    w.tabs.impl.intent = async () => focus.shift() ?? null;
    await assert.rejects(
      w.call('browser_computer', { action: 'type', text: 'hunter2' }),
      code('password_field', /^The focus moved to a password field while the user was being asked: agents never type passwords\./),
    );
    assert.equal(w.st.confirms.length, 1, 'asked once');
    assert.equal(w.tabs.called('typeText').length, 0);
    // still the same field after the card: typed
    w.tabs.impl.intent = async () => ({ tag: 'input', name: 'Search', secret: false });
    await w.call('browser_computer', { action: 'type', text: 'abc' });
    assert.equal(w.tabs.called('typeText').length, 1);
    // no card (an ordinary site): the focus is read once
    const plain = riskWorld();
    await plain.call('browser_computer', { action: 'type', text: 'abc' });
    assert.equal(plain.tabs.called('intent').length, 1);
  });

  test('sensitive actions ask on any site, naming the element once; dialogs that confirm a delete ask too', async () => {
    const w = riskWorld();
    w.tabs.intentValue = { tag: 'button', role: 'button', name: 'Delete repository', button: true };
    await w.call('browser_computer', { action: 'left_click', coordinate: [9, 9] });
    let c = w.st.confirms.pop();
    assert.deepEqual(
      [c.origin, c.tool, c.summary, c.sensitive.kind, c.risk],
      ['https://a.example', 'click', 'left click at (9, 9) ("Delete repository")', 'delete', undefined],
    );
    // the name already in the summary isn't repeated; a nameless submit of a card form is named by the summary only
    w.tabs.intentValue = {
      tag: 'button',
      name: 'Submit',
      button: true,
      submits: true,
      form: { secrets: 0, newPassword: false, payment: true, submit: 'Submit' },
    };
    await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
    c = w.st.confirms.pop();
    assert.deepEqual([c.summary, c.sensitive.verb], ['left click "Submit"', 'submit payment details']);
    w.tabs.intentValue = {
      tag: 'button',
      name: '',
      button: true,
      submits: true,
      form: { secrets: 0, newPassword: false, payment: true, submit: '' },
    };
    await w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] });
    assert.equal(w.st.confirms.pop().summary, 'left click at (1, 1)');
    // a "no" stops it before the click
    w.st.ok = false;
    const clicks = w.tabs.called('click').length;
    await assert.rejects(
      w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
      code('denied', /^The user did not allow this action \(submit payment details\) on https:\/\/a\.example\.$/),
    );
    assert.equal(w.tabs.called('click').length, clicks);
    w.st.confirms.length = 0;
    // dialogs: accepting "Delete?" asks; dismissing it, or accepting with no dialog, doesn't
    w.st.ok = true;
    w.tabs.tab.dialog = { type: 'confirm', message: 'Delete 3 files?' };
    await w.call('browser_handle_dialog', { accept: true });
    c = w.st.confirms.pop();
    assert.deepEqual([c.tool, c.summary, c.sensitive.kind], ['dialog', 'accept the dialog "Delete 3 files?"', 'delete']);
    await w.call('browser_handle_dialog', { accept: false });
    w.tabs.tab.dialog = null;
    await w.call('browser_handle_dialog', { accept: true });
    assert.equal(w.st.confirms.length, 0);
  });

  test('browser_request_signin (#1834): hands the tab over and returns at once; "Sign in to" only for a page that asks for a credential', async () => {
    const w = world();
    const host = new URL(w.tabs.tab.url).host;
    // a page that can't be read (no CDP here) counts as not asking: "Your turn on"
    const out = await w.call('browser_request_signin', { reason: 'GitHub' });
    assert.equal(
      first(out),
      `Handed t1 to the user ("Your turn on ${host}"). ${HANDOFF_CONTINUES} Tab t1 is at https://a.example/page (A page).`,
    );
    endsWithState(out);
    const [tab, opts] = w.tabs.called('requestSignin')[0];
    assert.deepEqual([tab.id, opts.reason, opts.credential], ['t1', 'GitHub', false]);
    await w.call('browser_request_signin', {});
    assert.equal(w.tabs.called('requestSignin')[1][1].reason, '');
    // a password or one-time-code field: "Sign in to"
    w.tabs.tab.send = async (method: string, params: any) => {
      assert.deepEqual([method, params.expression], ['Runtime.evaluate', CREDENTIAL_FIELD]);
      return { result: { value: true } };
    };
    assert.match(first(await w.call('browser_request_signin', {})), new RegExp(`\\("Sign in to ${host.replace('.', '\\.')}"\\)`));
    assert.equal(w.tabs.called('requestSignin')[2][1].credential, true);
    w.tabs.tab.send = async () => ({ result: { value: false } });
    assert.match(first(await w.call('browser_request_signin', {})), /\("Your turn on /);
    // an identity provider's page needs no read
    w.tabs.tab.url = 'https://accounts.google.com/signin';
    assert.match(first(await w.call('browser_request_signin', {})), /\("Sign in to accounts\.google\.com"\)/);
    w.tabs.tab.url = 'about:blank';
    await assert.rejects(w.call('browser_request_signin', {}), code('bad_args', /^Open the sign-in page in t1 first/));
    const spec = browserToolSpecs().find((s: any) => s.name === 'browser_request_signin');
    assert.equal(spec.policy, 'observe');
    // the model is told the button's real label, and that its turn ends
    assert.ok(spec.description.includes(`"${DONE_CONTINUE}"`));
    assert.ok(spec.description.endsWith(HANDOFF_CONTINUES));
  });

  test('credential-bearing pages ask on each read and retain a denial even with prior grants', async () => {
    const w = riskWorld();
    w.st.anchor = 'full';
    w.tabs.tab.url = 'https://bob:secret@example.com/page';
    await w.call('browser_read_page', {});
    assert.equal(w.st.asks.length, 1);
    assert.equal(w.st.asks[0].risk.credentials, true);
    w.st.answer = { decision: 'deny' };
    await assert.rejects(w.call('browser_read_page', {}), code('denied'));
    assert.equal(w.st.asks.length, 2);
    await assert.rejects(w.call('browser_read_page', {}), code('denied'));
    assert.equal(w.st.asks.length, 2);
    assert.equal(w.tabs.called('readPage').length, 1);
  });

  test('page actions recheck switches and saved permissions after inspecting their target', async () => {
    for (const change of ['disabled', 'read-only-site']) {
      let enabled = true;
      const w = world({ enabled: () => enabled });
      w.tabs.impl.intent = async () => {
        if (change === 'disabled') enabled = false;
        else w.grants.set('https://a.example', 'read');
        return null;
      };
      await assert.rejects(
        w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
        code(change === 'disabled' ? 'disabled' : 'read_only'),
      );
      assert.equal(w.tabs.called('click').length, 0);
    }
  });

  test('JavaScript confirmation cannot override later browser or site permission changes', async () => {
    for (const change of ['disabled', 'read-only-chat', 'read-only-site', 'blocked-page']) {
      let enabled = true;
      const w = world({
        enabled: () => enabled,
        confirm: async () => {
          if (change === 'disabled') enabled = false;
          else if (change === 'read-only-chat') w.st.anchor = 'readOnly';
          else if (change === 'blocked-page') w.tabs.tab.url = 'http://169.254.169.254/';
          else w.grants.set('https://a.example', 'read');
          return true;
        },
      });
      await assert.rejects(
        w.call('browser_javascript_exec', { text: '42' }),
        code(change === 'disabled' ? 'disabled' : change === 'blocked-page' ? 'blocked' : 'read_only'),
      );
      assert.equal(w.tabs.called('exec').length, 0);
    }
  });

  test('disabling browser control during sensitive-action confirmation prevents the click', async () => {
    let enabled = true;
    const w = world({ enabled: () => enabled });
    w.tabs.intentValue = { tag: 'button', role: 'button', name: 'Delete repository', button: true };
    w.grants.confirmAction = async () => {
      enabled = false;
      return true;
    };
    await assert.rejects(w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }), code('disabled'));
    assert.equal(w.tabs.called('click').length, 0);
  });
}
