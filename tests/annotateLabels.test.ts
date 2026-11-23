// The Annotate overlay's field names (src/lib/annotateOverlay.ts): a field tied to several labels that repeat
// a word, as Instagram's sign-up password field is, reports the word once (shared/labelText.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { annotateOverlay, ANNOTATE_KEY } from '../src/lib/annotateOverlay.ts';

const win = new Window({ url: 'https://site.test/signup', width: 800, height: 600 }) as any;
after(() => win.happyDOM.close());

test('element facts: a field with several labels that repeat a word reports it once', () => {
  const doc = win.document;
  doc.body.innerHTML =
    '<form><label id="h" for="pw"><span>Password</span><span>Password</span></label><label><span>Password</span><input id="pw" type="password"></label>' +
    '<span id="a">Email</span><span id="b">email</span><input id="mail" aria-labelledby="a b">' +
    '<label id="hid" for="q">Search</label><input id="q"></form>';
  // happy-dom has no layout: give the label the line break a browser's innerText has between its blocks
  Object.defineProperty(doc.getElementById('h'), 'innerText', { value: 'Password\nPassword' });
  // a hidden label renders no text: its text still names the field
  Object.defineProperty(doc.getElementById('hid'), 'innerText', { value: '' });
  // the overlay's shadow root is closed: keep a handle for the test
  let root: any = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (this: any, init: any) {
    root = attach.call(this, { ...init, mode: 'open' });
    return root;
  };
  let under: any = null;
  doc.elementFromPoint = () => under;
  annotateOverlay(win, { key: ANNOTATE_KEY, signal: 'L:' });
  const layer = root.firstElementChild;
  for (const id of ['pw', 'mail', 'q']) {
    const target = doc.getElementById(id);
    const r = { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
    target.getBoundingClientRect = () => r;
    under = target;
    for (const type of ['pointerdown', 'pointerup'])
      layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
  }
  const [pw, mail, q] = win[ANNOTATE_KEY].collect().marks.map((m: any) => m.element);
  assert.equal(pw.label, 'Password');
  assert.equal(mail.labelledBy, 'Email');
  assert.equal(q.label, 'Search');
  win[ANNOTATE_KEY].destroy();
});
