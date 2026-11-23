// The MoMo tab's Memory and Routines: edits go to the Mac, a sealed copy serves the Mac-away state, and nothing stale lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { fakeCache, hello, momoRuntime, mountMomo, pressQueued, snapshotOf, openPart } from './support/phone/momo-kit';

const fact = (id: string, text: string, over: any = {}) => ({ id, text, ...over });
const input = (placeholder: string) => document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
const buttons = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === name);
function memoryRuntime(over: Record<string, any> = {}, facts = [fact('1', 'Likes tea'), fact('2', 'Old plan', { expiresAt: 5 })]) {
  const store = { facts, aboutYou: 'I am Sam', persona: 'Warm' };
  const m = momoRuntime({
    // a Mac that lets the phone edit and delete routines
    'machine.hello': () => ({
      ...hello(true),
      capabilities: { ...hello(true).capabilities, methods: ['momo.routines.edit', 'momo.routines.delete'] },
    }),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.chat.follow': () => snapshotOf(),
    'momo.chat.unfollow': () => ({}),
    'momo.memory.list': () => ({ facts: store.facts, now: 1000 }),
    'momo.memory.search': ({ query }: any) => ({ facts: store.facts.filter((f) => f.text.includes(query)), now: 1000 }),
    'momo.memory.docs': () => ({ aboutYou: store.aboutYou, persona: store.persona, unreadable: ['persona'] }),
    'momo.memory.edit': ({ factId, text }: any) => void (store.facts = store.facts.map((f) => (f.id === factId ? { ...f, text } : f))),
    'momo.memory.forget': ({ factId }: any) => void (store.facts = store.facts.filter((f) => f.id !== factId)),
    ...over,
  });
  return { m, store };
}

test('memory lists facts, searches, edits, forgets after confirming, and saves documents', async () => {
  const cache = fakeCache();
  const { m, store } = memoryRuntime();
  const view = await mountMomo(m, Promise.resolve(cache));
  await openPart('Memory');
  assert.match(view.text(), /Likes tea/);
  assert.match(view.text(), /Expired/);
  assert.match(view.text(), /Can't be read on your Mac\./);
  assert.match(view.text(), /I am Sam/);
  assert.match(view.text(), /Change this on your Mac/);
  // the whole list is kept sealed on the phone
  assert.doesNotMatch(cache.raw()!, /Likes tea/);
  assert.equal((await cache.load(JSON.stringify(['u', 'p'])))!.facts.length, 2);

  await click('Edit');
  await inputText('Edit fact', 'Likes green tea');
  await click('Save');
  assert.equal(store.facts[0].text, 'Likes green tea');
  assert.match(view.text(), /Likes green tea/);
  await click('Edit');
  await inputText('Edit fact', '  ');
  assert.equal(buttons('Save')[0].disabled, true);
  await click('Cancel');

  await click('Forget');
  await click('Confirm forget');
  assert.deepEqual(
    store.facts.map((f) => f.id),
    ['2'],
  );
  assert.doesNotMatch(view.text(), /green tea/);

  await inputText('Search memory', 'plan');
  await click('Search');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.memory.search').at(-1)![1], { query: 'plan' });
  // a search result never replaces the whole saved copy: the forgotten fact is gone from it, the others stay
  assert.deepEqual(
    (await cache.load(JSON.stringify(['u', 'p'])))!.facts.map((f) => f.id),
    ['2'],
  );
  await inputText('Search memory', 'zzz');
  await click('Search');
  assert.match(view.text(), /Nothing found/);

  await view.unmount();
});

test('a failed edit or forget shows the Mac message and keeps the fact; a second forget is not started twice', async () => {
  const { m } = memoryRuntime({ 'momo.memory.edit': () => Promise.reject(new Error('That fact is no longer in memory')) });
  const view = await mountMomo(m);
  await openPart('Memory');
  await click('Edit');
  await inputText('Edit fact', 'x');
  await click('Save');
  assert.match(view.text(), /no longer in memory/);
  assert.equal(input('Edit fact').value, 'x');
  await view.unmount();
});

test('a memory change on the Mac reloads the list, and an empty memory says so', async () => {
  const { m, store } = memoryRuntime({}, []);
  const view = await mountMomo(m);
  await openPart('Memory');
  assert.match(view.text(), /has not remembered anything/);
  store.facts = [fact('9', 'Fresh fact')];
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'memory' }));
  await flush();
  assert.match(view.text(), /Fresh fact/);
  await view.unmount();
});

test('a list the Mac sends wrongly is refused with a retryable error', async () => {
  const { m } = memoryRuntime({ 'momo.memory.list': () => ({ facts: 'nope' }) });
  const view = await mountMomo(m);
  await openPart('Memory');
  assert.match(view.text(), /Could not read memory/);
  await view.unmount();
});

