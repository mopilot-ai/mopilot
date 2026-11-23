// What a tainted turn treats as a form submit (G3, #3571): browser/submitTaint.cjs, from the element the page agent
// describes and the action, and the address the form posts to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const risk = require('../electron/capabilities/browser/submitTaint.cjs');

test('submitTaint: what a tainted turn treats as a form submit, and where it posts (G3)', () => {
  const { submitTaint } = risk;
  const form = { payment: false, secrets: 0, newPassword: false, submit: 'Go', action: 'https://evil.test/x' };
  const click = { kind: 'click' };
  assert.deepEqual(submitTaint({ button: true, submits: true, form }, click), { kind: 'submit', to: 'https://evil.test/x' });
  // Enter or space on a focused submit button, and Enter in a form's field
  assert.deepEqual(submitTaint({ button: true, role: 'button', submits: true, form }, { kind: 'key', keys: 'Enter' }), {
    kind: 'submit',
    to: 'https://evil.test/x',
  });
  assert.deepEqual(submitTaint({ button: true, role: 'button', submits: true, form: null }, { kind: 'key', keys: 'Space' }), {
    kind: 'submit',
    to: '',
  });
  assert.deepEqual(submitTaint({ editable: true, form }, { kind: 'key', keys: 'Enter' }), { kind: 'submit', to: 'https://evil.test/x' });
  // not a submit: a plain button, typing, a field outside a form, an unread or unreadable target
  assert.equal(submitTaint({ button: true, name: 'Next' }, click), null);
  assert.equal(submitTaint({ editable: true, form }, { kind: 'type', text: 'x' }), null);
  assert.equal(submitTaint({ editable: true, form: null }, { kind: 'key', keys: 'Enter' }), null);
  assert.equal(submitTaint({ button: true, submits: true }, { kind: 'key', keys: 'a' }), null);
  assert.equal(submitTaint(null, click), null);
  assert.equal(submitTaint({ unreadable: true, submits: true }, click), null);
});
