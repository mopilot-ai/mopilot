// The Allow sheet and Add › Computer on Control this Mac (AllowSheet.tsx, ComputerCodePane.tsx, AddDeviceDialog.tsx, behind host.codePair): this Mac's code and each step in words; the sheet only with a name and a safety number (it fails closed), the name as the other device's own claim, the one grant sentence, the time left; Allow through the system prompt; Don't allow, Escape and the end of the wait close it for that offer and Escape leaves the dialog under it; a failed new code never leaves the old one shown.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, calls, render, click, button, text, act } from './support/settings-harness.ts';
import { waitFor } from './support/waitFor.ts';

await setup();
await import('../src/lib/native/codePair.ts');
const { createElement: h } = await import('react');
const { AllowSheet, GRANT_TEXT, WEAK_KEY_TEXT } = await import('../src/components/pages/settings/AllowSheet.tsx');
const { ComputerCodePane } = await import('../src/components/pages/settings/ComputerCodePane.tsx');
const { AddDeviceDialog } = await import('../src/components/pages/settings/AddDeviceDialog.tsx');

let push: (e: unknown) => void = () => undefined;
beforeEach(() => {
  resetCtl();
  Object.assign(responses, {
    'codePair.status': () => ({ approval: { available: true }, connections: true, offers: [] }),
    'codePair.offer': () => ({ offerId: 'o1', code: 'ABCD-EFGH', expiresAt: Date.now() + 120_000 }),
    'codePair.onEvent': (cb: any) => ((push = cb), () => undefined),
    'codePair.cancel': () => ({ cancelled: true }),
    'codePair.deny': () => ({ accepted: false }),
    'codePair.allow': () => ({ accepted: true, fingerprint: 'fp' }),
    'codePair.setup': () => ({ enrolled: true, weak: false }),
  });
});
const of = (name: string) => calls.filter((c) => c[0] === `codePair.${name}`).map((c) => c[1]);
const code = (root: Element) => root.querySelector('[aria-label="This Mac\'s code"]');
const sheet = (root: Element) => root.querySelector('[role=alertdialog]');
const sheetProps = (o: object = {}) => ({
  offerId: 'o1',
  name: 'Studio',
  safety: '1234 5678',
  expiresAt: Date.now() + 60_000,
  onClose: () => undefined,
  ...o,
});

test('the grant is one sentence: the name as the device’s own, full control as you, removing may not undo it', () => {
  const t = GRANT_TEXT('Studio');
  assert.match(t, /^The device named “Studio” will fully control this Mac as you/);
  assert.match(t, /run commands, read and change files, see every chat/);
  assert.match(t, /Removing it later may not undo what it already did/);
});

test('the sheet quotes the name as the other device’s, shows the number in a group, the time left, and starts on Don’t allow', async (t) => {
  const view = await render(h(AllowSheet, sheetProps({ weak: true })));
  t.after(() => view.unmount());
  assert.match(text(sheet(view.host)!), /Allow the device named “Studio” to control this Mac\?/);
  assert.match(text(view.host), /Named by the other device/);
  assert.equal(view.host.querySelector('[aria-label="Safety number"]')?.getAttribute('role'), 'group');
  assert.match(text(view.host), /Waits 1:00 more|Waits 0:59 more/);
  assert.match(text(view.host), new RegExp(WEAK_KEY_TEXT.slice(0, 20)));
  assert.equal(view.host.ownerDocument.activeElement, button(view.host, 'Don’t allow'));
});

test('Allow goes through the prompt: cancelled keeps it, a refusal or the helper’s failure is said in words, success closes', async (t) => {
  let closed = 0;
  let answer: any = { error: { code: 'not_approved' } };
  responses['codePair.allow'] = () => (answer instanceof Error ? Promise.reject(answer) : answer);
  const view = await render(h(AllowSheet, sheetProps({ onClose: () => void closed++ })));
  t.after(() => view.unmount());
  const tryAllow = async (pattern: RegExp) => {
    await click(button(view.host, 'Allow'));
    await waitFor(() => pattern.test(text(view.host)), String(pattern));
  };
  await tryAllow(/the Touch ID or password prompt was cancelled/);
  answer = { error: { code: 'keychain' } };
  await tryAllow(/keychain didn’t answer/);
  answer = { error: { code: 'odd' } };
  await tryAllow(/Allowing didn’t work/);
  answer = new Error('main went away');
  await click(button(view.host, 'Allow'));
  await waitFor(() => view.host.querySelector('[role=alert]'), 'a failed call said');
  assert.equal(closed, 0);
  answer = { accepted: true, fingerprint: 'fp' };
  await click(button(view.host, 'Allow'));
  await waitFor(() => closed === 1, 'the sheet to close');
});

