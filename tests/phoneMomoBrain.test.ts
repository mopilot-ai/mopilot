// Changing MoMo's brain from the phone: offered only when the Mac allows it, picked from the Mac's own lists, refused texts shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { hello, momoRuntime, mountMomo, snapshotOf, openPart } from './support/phone/momo-kit';

const base = (allowed: boolean | undefined, extra: Record<string, any> = {}) => ({
  'machine.hello': () => hello(true, allowed),
  'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'Model One' } }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.chat.follow': () => snapshotOf(),
  'momo.chat.unfollow': () => ({}),
  'harnesses.list': () => ({
    harnesses: [
      { id: 'claude', label: 'Agent A' },
      { id: 'codex', label: 'Agent B' },
    ],
  }),
  'projects.list': () => ({ projects: [] }),
  'options.get': ({ harness }: any) => ({
    models: [{ id: `${harness}-fast`, label: `${harness} fast`, efforts: [] }],
    model: `${harness}-fast`,
    accounts: [{ id: 'acct', label: 'Work', loggedIn: true }],
    permission: { rows: [], value: null },
  }),
  ...extra,
});
const buttons = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === name);

test('no picker unless the Mac allows phones to change the brain', async () => {
  for (const flag of [undefined, false]) {
    const m = momoRuntime(base(flag));
    const view = await mountMomo(m);
    // the brain is shown, but this Mac keeps the choice to itself
    await openPart('Brain');
    assert.match(view.text(), /ModelModel One/);
    assert.doesNotMatch(view.text(), /Use this brain/);
    await view.unmount();
  }
});

test('the picker lists the Mac agents, accounts and models, saves the pick and refreshes the chip', async () => {
  let label = 'Model One';
  const m = momoRuntime(
    base(true, {
      'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm', modelLabel: label } }),
      'momo.brain.set': () => ((label = 'codex fast'), { brain: {} }),
    }),
  );
  const view = await mountMomo(m);
  await openPart('Brain');
  assert.equal(buttons('Use this brain')[0].disabled, true);
  await click('Agent B');
  await click('Work');
  await click('Use this brain');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.brain.set')![1], {
    brain: { harness: 'codex', account: 'acct', model: 'codex-fast', modelLabel: 'codex fast' },
  });
  assert.doesNotMatch(view.text(), /Use this brain/);
  await openPart('Brain');
  assert.match(view.text(), /Modelcodex fast/);
  await view.unmount();
});

test('a refused change shows the Mac message and can be retried or cancelled', async () => {
  let fail = true;
  const m = momoRuntime(base(true, { 'momo.brain.set': () => (fail ? Promise.reject('Allow brain changes from this Mac first.') : {}) }));
  const view = await mountMomo(m);
  await openPart('Brain');
  await click('Agent A');
  await click('Use this brain');
  assert.match(view.text(), /Allow brain changes from this Mac first/);
  fail = false;
  await click('Use this brain');
  assert.doesNotMatch(view.text(), /Allow brain changes/);
  await openPart('Brain');
  await click('Cancel');
  assert.doesNotMatch(view.text(), /Use this brain/, 'Cancel closes the Brain sheet');
  await view.unmount();
});

test('a computer that cannot list its agents or models shows why', async () => {
  const none = momoRuntime(base(true, { 'harnesses.list': () => Promise.reject(new Error('Computer is offline')) }));
  const view = await mountMomo(none);
  await openPart('Brain');
  assert.match(view.text(), /offline or asleep/);
  await view.unmount();

  const slow = momoRuntime(base(true, { 'harnesses.list': () => new Promise(() => {}) }));
  const loading = await mountMomo(slow);
  await openPart('Brain');
  assert.match(loading.text(), /Loading your computer's options/);
  await loading.unmount();

  const noModels = momoRuntime(base(true, { 'options.get': () => Promise.reject(new Error('no models')) }));
  const second = await mountMomo(noModels);
  await openPart('Brain');
  await click('Agent A');
  await flush();
  assert.match(second.text(), /no models/);
  await second.unmount();
});

test('a model the Mac names but does not list is saved without a label, and late failures after closing are dropped', async () => {
  const m = momoRuntime(
    base(true, {
      'options.get': () => ({
        models: [{ id: 'listed', label: 'Listed', efforts: [] }],
        model: 'ghost',
        accounts: [],
        permission: { rows: [], value: null },
      }),
      'momo.brain.set': () => ({}),
    }),
  );
  const view = await mountMomo(m);
  await openPart('Brain');
  await click('Agent A');
  await click('Use this brain');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.brain.set')![1], {
    brain: { harness: 'claude', account: null, model: 'ghost', modelLabel: null },
  });
  await view.unmount();

  let failStart: (e: unknown) => void = () => {};
  const early = momoRuntime(base(true, { 'harnesses.list': () => new Promise((_, reject) => (failStart = reject)) }));
  const closing = await mountMomo(early);
  await openPart('Brain');
  await closing.unmount();
  failStart(new Error('late harness failure'));
  await new Promise((resolve) => setImmediate(resolve));

  let failOptions: (e: unknown) => void = () => {};
  const pending = momoRuntime(base(true, { 'options.get': () => new Promise((_, reject) => (failOptions = reject)) }));
  const second = await mountMomo(pending);
  await openPart('Brain');
  await click('Agent A');
  await click('Cancel');
  failOptions(new Error('late options failure'));
  await flush();
  assert.doesNotMatch(second.text(), /late options failure/);
  await second.unmount();
});

test('lists that arrive after the picker closed are dropped', async () => {
  let finishStart: (v: unknown) => void = () => {};
  const early = momoRuntime(base(true, { 'harnesses.list': () => new Promise((resolve) => (finishStart = resolve)) }));
  const closing = await mountMomo(early);
  await openPart('Brain');
  await closing.unmount();
  finishStart({ harnesses: [{ id: 'claude', label: 'Agent A' }] });
  await new Promise((resolve) => setImmediate(resolve));

  let finishOptions: (v: unknown) => void = () => {};
  const pending = momoRuntime(base(true, { 'options.get': () => new Promise((resolve) => (finishOptions = resolve)) }));
  const second = await mountMomo(pending);
  await openPart('Brain');
  await click('Agent A');
  await click('Cancel');
  finishOptions({ models: [], model: null, accounts: [], permission: { rows: [], value: null } });
  await flush();
  assert.doesNotMatch(second.text(), /Use this brain/);
  await second.unmount();
});
