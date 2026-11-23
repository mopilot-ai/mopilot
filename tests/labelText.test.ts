// Joining a field's label texts (shared/labelText.mjs), and the readers that use it: each line once, so a field tied to several labels
// that repeat a word ("Password" on Instagram's sign-up form) is named once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelText } from '../shared/labelText.mjs';

test('labelText: a heading and floating label in one label, and a second label, name the field once', () => {
  assert.equal(labelText(['Password\nPassword', 'Password']), 'Password');
  assert.equal(labelText(['  Mobile number   or email \r\n', 'mobile number OR email']), 'Mobile number or email');
});

test('labelText: distinct pieces keep their order; empty and missing texts add nothing', () => {
  assert.equal(labelText(['First name', null, '', undefined, '\n\n', 'Required']), 'First name Required');
  assert.equal(labelText([]), '');
});

test('labelText runs from its source text alone, as the page scripts receive it', () => {
  const fromSource = new Function(`return (${labelText.toString()})`)();
  assert.equal(fromSource(['Password\nPassword', 'Password']), 'Password');
});

test("Your Chrome's intent reader names a field with several labels that repeat a word once", async () => {
  const { Window } = await import('happy-dom');
  const { createRequire } = await import('node:module');
  const { ELEMENT_INTENT } = createRequire(import.meta.url)('../electron/capabilities/browser/chromeIntent.cjs');
  const win: any = new Window({ url: 'https://www.instagram.com/accounts/emailsignup/' });
  try {
    win.document.body.innerHTML =
      '<label id="h" for="pw"><span>Password</span><span>Password</span></label><label><span>Password</span><input id="pw" type="password"></label>';
    // happy-dom has no layout: give the label the line break a browser's innerText has between its blocks
    Object.defineProperty(win.document.getElementById('h'), 'innerText', { value: 'Password\nPassword' });
    const read = new win.Function(`return (${ELEMENT_INTENT})`)();
    assert.equal(read(win.document.getElementById('pw')).name, 'Password');
  } finally {
    await win.happyDOM.close();
  }
});
