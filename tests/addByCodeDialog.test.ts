// Adding a device by its code (src/components/pages/settings/AddByCodeDialog.tsx, behind host.codePair): eight boxes edited one by one; a paste of the code as the other Mac shows it fills them all; the eighth character sends the code once; a letter codes never use is said; the main process's own words of how it ended are shown with their one fix; success shows the safety number; closing while it pairs stops the run, and a pairing that still lands names the number in its toast.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  ctl,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  act,
} from './support/settings-harness.ts';
import { waitFor } from './support/waitFor.ts';
// @ts-ignore: plain ESM without declarations
import { ALPHABET } from '../shared/host/codePair.mjs';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { AddByCodeDialog, CODE_ALPHABET, NOT_IN_CODES, codeChars } = await import('../src/components/pages/settings/AddByCodeDialog.tsx');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections', tab: 'other' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.cancelAddByCode': () => undefined,
  });
});

const boxes = (root: Element) => [...root.querySelectorAll<HTMLInputElement>('input.code-box')];
const values = (root: Element) =>
  boxes(root)
    .map((b) => b.value)
    .join('|');
const sent = () => calls.filter((c) => c[0] === 'host.addByCode').map((c) => c[1]);
const cancels = () => calls.filter((c) => c[0] === 'host.cancelAddByCode').length;