test('Don’t allow denies once with both buttons off meanwhile; Escape denies and stops at the sheet; the end of the wait closes it', async (t) => {
  let closed = 0;
  let finish: (v: unknown) => void = () => undefined;
  responses['codePair.deny'] = () => new Promise((r) => (finish = r));
  const view = await render(h(AllowSheet, sheetProps({ onClose: () => void closed++ })));
  await click(button(view.host, 'Don’t allow'));
  assert.equal(button(view.host, 'Allow').disabled, true);
  assert.equal(button(view.host, 'Don’t allow').disabled, true);
  await act(async () => finish({ accepted: false }));
  await waitFor(() => closed === 1, 'closed after Don’t allow');
  assert.deepEqual(of('deny'), [{ offerId: 'o1' }]);
  await view.unmount();
  responses['codePair.deny'] = () => ({ accepted: false });
  let outer = 0;
  const onWindow = (e: KeyboardEvent) => e.key === 'Escape' && outer++;
  window.addEventListener('keydown', onWindow);
  const escaped = await render(h(AllowSheet, sheetProps({ onClose: () => void closed++ })));
  await act(
    async () => void button(escaped.host, 'Don’t allow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await waitFor(() => closed === 2, 'Escape closes the sheet');
  assert.equal(outer, 0, 'the dialog under it never hears this Escape');
  window.removeEventListener('keydown', onWindow);
  await escaped.unmount();
  const late = await render(h(AllowSheet, sheetProps({ expiresAt: Date.now() - 1, onClose: () => void closed++ })));
  t.after(() => late.unmount());
  await waitFor(() => closed === 3, 'a request that stopped waiting closes its sheet');
});

test('Computer: the code and each step; the sheet only with a name and a safety number, and gone for that offer once closed', async (t) => {
  const view = await render(h(ComputerCodePane));
  t.after(() => view.unmount());
  await waitFor(() => code(view.host), 'the code');
  assert.equal(code(view.host)!.getAttribute('role'), 'group');
  assert.equal(text(code(view.host)), 'ABCD-EFGH');
  await act(async () => push({ offerId: 'other', phase: 'connecting' }));
  assert.doesNotMatch(text(view.host), /connecting/);
  await act(async () => push({ offerId: 'o1', phase: 'proving' }));
  assert.match(text(view.host), /Checking the code/);
  // fails closed: no name or no number, no sheet
  await act(async () => push({ offerId: 'o1', phase: 'confirm', name: 'Studio', expiresInMs: 60_000 }));
  assert.equal(sheet(view.host), null);
  await act(async () => push({ offerId: 'o1', phase: 'confirm', safety: '1234', expiresInMs: 60_000 }));
  assert.equal(sheet(view.host), null);
  await act(async () => push({ offerId: 'o1', phase: 'confirm', name: 'Studio', safety: '1234', expiresInMs: 60_000 }));
  assert.ok(sheet(view.host));
  await click(button(view.host, 'Don’t allow'));
  await waitFor(() => sheet(view.host) === null, 'closed for this offer');
  await act(async () => push({ offerId: 'o1', phase: 'confirm', name: 'Studio', safety: '1234', expiresInMs: 60_000 }));
  assert.equal(sheet(view.host), null, 'it does not come back for the same offer');
  await act(async () => push({ offerId: 'o1', phase: 'failed', code: 'relay' }));
  await waitFor(() => button(view.host, 'New code'), 'New code');
  // a new code that fails never leaves the old one shown
  responses['codePair.offer'] = () => ({ error: { code: 'connections_off' } });
  await click(button(view.host, 'New code'));
  await waitFor(() => view.host.querySelector('[role=alert]'), 'the refusal');
  assert.equal(code(view.host), null);
  assert.match(text(view.host.querySelector('[role=alert]')!), /Connections are off/);
});

test('every phase in words, the countdown, and done', async (t) => {
  const view = await render(h(ComputerCodePane));
  t.after(() => view.unmount());
  await waitFor(() => code(view.host), 'the code');
  assert.match(text(view.host), /Enter this code on the other Mac[\s\S]*Expires in [12]:\d\d/);
  await act(async () => push({ offerId: 'o1', phase: 'expired' }));
  assert.match(text(view.host), /The code expired/);
  await act(async () => push({ offerId: 'o1', phase: 'done' }));
  assert.match(text(view.host), /Added/);
});

test('a Mac that cannot ask yet offers its one-time setup, then makes a code; refusals and failures are said', async (t) => {
  let ready = false;
  responses['codePair.status'] = () => ({
    approval: ready ? { available: true, weak: true } : { available: false, reason: 'no_approval_helper' },
    connections: true,
    offers: [],
  });
  responses['codePair.setup'] = () => ((ready = true), { enrolled: true, weak: true });
  const view = await render(h(ComputerCodePane));
  t.after(() => view.unmount());
  await waitFor(() => button(view.host, 'Set up'), 'Set up');
  await click(button(view.host, 'Set up'));
  await waitFor(() => code(view.host), 'the code after setup');
  for (const [status, setupAnswer] of [
    [{ approval: { available: false, reason: 'unsupported_platform' }, connections: true, offers: [] }, null],
    [() => Promise.reject(new Error('main went away')), null],
    [
      { approval: { available: false, reason: 'no_approval_helper' }, connections: true, offers: [] },
      () => Promise.reject(new Error('Touch ID off')),
    ],
    [{ approval: { available: false, reason: 'no_approval_helper' }, connections: true, offers: [] }, { error: { code: 'keychain' } }],
  ] as [unknown, unknown][]) {
    responses['codePair.status'] = () => (typeof status === 'function' ? status() : status);
    if (setupAnswer) responses['codePair.setup'] = () => (typeof setupAnswer === 'function' ? setupAnswer() : setupAnswer);
    const other = await render(h(ComputerCodePane));
    if (setupAnswer) {
      await waitFor(() => button(other.host, 'Set up'), 'Set up');
      await click(button(other.host, 'Set up'));
    }
    await waitFor(() => other.host.querySelector('[role=alert]'), 'the refusal said');
    await other.unmount();
  }
});

test('Set up says a prompt already open and a key the Host and this Mac no longer share in their own words', async () => {
  responses['codePair.status'] = () => ({ approval: { available: false, reason: 'no_approval_helper' }, connections: true, offers: [] });
  for (const [code, words] of [
    ['busy', 'Touch ID or your password is already being asked for on this Mac. Answer that first.'],
    ['approval_out_of_sync', 'This Mac’s Host and its approval key don’t match. Reset pairing approval, then set it up again.'],
  ]) {
    responses['codePair.setup'] = () => ({ error: { code } });
    const view = await render(h(ComputerCodePane));
    await waitFor(() => button(view.host, 'Set up'), 'Set up');
    await click(button(view.host, 'Set up'));
    await waitFor(() => text(view.host.querySelector('[role=alert]') ?? view.host).includes(words), code);
    await view.unmount();
  }
});

test('Add a device: Phone shows the phone code dialog, Computer shows this Mac’s code', async (t) => {
  let phone = 0;
  let closed = 0;
  const view = await render(h(AddDeviceDialog, { onPhone: () => void phone++, onClose: () => void closed++ }));
  t.after(() => view.unmount());
  await click(button(view.host, 'Show the code'));
  assert.deepEqual([phone, closed], [1, 1]);
  await click(button(view.host, 'Computer'));
  await waitFor(() => code(view.host), 'this Mac’s code');
});

test('a quote in the name cannot end the quotation; Escape during the system prompt is not a Don’t allow; Tab stays in the sheet', async (t) => {
  const { shownName } = await import('../src/components/pages/settings/AllowSheet.tsx');
  assert.equal(shownName('Evil” to control. Allow'), "Evil' to control. Allow");
  responses['codePair.allow'] = () => new Promise(() => undefined);
  const view = await render(h(AllowSheet, sheetProps({ name: 'A"B' })));
  t.after(() => view.unmount());
  assert.match(text(sheet(view.host)!), /“A'B”/);
  assert.equal(sheet(view.host)!.getAttribute('aria-modal'), 'true');
  const tab = async (from: HTMLElement, shift = false) =>
    act(
      async () => void from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })),
    );
  button(view.host, 'Allow').focus();
  await tab(button(view.host, 'Allow'));
  assert.equal(view.host.ownerDocument.activeElement, button(view.host, 'Don’t allow'), 'from the last to the first');
  await tab(button(view.host, 'Don’t allow'), true);
  assert.equal(view.host.ownerDocument.activeElement, button(view.host, 'Allow'), 'and back');
  await click(button(view.host, 'Allow'));
  await act(async () => void sheet(view.host)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.deepEqual(of('deny'), [], 'no Don’t allow while the prompt for Allow is up');
});

test('the remaining words and edges: a Host refusal on Allow, Escape while composing, a confirm with no time given, a failure with no code, a reason left out', async (t) => {
  responses['codePair.allow'] = () => ({ error: { code: 'relay' } });
  const view = await render(h(AllowSheet, sheetProps()));
  await click(button(view.host, 'Allow'));
  await waitFor(() => /relay/i.test(text(view.host.querySelector('[role=alert]') ?? view.host)), 'the Host’s words');
  await act(
    async () => void sheet(view.host)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })),
  );
  assert.deepEqual(of('deny'), [], 'an Escape that ends a composition is not a Don’t allow');
  // Tab with every button disabled keeps nothing to move between
  responses['codePair.allow'] = () => new Promise(() => undefined);
  await click(button(view.host, 'Allow'));
  await act(async () => void button(view.host, 'Allowing…').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  await view.unmount();
  responses['codePair.status'] = () => ({ approval: { available: false }, connections: true, offers: [] });
  const noReason = await render(h(ComputerCodePane));
  await waitFor(() => noReason.host.querySelector('[role=alert]'), 'a reason left out is said as the platform');
  await noReason.unmount();
  responses['codePair.status'] = () => ({ approval: { available: true }, connections: true, offers: [] });
  responses['codePair.offer'] = () => ({ error: { code: 'something_new' } });
  const unknown = await render(h(ComputerCodePane));
  await waitFor(() => /That didn’t work/.test(text(unknown.host)), 'an unknown refusal in plain words');
  await unknown.unmount();
  responses['codePair.offer'] = () => ({ offerId: 'o1', code: 'ABCD-EFGH', expiresAt: Date.now() + 120_000 });
  const pane = await render(h(ComputerCodePane));
  t.after(() => pane.unmount());
  await waitFor(() => code(pane.host), 'the code');
  await act(async () => push({ offerId: 'o1', phase: 'confirm', name: 'Studio', safety: '1' }));
  await waitFor(() => sheet(pane.host) === null, 'a confirm with no time given has no time left: no sheet');
  await act(async () => push({ offerId: 'o1', phase: 'failed' }));
  assert.ok(button(pane.host, 'New code'));
});

