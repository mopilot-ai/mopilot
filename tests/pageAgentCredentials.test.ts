// The page agent's credential hand-off ops (electron/capabilities/browser/pageAgent.cjs): finding
// username, password and one-time code fields, focusing one on the expected origin for MoPilot to
// fill (and masking it from then on), and checking it filled by length only. Runs the real agent
// against a happy-dom document; happy-dom has no layout, so boxes and computed styles are stubbed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { pageAgent } = require('../electron/capabilities/browser/pageAgent.cjs');

const win: any = new Window({ url: 'https://site.test/login', width: 1024, height: 768 });
const doc: any = win.document;
const G: any = globalThis;
Object.assign(G, {
  document: doc,
  location: win.location,
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
  MutationObserver: win.MutationObserver,
});
after(() => win.happyDOM.close());
win.getComputedStyle = () => ({
  display: 'inline',
  visibility: 'visible',
  position: 'static',
  cursor: 'auto',
  paddingLeft: '0px',
  paddingTop: '0px',
});

const agent = pageAgent();
const run = (op: string, args?: any) => agent.call(op, args).value;
/** Every input gets a box unless it is marked hidden (no box: not visible). */
const load = (html: string) => {
  doc.body.innerHTML = html;
  for (const el of doc.querySelectorAll('input')) {
    const size = el.hasAttribute('data-hidden') ? 0 : 20;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: size * 5, height: size, right: size * 5, bottom: size, x: 0, y: 0 });
  }
  return (id: string) => doc.getElementById(id);
};
const kinds = (out: any) => out.fields.map((f: any) => [f.kind, f.label]);

test('credentialFields finds the first visible field of each kind, by type, autocomplete and name hints', () => {
  load(`
    <form>
      <input id="hidden-user" name="username" data-hidden>
      <input id="user" type="email" aria-label="Email">
      <input id="user2" name="login">
      <input id="pw" type="password" aria-label="Password">
      <input id="otp" autocomplete="one-time-code" aria-label="Code">
      <input id="card" name="cardnumber" aria-label="Card">
      <input id="search" type="search" name="user">
      <input id="plain" name="city">
      <input id="off" name="email" disabled>
      <input type="checkbox" name="remember">
    </form>`);
  const out = run('credentialFields');
  assert.equal(out.origin, 'https://site.test');
  assert.deepEqual(kinds(out), [
    ['username', 'Email'],
    ['password', 'Password'],
    ['otp', 'Code'],
  ]);
  assert.ok(out.fields.every((f: any) => /^ref_\d+$/.test(f.ref)));
  // hints: an OTP by its name, a username by autocomplete or a login-ish name, a text field named for a password
  load(`
    <input id="a" name="verification_code" placeholder="6-digit code">
    <input id="b" autocomplete="username">
    <input id="c" name="pwd">`);
  assert.deepEqual(kinds(run('credentialFields')), [
    ['otp', '6-digit code'],
    ['username', ''],
    ['password', ''],
  ]);
  load('<input name="account_id" type="tel"><input type="number" name="mfa">');
  assert.deepEqual(
    run('credentialFields').fields.map((f: any) => f.kind),
    ['username', 'otp'],
  );
  load('<input name="city"><textarea name="user"></textarea>');
  assert.deepEqual(run('credentialFields').fields, []);
});

test('credentialFields with refs: each must be a sign-in field; a plain text field counts as a username', () => {
  const $ = load('<input id="t" name="city" aria-label="Who"><input id="pw" type="password" aria-label="PW"><button id="b">Go</button>');
  const refs: Record<string, string> = {};
  for (const name of ['Who', 'PW', 'Go']) refs[name] = agent.call('find', { query: name }).value.lines[0].match(/\[(ref_\d+)\]/)[1];
  const ref = (name: string) => refs[name];
  const out = run('credentialFields', { refs: [ref('Who'), ref('PW')] });
  assert.deepEqual(
    out.fields.map((f: any) => [f.ref, f.kind, f.label]),
    [
      [ref('Who'), 'username', 'Who'],
      [ref('PW'), 'password', 'PW'],
    ],
  );
  assert.deepEqual(run('credentialFields', { refs: [ref('Go')] }), { error: 'not_credential', ref: ref('Go') });
  $('t').remove();
  assert.deepEqual(run('credentialFields', { refs: [ref('Who')] }), { error: 'stale', ref: ref('Who') });
});

test('credentialFocus checks the origin, focuses and selects the field and masks it from then on; credentialCheck reports length only', () => {
  const $ = load(
    '<form id="f"><input id="u" name="username" aria-label="User" value="old"></form><input id="x" name="email" aria-label="Loose">',
  );
  const [u] = run('credentialFields').fields;
  assert.deepEqual(run('credentialFocus', { ref: u.ref, origin: 'https://evil.test' }), { error: 'origin' });
  assert.notEqual(doc.activeElement, $('u'));
  let selected = 0;
  $('u').select = () => selected++;
  assert.deepEqual(run('credentialFocus', { ref: u.ref, origin: 'https://site.test' }), { ok: true });
  assert.equal(doc.activeElement, $('u'));
  assert.equal(selected, 1);
  // masked like a password field: page reads hide it and agent typing into it is refused
  assert.equal(run('intent', { ref: u.ref }).secret, true);
  $('u').value = 'ada@example.com';
  assert.deepEqual(run('credentialCheck', { ref: u.ref }), { length: 15 });
  // submitting: the form's requestSubmit, a throwing one, and a field outside a form
  let submitted = 0;
  $('f').requestSubmit = () => submitted++;
  assert.deepEqual(run('credentialCheck', { ref: u.ref, submit: true }), { length: 15, submitted: true });
  assert.equal(submitted, 1);
  $('f').requestSubmit = () => {
    throw new Error('invalid form');
  };
  assert.deepEqual(run('credentialCheck', { ref: u.ref, submit: true }), { length: 15, submitted: false });
  const loose = run('credentialFields', { refs: [agent.call('find', { query: 'Loose' }).value.lines[0].match(/\[(ref_\d+)\]/)[1]] })
    .fields[0];
  assert.deepEqual(run('credentialCheck', { ref: loose.ref, submit: true }), { length: 0, submitted: false });
  $('u').remove();
  assert.deepEqual(run('credentialFocus', { ref: u.ref, origin: 'https://site.test' }), { error: 'stale', ref: u.ref });
  assert.deepEqual(run('credentialCheck', { ref: u.ref }), { error: 'stale', ref: u.ref });
});

test('credentialFields names a field with several labels that repeat a word once (Instagram sign-up)', () => {
  const $ = load(`
    <form>
      <label id="heading" for="pw"><span>Password</span><span>Password</span></label>
      <label><span>Password</span><input id="pw" type="password"></label>
      <span id="a">Email</span><span id="b">email</span>
      <input id="user" type="email" aria-labelledby="a b">
    </form>`);
  // happy-dom has no layout: give the label the line break a browser's innerText has between its blocks
  Object.defineProperty($('heading'), 'innerText', { value: 'Password\nPassword' });
  assert.deepEqual(kinds(run('credentialFields')), [
    ['password', 'Password'],
    ['username', 'Email'],
  ]);
});