test('with the Mac away the saved copy is shown, searchable and read-only', async () => {
  const cache = fakeCache();
  const { m } = memoryRuntime();
  const view = await mountMomo(m, Promise.resolve(cache));
  await openPart('Memory');
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  assert.match(view.text(), /Saved copy from your Mac/);
  assert.match(view.text(), /Likes tea/);
  assert.equal(buttons('Edit')[0].disabled, true);
  assert.equal(buttons('Forget')[0].disabled, true);
  await inputText('Search memory', 'old');
  await click('Search');
  assert.match(view.text(), /Old plan/);
  assert.doesNotMatch(view.text(), /Likes tea/);
  await view.unmount();
});

test('with the Mac away and nothing saved, or no storage at all, memory says to connect', async () => {
  for (const open of [() => Promise.resolve(fakeCache()), () => Promise.resolve(null), () => undefined]) {
    const { m } = memoryRuntime();
    const view = await mountMomo(m, open() as any);
    m.set({ phase: 'offline', selectedPair: null, generation: 2 });
    await openPart('Memory');
    assert.match(view.text(), /Nothing saved yet/);
    await view.unmount();
  }
});

test('an offline copy without documents shows facts only, and a failing copy write does not hide the list', async () => {
  const cache = fakeCache();
  await cache.save(JSON.stringify(['u', 'p']), { facts: [fact('1', 'Cached only')], docs: null });
  const { m } = memoryRuntime();
  const view = await mountMomo(m, Promise.resolve(cache));
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await openPart('Memory');
  assert.match(view.text(), /Cached only/);
  assert.doesNotMatch(view.text(), /About you/);
  await view.unmount();

  const failing: any = { save: () => Promise.reject(new Error('disk full')), load: async () => null, clear: async () => {} };
  const { m: n } = memoryRuntime();
  const second = await mountMomo(n, Promise.resolve(failing));
  await openPart('Memory');
  assert.match(second.text(), /Likes tea/);
  await second.unmount();
});

const proposal = {
  id: 'r1',
  name: 'Morning brief',
  prompt: 'Summarize my day',
  schedule: 'Every day at 8:00',
  sources: 'Calendar',
  rev: 3,
};
const routine = { id: 'r2', name: 'Weekly review', schedule: 'Fridays at 17:00', paused: false, prompt: 'Review my week' };

test('MoMo’s page lists routines and suggestions; a suggestion is approved at the shown version or declined, a routine paused, resumed, run or edited', async () => {
  let state = {
    proposals: [proposal, { ...proposal, id: 'r3', name: 'Other', sources: '' }],
    routines: [routine, { ...routine, id: 'r4', name: 'Paused one', paused: true }],
  };
  const { m } = memoryRuntime({
    'momo.routines.list': () => state,
    'momo.routines.approve': () => void (state = { ...state, proposals: state.proposals.slice(1) }),
    'momo.routines.delete': () => ({ deleted: true }),
    'momo.routines.pause': () => undefined,
    'momo.routines.resume': () => undefined,
    'momo.routines.run': () => undefined,
    'momo.routines.edit': () => ({ routine: {} }),
  });
  const view = await mountMomo(m);
  await openPart('Routines');
  assert.match(view.text(), /Weekly reviewFridays at 17:00On.*Paused oneFridays at 17:00Paused.*Morning briefSuggested by MoMoReview/);
  await click('Morning brief, Review');
  assert.match(view.text(), /Suggested by MoMo · Every day at 8:00Summarize my dayReads: Calendar/);
  await click('Approve');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.approve')![1], { id: 'r1', seen: 3 });
  // done with, the routine goes back to the list, read again
  assert.match(view.text(), /Scheduled/);
  await click('Other, Review');
  await click('Decline');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.delete')![1], { id: 'r3' });
  await click('Weekly review, On');
  await click('Pause');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.pause')![1], { id: 'r2' });
  await click('Paused one, Paused');
  await click('Resume');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.resume')![1], { id: 'r4' });
  await click('Weekly review, On');
  await click('Run now');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.run')![1], { id: 'r2' });
  await click('Weekly review, On');
  assert.equal((buttons('Save')[0] as HTMLButtonElement).disabled, true, 'nothing changed yet');
  await inputText('Name', 'Friday review');
  await inputText('What it does', 'Review my week and plan Monday');
  await click('Save');
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.edit')![1], {
    id: 'r2',
    edit: { name: 'Friday review', prompt: 'Review my week and plan Monday' },
  });
  // only what it does changed: the name is not sent
  await click('Weekly review, On');
  await inputText('What it does', 'Plan Monday');
  await click('Save');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.routines.edit').at(-1)![1], { id: 'r2', edit: { prompt: 'Plan Monday' } });
  await click('Weekly review, On');
  // deleting asks once more, as forgetting a memory does: the first tap sends nothing, Cancel leaves the routine as it was
  const deletes = m.count('momo.routines.delete'); // declining the suggestion above used the same call
  await click('Delete routine');
  assert.equal(m.count('momo.routines.delete'), deletes, 'one tap does not delete');
  assert.ok(buttons('Confirm delete').length === 1 && buttons('Cancel').length === 1);
  await click('Cancel');
  assert.equal(m.count('momo.routines.delete'), deletes);
  assert.equal(buttons('Confirm delete').length, 0, 'back to the first state');
  await click('Delete routine');
  await click('Confirm delete');
  assert.deepEqual(m.calls.filter(([method]) => method === 'momo.routines.delete').at(-1)![1], { id: 'r2' });
  await view.unmount();
});

