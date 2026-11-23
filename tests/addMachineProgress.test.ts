// The Add machine card while an add runs (src/components/pages/settings/InstallCard.tsx, AddMachineSheet.tsx): which of the six phases it is in, the bytes of an upload, what MoPilot does on its own, a step that stopped moving with Keep waiting and Cancel, and Cancel itself, which ends the add as "Cancelled" and never as a failure.
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

let pushStep: (v: unknown) => void = () => undefined;
let pushPrompt: (v: unknown) => void = () => undefined;
beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': (cb: any) => ((pushStep = cb), () => undefined),
    'host.onPrompt': (cb: any) => ((pushPrompt = cb), () => undefined),
    'host.onSignin': () => () => undefined,
  });
  calls.length = 0;
});

const step = (destination: string, extra: object) => ({
  destination,
  step: { id: 'node', label: 'Set up Node', state: 'running', output: '', ...extra },
});
const line = (root: Element) => text(root.querySelector('.host-install-line'));

/** The sheet with an add of `typed` under way that never ends by itself. */
async function adding(t: any, typed = 'me@box') {
  responses['host.add'] = () => new Promise(() => undefined);
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, typed);
  await click(button(view.host, 'Add'));
  return view;
}

test('the line names the phase (n of 6), an upload shows its bytes, and a step with no phase keeps the plain line', async (t) => {
  const view = await adding(t);
  assert.equal(line(view.host), 'Setting up me@box…');
  assert.equal(view.host.querySelector('progress'), null);
  await act(() => pushStep(step('me@box', { id: 'node', index: 3, total: 6, progress: { done: 20, total: 80 } })));
  assert.equal(line(view.host), 'Step 3 of 6 · Copying Node');
  const bar = view.host.querySelector('progress') as HTMLProgressElement;
  assert.deepEqual([bar.value, bar.max, bar.getAttribute('aria-label')], [20, 80, 'Copying Node']);
  // a count that has passed its total shows full, and a phase this app has no name for shows the step's own label
  await act(() => pushStep(step('me@box', { id: 'extra', label: 'Extra', index: 7, total: 7, progress: { done: 99, total: 80 } })));
  assert.equal(line(view.host), 'Step 7 of 7 · Extra');
  assert.equal((view.host.querySelector('progress') as HTMLProgressElement).value, 80);
  // an upload that has not said how big it is shows no bar; bytes with no phase are labelled by the step
  await act(() => pushStep(step('me@box', { id: 'up', label: 'Upload', progress: { done: 1, total: 0 } })));
  assert.equal(view.host.querySelector('progress'), null);
  await act(() => pushStep(step('me@box', { id: 'up', label: 'Upload', progress: { done: 1, total: 10 } })));
  assert.equal((view.host.querySelector('progress') as HTMLProgressElement).getAttribute('aria-label'), 'Upload');
  assert.equal(line(view.host), 'Setting up me@box…');
});

test('what MoPilot does on its own is said while it runs', async (t) => {
  const view = await adding(t);
  await act(() => pushStep(step('me@box', { notice: 'MoPilot adds its own key to ~/.ssh/authorized_keys.' })));
  assert.match(text(view.host), /MoPilot adds its own key to ~\/\.ssh\/authorized_keys\./);
});

test('a step that stopped moving says so with Keep waiting and Cancel; Keep waiting is quiet until it stalls again', async (t) => {
  const view = await adding(t);
  await act(() => pushStep(step('me@box', { index: 3, total: 6, stalled: true })));
  assert.equal(line(view.host), 'Taking longer than usual…');
  await click(button(view.host, 'Keep waiting'));
  assert.equal(line(view.host), 'Step 3 of 6 · Copying Node');
  assert.throws(() => button(view.host, 'Keep waiting'));
  await act(() => pushStep(step('me@box', { index: 3, total: 6, stalled: false })));
  await act(() => pushStep(step('me@box', { index: 3, total: 6, stalled: true })));
  assert.equal(line(view.host), 'Taking longer than usual…');
  assert.ok(button(view.host, 'Cancel'));
});

test('Cancel stops the add by its normal address, even when it was typed as a URL, and a failing cancel changes nothing', async (t) => {
  const seen: string[] = [];
  responses['host.cancelAdd'] = (d: string) => (seen.push(d), Promise.resolve(true));
  const view = await adding(t, 'ssh://me@box:2222/');
  // main names its events by the address as typed (and a later one by its normal form): both are this add
  assert.equal(line(view.host), 'Setting up me@box:2222…');
  await act(() => pushStep(step('ssh://me@box:2222/', { index: 1, total: 6 })));
  assert.equal(line(view.host), 'Step 1 of 6 · Connecting');
  await act(() => pushStep(step('me@box:2222', { index: 2, total: 6 })));
  assert.equal(line(view.host), 'Step 2 of 6 · Checking sign-in');
  await click(button(view.host, 'Cancel'));
  assert.deepEqual(seen, ['me@box:2222']);
  responses['host.cancelAdd'] = () => Promise.reject(new Error('gone'));
  await click(button(view.host, 'Cancel'));
  assert.equal(line(view.host), 'Step 2 of 6 · Checking sign-in');
});

for (const [rolledBack, said] of [
  [true, 'Cancelled. Nothing was left on the machine.'],
  [undefined, 'Cancelled.'],
] as const)
  test(`a cancelled add ends as one quiet line (${said}), not as a failure`, async (t) => {
    responses['host.add'] = () =>
      Promise.resolve({
        ok: false,
        paired: false,
        error: 'Cancelled',
        id: '',
        steps: [{ id: 'node', label: 'Set up Node', state: 'failed', output: 'killed' }],
        cancelled: true,
        rolledBack,
      });
    const view = await renderMachines();
    t.after(() => view.unmount());
    await flush();
    await click(button(view.host, 'Add machine'));
    await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
    await click(button(view.host, 'Add'));
    assert.equal(line(view.host), said);
    assert.equal(view.host.querySelector('[role=alert]'), null);
    assert.equal(view.host.querySelector('details'), null);
    assert.equal(button(view.host, 'Add').disabled, false);
  });

test('an address that is not an ssh address keeps its typed form as its name', async () => {
  const { normalDestination } = await import('../src/lib/hostAddress.ts');
  assert.equal(normalDestination('ssh://me@box:2222/'), 'me@box:2222');
  assert.equal(normalDestination('@'), '@');
});

test('while ssh asks a question the card has no Cancel of its own: the question’s Cancel is the only one', async (t) => {
  const view = await adding(t);
  await act(() => pushStep(step('me@box', { index: 2, total: 6 })));
  assert.equal([...view.host.querySelectorAll('button')].filter((b) => text(b) === 'Cancel').length, 1);
  await act(() =>
    pushPrompt({ id: 'q1', destination: 'me@box', prompt: { kind: 'hostKey', host: 'box', keyType: 'ED25519', fingerprint: 'SHA256:x' } }),
  );
  assert.equal([...view.host.querySelectorAll('button')].filter((b) => text(b) === 'Cancel').length, 1);
  assert.ok(button(view.host, 'Connect'));
  await act(() => pushPrompt({ id: 'q1', destination: 'me@box', prompt: null }));
  assert.equal([...view.host.querySelectorAll('button')].filter((b) => text(b) === 'Cancel').length, 1);
});
