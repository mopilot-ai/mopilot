// Site-permission contract unit cases for chrome-writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromeTools,
  chromeActionCheck,
  actionsOf,
  dialogMessage,
  parsedIntent,
  ELEMENT_INTENT,
  FOCUS_INTENT,
  ToolError,
  guarded,
  ctx,
  grantsFor,
  Window,
} from './fixture.ts';

export function registerChromeWrites() {
  function chromeInst(intent: any, snapshot = '') {
    const calls: any[] = [];
    const inst: any = {
      url: 'https://shop.test/',
      needsSnapshot: false,
      async call(name: string, args: any) {
        calls.push([name, args]);
        if (name === 'browser_evaluate')
          return { content: [{ type: 'text', text: `### Result\n${JSON.stringify({ mopilot_intent: true, ...intent }, null, 2)}\n` }] };
        return { content: [{ type: 'text', text: `Page URL: ${inst.url}\n${snapshot}` }] };
      },
    };
    return { inst, calls };
  }

  async function chromeWrite(name: string, args: any, intent: any, snapshot = '') {
    const { g, confirmed } = grantsFor('chrome');
    const { inst, calls } = chromeInst(intent, snapshot);
    const [tool] = chromeTools({
      channel: { instance: async () => inst },
      grants: g,
      schemas: [{ name, inputSchema: { type: 'object', properties: {} } }],
    });
    let error: any = null;
    try {
      await tool.handler(args, ctx);
    } catch (e) {
      error = e;
    }
    return { confirmed, calls, error };
  }

  test('CM-P04: Your Chrome asks for sensitive submits, payment entries and dialog accepts, and refuses typing a password', async () => {
    const payForm = { editable: true, form: { payment: true, secrets: 0, newPassword: false, submit: 'Pay now' } };
    // Enter in a payment form, typing with submit, and a payment field in a form fill: each asks
    for (const [name, args, intent] of [
      ['browser_press_key', { key: 'Enter' }, payForm],
      ['browser_type', { target: 'e2', text: '12', submit: true }, payForm],
      ['browser_fill_form', { fields: [{ target: 'e3', type: 'textbox', value: '4242' }] }, { editable: true, payment: true }],
    ] as const) {
      const r = await chromeWrite(name, args, intent);
      assert.equal(r.error, null, `${name}: allowed after the card`);
      assert.equal(r.confirmed.length, 1, `${name} asks`);
      assert.equal(r.confirmed[0].browser, 'chrome');
    }
    // while a dialog is open Chrome can take no snapshot: the answer reads the dialog Chrome last named, and still asks
    {
      const { g, confirmed } = grantsFor('chrome');
      const calls: string[] = [];
      const modal = '### Modal state\n- ["confirm" dialog with message "Delete this repository?"]: can be handled by browser_handle_dialog';
      const inst: any = {
        url: 'https://shop.test/',
        needsSnapshot: false,
        async call(name: string) {
          calls.push(name);
          if (name === 'browser_click') return { content: [{ type: 'text', text: `Page URL: ${inst.url}\n${modal}` }] };
          return { content: [{ type: 'text', text: `Page URL: ${inst.url}` }] };
        },
      };
      const tools = chromeTools({
        channel: { instance: async () => inst },
        grants: g,
        schemas: [{ name: 'browser_click' }, { name: 'browser_handle_dialog' }],
      });
      await tools[0].handler({ target: 'e1', element: 'Remove' }, ctx);
      assert.equal(inst.modalStates.length, 1, 'the click left a dialog open');
      const before = confirmed.length;
      await tools[1].handler({ accept: true }, ctx);
      assert.equal(confirmed.length, before + 1);
      assert.equal(confirmed.at(-1).sensitive.verb, 'delete something');
      assert.equal(confirmed.at(-1).browser, 'chrome', "the answer goes through Your Chrome's own table");
      assert.equal(calls.at(-1), 'browser_handle_dialog');
      // no dialog seen: nothing sensitive to ask about
      inst.modalStates = undefined;
      await tools[1].handler({ accept: true }, ctx);
      assert.equal(confirmed.length, before + 1);
    }
    // dismissing it doesn't
    assert.equal((await chromeWrite('browser_handle_dialog', { accept: false }, {}, 'dialog with message "Delete?"')).confirmed.length, 0);
    // a password field refuses typing, before any card
    const pw = await chromeWrite('browser_type', { target: 'e4', text: 'hunter2' }, { editable: true, secret: true });
    assert.equal(pw.error?.code, 'password_field');
    assert.match(pw.error.message, /browser="chrome"/);
    assert.match(pw.error.message, /sign in themselves in their Chrome/);
    // an ordinary click asks nothing; an unreadable page falls back to the element description
    assert.equal(
      (await chromeWrite('browser_click', { target: 'e5', element: 'Next' }, { button: true, name: 'Next' })).confirmed.length,
      0,
    );
    const { inst } = chromeInst({});
    inst.call = async () => ({ isError: true, content: [] });
    assert.equal((await chromeActionCheck(inst, 'browser_click', { element: 'Delete repo' }, '')).sensitive.verb, 'delete something');
    // a call that throws, or a result without text, reads as an unreadable page
    inst.call = async () => {
      throw new Error('gone');
    };
    assert.equal((await chromeActionCheck(inst, 'browser_type', { target: 'e1', text: 'x' }, '')).password, false);
    inst.call = async () => ({ content: [{ type: 'text' }] });
    assert.equal((await chromeActionCheck(inst, 'browser_press_key', { key: 'Enter' }, '')).sensitive, null);
    // a stopped call's refusal (PlaywrightInstance.call) stops the check instead of reading as an unreadable page
    const ac = new AbortController();
    ac.abort();
    inst.call = async () => {
      throw new ToolError('Stopped by the user before evaluate in your Chrome', 'stopped');
    };
    await assert.rejects(
      guarded({ signal: ac.signal }, () => chromeActionCheck(inst, 'browser_click', { target: 'e1' }, '')),
      (e: any) => e.code === 'stopped',
    );
  });

  test('CM-P04b: the intent function reads the page as the page agent does', () => {
    const win = new Window({ url: 'https://shop.test/' });
    const doc = win.document;
    doc.body.innerHTML = `<form><input id="cc" name="cardnumber" aria-label="Card number"><input id="pw" type="password">
    <button id="go">Pay now</button></form><div><textarea id="msg"></textarea><button>Send</button></div>`;
    const read = new win.Function(`return (${ELEMENT_INTENT})`)();
    const card = read(doc.getElementById('cc'));
    assert.equal(card.payment, true);
    assert.equal(card.editable, true);
    assert.deepEqual(JSON.parse(JSON.stringify(card.form)), {
      secrets: 1,
      newPassword: false,
      payment: true,
      submit: 'Pay now',
      action: 'https://shop.test/',
    });
    assert.equal(read(doc.getElementById('pw')).secret, true);
    const go = read(doc.getElementById('go'));
    assert.equal(go.button, true);
    assert.equal(go.submits, true);
    doc.getElementById('go')!.setAttribute('formaction', '/notes');
    assert.equal(read(doc.getElementById('go')).form.action, 'https://shop.test/notes');
    // Enter in a field goes through the default button, also one outside the form; a field named "action" hides nothing (#3879 review)
    const extra = doc.createElement('div');
    extra.innerHTML =
      '<button id="out" form="f2" formaction="https://evil.test/x">Go</button><form id="f2" action="/ok"><input id="q" name="action"></form>';
    doc.body.append(extra);
    assert.equal(read(doc.getElementById('q')).form.action, 'https://evil.test/x');
    doc.getElementById('out')!.remove();
    Object.defineProperty(doc.getElementById('f2'), 'action', { value: doc.getElementById('q') });
    assert.equal(read(doc.getElementById('q')).form.action, 'https://shop.test/ok');
    // a page that removes the action getter costs the address, not the rest of the reading, and the card still asks (this reader runs in its world)
    const proto = win.HTMLFormElement.prototype;
    const getter = Object.getOwnPropertyDescriptor(proto, 'action')!;
    Object.defineProperty(proto, 'action', { value: 'x', configurable: true, writable: true });
    const tampered = read(doc.getElementById('q'));
    assert.equal(tampered.form.action, 'https://unreadable.invalid/');
    assert.equal(tampered.editable, true);
    Object.defineProperty(proto, 'action', getter);
    assert.equal(read(null).none, true);
    (doc.getElementById('msg') as any).focus();
    const focused = new win.Function(`return (${FOCUS_INTENT})`)()();
    assert.equal(focused.tag, 'textarea');
    assert.equal(focused.form, null, 'no form around it');
    win.close();
    // the result text, the dialog line and the actions a tool performs
    assert.equal(parsedIntent('nothing'), null);
    assert.equal(parsedIntent('{\n  "mopilot_intent": true, broken'), null);
    assert.equal(parsedIntent('{\n  "mopilot_intent": true\n bad\n}'), null);
    assert.equal(parsedIntent(JSON.stringify({ mopilot_intent: true, none: true }, null, 2)), null);
    assert.equal(
      dialogMessage('- ["confirm" dialog with message "Delete "My project"?"]: can be handled by browser_handle_dialog'),
      'Delete "My project"?',
    );
    assert.equal(dialogMessage(''), '');
    assert.deepEqual(actionsOf('browser_click', { ref: 'e1' }, ''), [{ kind: 'click', target: 'e1' }]);
    assert.deepEqual(actionsOf('browser_type', { target: 'e1' }, ''), [{ kind: 'type', target: 'e1' }]);
    assert.deepEqual(actionsOf('browser_fill_form', { fields: [{ ref: 'e2' }, {}] }, ''), [
      { kind: 'fill', target: 'e2' },
      { kind: 'fill', target: undefined },
    ]);
    assert.deepEqual(actionsOf('browser_fill_form', null, ''), []);
    assert.deepEqual(actionsOf('browser_press_key', {}, ''), [{ kind: 'key', keys: '' }]);
    assert.deepEqual(actionsOf('browser_hover', {}, ''), []);
  });

  /* ---------- D7: the iab backend checks the current page on every command ---------- */
}
