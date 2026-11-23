// Signing in to an agent on a machine, in the window: the views main pushes (src/lib/hostSignin.ts) and the Sign in / Cancel button and status line on a My machines row (HostMachines.tsx), gated by Host access, with malformed views ignored (B1) and a refusal shown as a toast.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  buttons,
  text,
  setValue,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
// the window.native.host types: loaded so the declarations are part of what the tests reach
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');
const { parseSigninView, signinKey, useHostSignins, wantsCode } = await import('../src/lib/hostSignin.ts');

const GEMINI = { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on a' };
const ROW = {
  id: 'ssh:a',
  name: 'a',
  status: 'attention',
  note: 'gemini is not signed in on this machine.',
  signin: 'gemini',
  agents: [GEMINI],
};
const view = (o: object = {}) => ({
  hostId: 'ssh:a',
  harness: 'gemini',
  state: 'waiting',
  codes: [],
  link: false,
  url: null,
  error: null,
  reason: null,
  ...o,
});
let pushSignin: (v: unknown) => void = () => undefined;
let pushAccess: (v: unknown) => void = () => undefined;
let unsubscribed = 0;
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c.slice(1));

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  unsubscribed = 0;
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': (cb: any) => ((pushAccess = cb), () => undefined),
    'host.machines': () => Promise.resolve({ machines: [ROW], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.onSignin': (cb: any) => ((pushSignin = cb), () => void unsubscribed++),
  });
  calls.length = 0;
});

test('B1: only a view with a machine, an agent and a known state is kept; codes are strings and the error is text or nothing', () => {
  assert.deepEqual(parseSigninView(view({ codes: ['A', 3, 'B'], error: 4 })), view({ codes: ['A', 'B'], error: null }));
  assert.deepEqual(parseSigninView(view({ codes: 'x', state: 'failed', error: 'no' })), view({ codes: [], state: 'failed', error: 'no' }));
  // known recovery reasons survive the bridge
  assert.equal(parseSigninView(view({ state: 'failed', reason: 'no_page' }))?.reason, 'no_page');
  assert.equal(parseSigninView(view({ state: 'failed', reason: 'host_update' }))?.reason, 'host_update');
  assert.equal(parseSigninView(view({ state: 'failed', reason: 'other' }))?.reason, null);
  for (const bad of [
    null,
    'x',
    {},
    view({ hostId: '' }),
    view({ hostId: 3 }),
    view({ harness: '' }),
    view({ state: 'green' }),
    view({ state: 4 }),
  ])
    assert.equal(parseSigninView(bad), null);
  assert.equal(signinKey('ssh:a', 'gemini'), 'ssh:a\ngemini');
});

