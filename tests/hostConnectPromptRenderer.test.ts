// The question ssh asks while a machine is added, in Settings → My machines: a first-seen host key asks Connect, with its fingerprint on the row, a password goes in a secure field and only to ssh, Cancel answers nothing, and a question for another machine or one already answered is not shown.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  click,
  button,
  text,
  setValue,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');

let push: (e: unknown) => void = () => undefined;
let answerFails = false;
beforeEach(() => {
  resetCtl();
  answerFails = false;
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onPrompt': (cb: any) => ((push = cb), () => undefined),
    'host.answerPrompt': () => (answerFails ? Promise.reject(new Error('gone')) : Promise.resolve(true)),
    'host.add': () => new Promise(() => undefined),
  });
  calls.length = 0;
});

async function adding() {
  const view = await renderMachines();
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  return view;
}
const answers = () => calls.filter((c) => c[0] === 'host.answerPrompt').map((c) => c.slice(1));

test('a first-seen host key asks once, with its fingerprint on the row', async (t) => {
  const view = await adding();
  t.after(() => view.unmount());
  const prompt = { kind: 'hostKey', destination: 'me@box', host: 'box', keyType: 'ED25519', fingerprint: 'SHA256:abc', text: '' };
  await act(() => push({ id: 'p1', destination: 'other', prompt }));
  assert.doesNotMatch(text(view.host), /First time connecting/, 'another machine’s question is not shown here');
  await act(() => push({ id: 'p1', destination: 'me@box', prompt }));
  assert.match(text(view.host), /Connect to box\?First time connecting to this machine\. ED25519 SHA256:abc/);
  // the fingerprint is text on the row, not behind a hover
  assert.equal(text(view.host.querySelector('.host-fingerprint')), 'ED25519 SHA256:abc');
  assert.equal(view.host.querySelector('[title*="fingerprint"]'), null);
  await click(button(view.host, 'Connect'));
  assert.deepEqual(answers(), [['p1', 'yes']]);
  await act(() => push({ id: 'p1', destination: 'me@box', prompt: null }));
  assert.doesNotMatch(text(view.host), /First time connecting/);
});

test('a password goes in a secure field, is sent with Enter or Connect, and Cancel sends nothing', async (t) => {
  const view = await adding();
  t.after(() => view.unmount());
  await act(() =>
    push({ id: 'p2', destination: 'me@box', prompt: { kind: 'password', destination: 'me@box', account: 'me@box', text: '' } }),
  );
  const field = view.host.querySelector('input[aria-label="Password for me@box"]') as HTMLInputElement;
  assert.equal(field.type, 'password');
  assert.equal(field.autocomplete, 'off');
  assert.match(text(view.host), /Not saved\./);
  assert.equal(button(view.host, 'Connect').disabled, true, 'nothing typed yet');
  await setValue(field, 'pw');
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.deepEqual(answers(), [['p2', 'pw']]);
  assert.equal(field.value, '', 'the field is emptied once sent');
  // the next question (a wrong password asked again) starts empty; Cancel answers nothing
  await act(() => push({ id: 'p3', destination: 'me@box', prompt: { kind: 'passphrase', destination: 'me@box', key: '/k', text: '' } }));
  assert.match(text(view.host), /Passphrase for \/k/);
  await click(button(view.host, 'Cancel'));
  assert.deepEqual(answers().at(-1), ['p3', null]);
  // an answer that cannot be delivered says so
  answerFails = true;
  await act(() => push({ id: 'p4', destination: 'me@box', prompt: { kind: 'secret', destination: 'me@box', text: 'Verification code:' } }));
  await setValue(view.host.querySelector('input[aria-label="Verification code:"]')!, '123456');
  await click(button(view.host, 'Connect'));
  await flush();
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === 'Gone.'));
  // a yes/no of ssh's own takes no text
  await act(() => push({ id: 'p5', destination: 'me@box', prompt: { kind: 'confirm', destination: 'me@box', text: 'Allow? (yes/no)' } }));
  assert.equal(view.host.querySelector('input[aria-label="Allow? (yes/no)"]'), null);
  await click(button(view.host, 'Yes'));
  assert.deepEqual(answers().at(-1), ['p5', 'yes']);
  // an answered question that is not the one shown leaves it
  await act(() => push({ id: 'old', destination: 'me@box', prompt: null }));
  assert.match(text(view.host), /Allow\? \(yes\/no\)/);
});

test('MoPilot asks before it adds its own key: the row says what goes where, Add key answers add, Cancel answers nothing', async (t) => {
  const view = await adding();
  t.after(() => view.unmount());
  const prompt = {
    kind: 'keyConsent',
    destination: 'me@box',
    host: 'box',
    publicKeyFile: '~/.ssh/mopilot_ed25519.pub',
    addsTo: '~/.ssh/authorized_keys',
    store: 'file',
    choices: ['add'],
    text: '',
  };
  await act(() => push({ id: 'k1', destination: 'me@box', prompt }));
  assert.match(
    text(view.host),
    /Add a MoPilot key to box\?MoPilot reconnects in the background, so it adds the key in ~\/\.ssh\/mopilot_ed25519\.pub to ~\/\.ssh\/authorized_keys on box\. Cancel adds nothing\./,
  );
  await click(button(view.host, 'Add key'));
  assert.deepEqual(answers(), [['k1', 'add']]);
  await act(() => push({ id: 'k2', destination: 'me@box', prompt }));
  await click(button(view.host, 'Cancel'));
  assert.deepEqual(answers().at(-1), ['k2', null]);
});