const resetFlow = () => {
  let enrolled = true;
  responses['codePair.status'] = () => ({
    approval: enrolled ? { available: true } : { available: false, reason: 'no_approval_helper' },
    connections: true,
    offers: [],
  });
  responses['codePair.offer'] = () => ({ error: { code: 'approval_out_of_sync' } });
  return (answers: unknown[]) => {
    responses['codePair.resetApproval'] = () => {
      const a = answers.shift();
      if (a && typeof a === 'object' && 'reset' in a) enrolled = false;
      return typeof a === 'function' ? a() : a;
    };
  };
};
const dialog = (host: HTMLElement) => host.querySelector<HTMLElement>('[role=alertdialog]');
const resetOnce = async (host: HTMLElement) => {
  await click(button(host, 'Reset pairing approval'));
  await click(button(dialog(host)!, 'Reset'));
};
const said = (host: HTMLElement) => text(host.querySelector('[role=alert]') ?? host);

test('an approval out of sync offers Reset pairing approval behind what it removes; a refused or thrown reset keeps it, in the reset’s own words, until one works', async () => {
  resetFlow()([
    { error: { code: 'busy' } },
    { error: { code: 'host_unreachable' } },
    () => Promise.reject(new Error('main went away')),
    { error: { code: 'reset_incomplete' } },
    { error: { code: 'unsupported' } },
    { reset: true, controllers: 2 },
  ]);
  const view = await render(h(ComputerCodePane));
  await waitFor(() => button(view.host, 'Reset pairing approval'), 'the fix in place');
  await click(button(view.host, 'Reset pairing approval'));
  assert.equal(
    text(dialog(view.host)!),
    'Reset pairing approval?Removes this Mac’s approval key and every Mac paired by code. They must pair again.CancelReset',
  );
  assert.equal(of('resetApproval').length, 0, 'nothing is reset before the person confirms');
  await click(button(dialog(view.host)!, 'Cancel'));
  assert.equal(dialog(view.host), null);
  assert.equal(of('resetApproval').length, 0);
  for (const words of [
    'A code or a set-up is open on this Mac. Close it, then reset again.',
    'This Mac’s Host isn’t answering. Wait a moment, then reset again.',
  ]) {
    await resetOnce(view.host);
    await waitFor(() => said(view.host) === words, words);
    assert.ok(button(view.host, 'Reset pairing approval'), 'the reset is still the fix, in place');
  }
  // thrown: main's own message, never the code pane's "make a new code"
  await resetOnce(view.host);
  await waitFor(
    () => of('resetApproval').length === 3 && !/Reset again|new code/.test(said(view.host)) && said(view.host) !== '',
    'main’s message',
  );
  assert.ok(button(view.host, 'Reset pairing approval'));
  await resetOnce(view.host);
  await waitFor(() => said(view.host) === 'The reset didn’t finish. Reset again to finish it.', 'reset_incomplete');
  await resetOnce(view.host);
  await waitFor(
    () => said(view.host) === 'This Mac’s Host is too old to reset pairing approval. Update MoPilot, then reset again.',
    'unsupported',
  );
  await resetOnce(view.host);
  await waitFor(() => button(view.host, 'Set up'), 'set it up again');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast').at(-1)?.[1],
    'Pairing approval reset. 2 paired Macs were removed and must pair again.',
  );
  assert.equal(of('resetApproval').length, 6);
  await view.unmount();
});