test('a machine with a signed-out agent has a Sign in button named for it; it starts, the code shows, Cancel stops it, and the end is shown', async (t) => {
  responses['host.signin'] = () => Promise.resolve(view({ state: 'starting' }));
  responses['host.cancelSignin'] = () => Promise.resolve(true);
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush();
  assert.equal(button(root.host, 'Sign in to Gemini on a').textContent, 'Sign in');
  assert.match(text(root.host), /Gemini needs sign-in/);
  await click(button(root.host, 'Sign in to Gemini on a'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.signin'),
    [['host.signin', 'ssh:a', 'gemini']],
  );
  assert.equal(button(root.host, 'Cancel signing in to Gemini on a').textContent, 'Cancel');
  assert.match(text(root.host), /Gemini: Opening the sign-in page…/);
  await act(() => pushSignin(view({ codes: ['ABCD-1234'] })));
  assert.match(text(root.host), /Gemini: Enter this code in the page that opened: ABCD-1234/);
  // a view for another machine, and a malformed one, change nothing here
  await act(() => pushSignin(view({ hostId: 'ssh:other', state: 'failed', error: 'elsewhere' })));
  await act(() => pushSignin({ nonsense: true }));
  assert.doesNotMatch(text(root.host), /elsewhere/);
  await click(button(root.host, 'Cancel signing in to Gemini on a'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.cancelSignin'),
    [['host.cancelSignin', 'ssh:a', 'gemini']],
  );
  await act(() => pushSignin(view({ state: 'cancelled' })));
  assert.equal(buttons(root.host, 'Sign in to Gemini on a').length, 1, 'a cancelled sign-in can be started again');
  assert.doesNotMatch(text(root.host), /Gemini:/, 'and says nothing more');
  await act(() => pushSignin(view({ state: 'failed', error: 'denied' })));
  assert.match(text(root.host), /Couldn't sign in to Gemini/);
  // an expired code: one click gets a new one
  await act(() => pushSignin(view({ state: 'expired', error: 'That code expired. Get a new one.' })));
  assert.match(text(root.host), /Gemini: That code expired/);
  await click(button(root.host, 'Get a new code for Gemini on a'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.signin').length, 2);
  // signed in: the row says so through the machine's own list, not the sign-in
  await act(() => pushSignin(view({ state: 'signed-in' })));
  assert.doesNotMatch(text(root.host), /Gemini:/);
});

test('a refusal from main is shown as a toast, for starting and for cancelling', async (t) => {
  responses['host.signin'] = () => Promise.reject(new Error('That machine does not list that agent.'));
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'Sign in to Gemini on a'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['That machine does not list that agent.', 'error']);
  await act(() => pushSignin(view()));
  responses['host.cancelSignin'] = () => Promise.reject(new Error('Host is not available for this account.'));
  await click(button(root.host, 'Cancel signing in to Gemini on a'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Host is not available for this account.', 'error']);
});

test('a machine with nothing to sign in has no button', async (t) => {
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [{ ...ROW, signin: null, status: 'online', agents: [{ ...GEMINI, state: 'ready' }] }], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush();
  assert.equal(buttons(root.host, 'Sign in to Gemini on a').length, 0);
  assert.deepEqual(
    [...root.host.querySelectorAll('button')].filter((b) => /Sign in|Cancel|Get a new code/.test(b.textContent ?? '')),
    [],
  );
});

test('the subscription to main ends with the last window part that shows sign-ins, and holds nothing once access is lost', async () => {
  let seen = new Map();
  const Probe = () => ((seen = useHostSignins() as Map<string, unknown> as any), null);
  const a = await render(h(Probe));
  const b = await render(h(Probe));
  await flush();
  await act(() => pushSignin(view({ codes: ['X'] })));
  assert.deepEqual(seen.get(signinKey('ssh:a', 'gemini')).codes, ['X']);
  await act(() => pushAccess(false));
  assert.equal(seen.size, 0, 'without Host access nothing is shown');
  assert.equal(unsubscribed, 1, 'and nothing is followed');
  await act(() => pushAccess(true));
  await a.unmount();
  assert.equal(unsubscribed, 1, 'another part still shows them');
  await b.unmount();
  assert.equal(unsubscribed, 2);
});

test('a page that was opened and showed no code of its own offers a field for the code typed back; Send passes it on', async (t) => {
  responses['host.signin'] = () => Promise.resolve(view({ state: 'starting' }));
  const typed: unknown[][] = [];
  responses['host.signinInput'] = (...a: unknown[]) => (typed.push(a), Promise.resolve(true));
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush();
  await click(button(root.host, 'Sign in to Gemini on a'));
  await flush();
  const field = () => root.host.querySelector('input[aria-label="Code from the page"]') as HTMLInputElement | null;
  assert.equal(field(), null, 'no page yet');
  await act(() => pushSignin(view({ link: true })));
  assert.ok(field());
  assert.equal(button(root.host, 'Send').disabled, true, 'nothing typed');
  await setValue(field()!, ' abc ');
  await click(button(root.host, 'Send'));
  await flush();
  assert.deepEqual(typed, [['ssh:a', 'gemini', ' abc ']]);
  assert.equal(field()!.value, '', 'sent: the field is empty');
  // Enter sends too, and a code the machine took no more is said
  responses['host.signinInput'] = () => Promise.resolve(false);
  await setValue(field()!, 'late');
  await act(() =>
    field()!.dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  await flush();
  assert.deepEqual(toasts().at(-1), ['That sign-in has ended. Start it again.', 'error']);
  responses['host.signinInput'] = () => Promise.reject(new Error('unknown method loginInput'));
  await click(button(root.host, 'Send'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Unknown method loginInput.', 'error']);
  // a code the machine relayed itself, or an ended sign-in, needs no field
  await act(() => pushSignin(view({ link: true, codes: ['ABCD-1234'] })));
  assert.equal(field(), null);
  await act(() => pushSignin(view({ link: true, state: 'signed-in' })));
  assert.equal(field(), null);
});

test('wantsCode: a running sign-in with a page opened and no relayed code', () => {
  const v = (o: object) => view(o) as any;
  assert.equal(wantsCode(undefined), false);
  assert.equal(wantsCode(v({ link: true })), true);
  assert.equal(wantsCode(v({ link: false })), false);
  assert.equal(wantsCode(v({ link: true, codes: ['X'] })), false);
  assert.equal(wantsCode(v({ link: true, state: 'failed' })), false);
  // Codex's device-code sign-in only polls: a paste field would take a code nothing reads
  assert.equal(wantsCode(v({ link: true, harness: 'codex' })), false);
});