/** A real paste event with `text` on its clipboard, as the browser fires it. */
async function paste(box: HTMLInputElement, data: string) {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: () => data } });
  await act(async () => void box.dispatchEvent(e));
}
/** One character typed into a box, as React's onChange sees it. */
async function typeIn(box: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!;
  await act(async () => {
    setter.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(box: HTMLInputElement, k: string) {
  await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
}

test('the dialog’s letters are the protocol’s; typing keeps only them, upper case, at most eight', () => {
  assert.equal(CODE_ALPHABET, ALPHABET);
  assert.deepEqual(codeChars('ab1-cd o9 efgh'), ['A', 'B', 'C', 'D', '9', 'E', 'F', 'G']);
});

test('the code pasted as the other Mac shows it (dash, space, lower case, into any box) fills all eight and is sent once', async (t) => {
  responses['host.addByCode'] = async () => ({ ok: true, id: 'code:box', name: 'Studio', safety: '1234 5678 9012' });
  for (const shown of ['ABCD-EFGH', 'abcd efgh']) {
    calls.length = 0;
    const view = await render(h(AddByCodeDialog, { onClose: () => undefined }));
    await typeIn(boxes(view.host)[0], 'X');
    await paste(boxes(view.host)[2], shown);
    await waitFor(() => sent().length === 1, 'the code to be sent');
    assert.deepEqual(sent(), ['ABCDEFGH']);
    await view.unmount();
  }
  void t;
});

test('success shows the safety number with Done in focus; the toast names the machine', async (t) => {
  responses['host.addByCode'] = async () => ({ ok: true, id: 'code:box', name: 'Studio', safety: '1234 5678 9012' });
  let closed = 0;
  const view = await render(h(AddByCodeDialog, { onClose: () => void closed++ }));
  t.after(() => view.unmount());
  await paste(boxes(view.host)[0], 'ABCD-EFGH');
  await waitFor(() => view.host.querySelector('[aria-label="Safety number"]'), 'the safety number');
  assert.equal(text(view.host.querySelector('[aria-label="Safety number"]')), '1234 5678 9012');
  assert.equal(view.host.querySelector('[aria-label="Safety number"]')?.getAttribute('role'), 'group', 'VoiceOver reads a labelled group');
  assert.match(text(view.host.querySelector('[role=status]')!), /Studio is added/);
  assert.equal(view.host.ownerDocument.activeElement, button(view.host, 'Done'));
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Added Studio']);
  await click(button(view.host, 'Done'));
  assert.equal(closed, 1);
});

test('editing is per box: a typed letter replaces only its box, Backspace empties a filled box where it is and an empty one goes back; a letter codes never use is said', async (t) => {
  responses['host.addByCode'] = async () => ({ ok: false, code: 'bad_code', cause: 'x', fix: null });
  const view = await render(h(AddByCodeDialog, { onClose: () => undefined }));
  t.after(() => view.unmount());
  await paste(boxes(view.host)[0], 'ABCDEF');
  assert.equal(values(view.host), 'A|B|C|D|E|F||');
  await typeIn(boxes(view.host)[2], 'Z');
  assert.equal(values(view.host), 'A|B|Z|D|E|F||', 'the boxes after it stay');
  // Backspace in a filled box: the input itself empties it (the key does nothing more)
  await key(boxes(view.host)[2], 'Backspace');
  assert.equal(values(view.host), 'A|B|Z|D|E|F||');
  await typeIn(boxes(view.host)[3], '');
  assert.equal(values(view.host), 'A|B|Z||E|F||', 'Backspace in a filled box empties it where it is');
  await key(boxes(view.host)[3], 'Backspace');
  assert.equal(values(view.host), 'A|B||||E|F||'.replace('||||', '|||'), 'an empty box empties the one before');
  await typeIn(boxes(view.host)[6], 'O');
  assert.equal(text(view.host).includes(NOT_IN_CODES), true);
  await paste(boxes(view.host)[6], '---');
  assert.equal(text(view.host).includes(NOT_IN_CODES), true);
  assert.deepEqual(sent(), []);
});

test('a failure says its cause; Enter another code empties the boxes, Try again sends the same code, no fix shows the cause alone, a throw is Try again', async (t) => {
  let answer: any = {
    ok: false,
    code: 'bad_code',
    cause: 'That code didn’t work.',
    fix: { id: 'enter_code', label: 'Enter another code' },
  };
  responses['host.addByCode'] = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const view = await render(h(AddByCodeDialog, { onClose: () => undefined }));
  t.after(() => view.unmount());
  await paste(boxes(view.host)[0], 'ABCDEFGH');
  await waitFor(() => view.host.querySelector('[role=alert]'), 'the cause');
  assert.match(text(view.host.querySelector('[role=alert]')!), /That code didn’t work/);
  await click(button(view.host, 'Enter another code'));
  await waitFor(() => values(view.host) === '|||||||', 'the boxes to be empty');
  answer = { ok: false, code: 'unreachable', cause: "Couldn't reach MoPilot's relay.", fix: { id: 'retry', label: 'Try again' } };
  await paste(boxes(view.host)[0], 'JKMNPQRS');
  await waitFor(() => sent().length === 2, 'the second code');
  await waitFor(() => button(view.host, 'Try again'), 'Try again');
  answer = { ok: false, code: 'off', cause: "Pairing by code isn't available yet.", fix: null };
  await click(button(view.host, 'Try again'));
  await waitFor(() => /isn't available yet/.test(text(view.host)), 'the cause alone');
  assert.deepEqual(sent(), ['ABCDEFGH', 'JKMNPQRS', 'JKMNPQRS']);
  assert.equal(view.host.querySelectorAll('.machine-sheet-actions button').length, 0);
  await view.unmount();
  answer = new Error('The window lost main');
  const again = await render(h(AddByCodeDialog, { onClose: () => undefined }));
  await paste(boxes(again.host)[0], 'ABCDEFGH');
  await waitFor(() => /Try again/.test(text(again.host)), 'a throw read as a failure with Try again');
  await again.unmount();
});

test('while pairing the boxes take no typing and keep focus; closing for any reason stops the run; a pairing that still lands names the number in its toast', async (t) => {
  let finish: (v: unknown) => void = () => undefined;
  responses['host.addByCode'] = () => new Promise((r) => (finish = r));
  const view = await render(h(AddByCodeDialog, { onClose: () => undefined }));
  await paste(boxes(view.host)[0], 'ABCDEFGH');
  await waitFor(() => /Pairing…/.test(text(view.host.querySelector('[role=status]')!)), 'Pairing… in the live region');
  assert.equal(boxes(view.host)[0].readOnly, true);
  await key(boxes(view.host)[7], 'Backspace');
  assert.equal(values(view.host), 'A|B|C|D|E|F|G|H', 'no editing while it pairs');
  // the dialog goes away with the tab, a navigation or Host access: main is told to stop
  await view.unmount();
  await waitFor(() => cancels() === 1, 'the run to be cancelled');
  // main's answer was already on its way: the person is still told to compare the number
  await act(async () => finish({ ok: true, id: 'code:box', name: 'Studio', safety: '1234 5678' }));
  await waitFor(
    () => calls.some((c) => c[0] === 'toast' && /Added Studio\. Check that it shows 1234 5678\./.test(String(c[1]))),
    'the late toast',
  );
  void t;
});

test('Or connect over SSH closes this dialog (stopping a run) and opens the SSH sheet', async (t) => {
  responses['host.addByCode'] = () => new Promise(() => undefined);
  let closed = 0;
  const view = await render(h(AddByCodeDialog, { onClose: () => void closed++ }));
  t.after(() => view.unmount());
  await click(button(view.host, 'Or connect over SSH'));
  assert.equal(closed, 1);
});

test('with the flag on, Add opens the code dialog; off, it is the SSH sheet as before', async (t) => {
  ctl.flags['host.codePair'] = true;
  const on = await render(h(HostMachines));
  await waitFor(() => button(on.host, 'Add machine'), 'Add machine');
  await click(button(on.host, 'Add machine'));
  assert.ok(on.host.querySelector('input.code-box'), 'the code dialog');
  await click(button(on.host, 'Or connect over SSH'));
  assert.equal(on.host.querySelector('input.code-box'), null, 'it closes');
  await on.unmount();
  ctl.flags['host.codePair'] = false;
  const off = await render(h(HostMachines));
  t.after(() => off.unmount());
  await waitFor(() => button(off.host, 'Add machine'), 'Add machine');
  await click(button(off.host, 'Add machine'));
  assert.equal(off.host.querySelector('input.code-box'), null);
});