test('a routine action that fails shows why in the page, a second queued tap while one runs is ignored, and a routine without its prompt edits its name only', async () => {
  let release: () => void = () => {};
  const { m } = memoryRuntime({
    'momo.routines.list': () => ({ proposals: [], routines: [{ ...routine, prompt: undefined }] }),
    'momo.routines.edit': () => new Promise<void>((resolve) => (release = resolve)),
    'momo.routines.run': () => Promise.reject(new Error('Routine is gone')),
  });
  const view = await mountMomo(m);
  await openPart('Routines');
  await click('Weekly review, On');
  await click('Run now');
  assert.match(view.text(), /Routine is gone/);
  assert.equal(document.querySelector('input[placeholder="What it does"]'), null);
  await inputText('Name', 'Renamed');
  await click('Save');
  await pressQueued('Save');
  assert.equal(m.count('momo.routines.edit'), 1);
  assert.deepEqual(m.calls.find(([method]) => method === 'momo.routines.edit')![1], { id: 'r2', edit: { name: 'Renamed' } });
  await act(async () => release());
  await flush();
  await view.unmount();

  const empty = memoryRuntime({ 'momo.routines.list': () => ({ proposals: [], routines: [] }) });
  const second = await mountMomo(empty.m);
  await openPart('Routines');
  assert.doesNotMatch(second.text(), /Scheduled/, 'no routines: no Scheduled section');
  await second.unmount();
});

test('a Mac that does not list routine edits and deletes offers neither: no Save, Delete or Decline', async () => {
  const { m } = memoryRuntime({
    'machine.hello': () => hello(true),
    'momo.routines.list': () => ({ proposals: [proposal], routines: [routine] }),
  });
  const view = await mountMomo(m);
  await openPart('Routines');
  await click('Weekly review, On');
  assert.ok(buttons('Pause').length);
  assert.equal(buttons('Save').length, 0);
  assert.equal(buttons('Delete routine').length, 0);
  assert.equal(document.querySelector('input[placeholder="Name"]'), null);
  await click('Dismiss');
  await openPart('Routines');
  await click('Morning brief, Review');
  assert.ok(buttons('Approve').length);
  assert.equal(buttons('Decline').length, 0);
  await view.unmount();
});

test('with the Mac away MoMo’s page shows no routines rather than old ones', async () => {
  const { m } = memoryRuntime({ 'momo.routines.list': () => ({ proposals: [], routines: [routine] }) });
  const view = await mountMomo(m);
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  await openPart('Routines');
  assert.match(view.text(), /Offline/);
  assert.doesNotMatch(view.text(), /Weekly review/);
  await view.unmount();
});

test('an empty document says so, a second queued edit while one runs is ignored, and a plain-text failure is shown', async () => {
  let release: () => void = () => {};
  const { m } = memoryRuntime({
    'momo.memory.docs': () => ({ aboutYou: '', persona: 'Warm', unreadable: [] }),
    'momo.memory.forget': () => new Promise<void>((resolve) => (release = resolve)),
    'momo.memory.edit': () => Promise.reject('plain failure'),
  });
  const view = await mountMomo(m);
  await openPart('Memory');
  assert.match(view.text(), /Nothing written yet/);
  await click('Edit');
  await inputText('Edit fact', 'x');
  await click('Save');
  assert.match(view.text(), /plain failure/);
  await click('Cancel');
  await click('Forget');
  await act(async () => buttons('Confirm forget')[0].click());
  await pressQueued('Confirm forget');
  assert.equal(m.count('momo.memory.forget'), 1);
  await act(async () => release());
  await flush();
  await view.unmount();
});

test('facts read for another computer are not kept while the next read runs or when it fails', async () => {
  let fail = false;
  const { m } = memoryRuntime({
    'momo.memory.list': () => (fail ? Promise.reject(new Error('second computer is down')) : { facts: [fact('1', 'Likes tea')], now: 1 }),
  });
  const view = await mountMomo(m);
  await openPart('Memory');
  assert.match(view.text(), /Likes tea/);
  fail = true;
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  m.set({ phase: 'online', selectedPair: 'q', generation: 3 });
  await flush();
  assert.match(view.text(), /second computer is down/);
  assert.doesNotMatch(view.text(), /Likes tea/);
  await view.unmount();
});