test('a reset says how many paired Macs it removed: one, none', async () => {
  for (const [n, words] of [
    [1, 'Pairing approval reset. 1 paired Mac was removed and must pair again.'],
    [0, 'Pairing approval reset. No paired Macs were removed.'],
  ] as [number, string][]) {
    resetFlow()([{ reset: true, controllers: n }]);
    const view = await render(h(ComputerCodePane));
    await waitFor(() => button(view.host, 'Reset pairing approval'), 'the fix in place');
    await resetOnce(view.host);
    await waitFor(() => calls.some((c) => c[0] === 'toast' && c[1] === words), words);
    await view.unmount();
  }
});

test('a reset refused in words the reset table lacks: this Mac’s helper’s words, main’s own message, then plain words', async () => {
  for (const [answer, words] of [
    [{ error: { code: 'no_helper' } }, 'MoPilot’s approval helper is missing. Update MoPilot on this Mac.'],
    [{ error: { code: 'mystery', message: 'The helper said no.' } }, 'The helper said no.'],
    [{ error: { code: 'mystery' } }, 'Resetting pairing approval didn’t work. Reset again.'],
  ] as [unknown, string][]) {
    resetFlow()([answer]);
    const view = await render(h(ComputerCodePane));
    await waitFor(() => button(view.host, 'Reset pairing approval'), 'the fix in place');
    await resetOnce(view.host);
    await waitFor(() => said(view.host) === words, words);
    await view.unmount();
  }
});
