// The chat's follow-the-end and the keys of its rows after the review: a failure holds the page at the top and gives the end back when it is gone or the person reaches the end; a notice told on a timer does not move the page; a Host's update of a draft is shown; two actions with one label stay two buttons.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from './support/phone/component-kit';
import { find, flush, mount, tap, unmountAll } from './support/phone/momo-screens';

const g = globalThis as any;
afterEach(async () => {
  g.__phoneFontScale = undefined;
  await unmountAll();
});

const older = {
  id: 'p1',
  code: 'older_home',
  cause: 'Studio has an older MoMo.',
  fix: { id: 'use-older:studio', label: 'Use it' },
  also: [],
};
const grow = () => act(async () => g.__scrollEvents.onContentSizeChange(0, 4000));
const atEnd = () =>
  act(async () =>
    g.__scrollEvents.onScroll({
      nativeEvent: { contentOffset: { y: 3900 }, contentSize: { height: 4000 }, layoutMeasurement: { height: 100 } },
    }),
  );

async function failed() {
  g.__scrolledTo = [];
  const m = await mount((v) => v.problems.push({ ...older }));
  m.transport.fail({ ok: false, cause: 'Studio did not answer.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' });
  await tap('Use it');
  assert.match(m.text(), /Studio did not answer\./);
  return m;
}

test('a failure holds the page at the top, and the chat follows its end again once the notice is dismissed', async () => {
  const m = await failed();
  g.__scrolledToEnd = [];
  await grow();
  assert.deepEqual(g.__scrolledToEnd, [], 'while the notice is shown the page is not carried to the end');
  await act(async () => m.store.dismissFailure());
  await flush();
  await grow();
  assert.equal(g.__scrolledToEnd.length, 1, 'with the notice gone the chat follows its end again');
});

test('the person reaching the end of the chat gives the end back too', async () => {
  await failed();
  g.__scrolledToEnd = [];
  await atEnd();
  await grow();
  assert.equal(g.__scrolledToEnd.length, 1);
});

test('a notice told on a timer does not move the page', async () => {
  const m = await mount((v) => v.problems.push({ ...older }));
  const listeners = new Set<() => void>();
  const tell = () => act(async () => listeners.forEach((l) => l()));
  let late: any = null;
  const real = m.store;
  const store = {
    ...real,
    get: () => ({ ...real.get(), failure: late }),
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  };
  await m.rerender({ store });
  g.__scrolledTo = [];
  g.__scrolledToEnd = [];
  late = { cause: 'It hasn’t changed yet.', fix: null, late: true };
  await tell();
  await flush();
  assert.match(m.text(), /It hasn’t changed yet\./);
  assert.deepEqual(g.__scrolledTo, [], 'the page stays where the person is reading');
  // a failure of the person's own press does move it
  late = { cause: 'Studio did not answer.', fix: null };
  await tell();
  await flush();
  assert.equal(g.__scrolledTo.at(-1)?.y, 0);
});

const draftRow = (body: string) => ({
  kind: 'draft',
  id: 'draft:x',
  at: 1,
  draft: { to: ['ana@acme.example'], subject: 'Re: Acme renewal', body },
  matter: { key: 'k', title: 'Acme renewal' },
  untrusted: true,
  truncated: false,
});

test('a Host’s update of a draft row replaces what is shown, and an edit under way on the old text is dropped', async () => {
  const m = await mount((v) => v.chat.splice(0, v.chat.length, draftRow('Thursday works for me.')));
  assert.match(m.text(), /Thursday works for me\./);
  await tap('Edit');
  assert.ok(find('Done'), 'editing');
  m.view.view.chat = m.view.view.chat.map((r: any) => (r.id === 'draft:x' ? draftRow('Friday works instead.') : r));
  m.transport.emit({ view: m.view.view });
  await flush();
  assert.match(m.text(), /Friday works instead\./);
  assert.doesNotMatch(m.text(), /Thursday works for me\./);
});

test('two actions with one label are two buttons, each with its own intent', async () => {
  const m = await mount((v) =>
    v.chat.push({
      kind: 'result',
      id: 'r:x',
      at: 1,
      result: {
        taskId: 't1',
        title: 'Quote',
        state: 'done',
        summary: 'Ready.',
        machine: { machineId: 'studio', name: 'Studio' },
        files: [],
        actions: [
          { id: 'a1', label: 'Open' },
          { id: 'a2', label: 'Open' },
        ],
      },
    }),
  );
  const opens = [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Open');
  assert.equal(opens.length, 2);
  for (const b of opens) await act(async () => (b as HTMLElement).click());
  await flush();
  assert.deepEqual(
    m.sent.filter((i: any) => i.kind === 'task-act').map((i: any) => i.fixId),
    ['a1', 'a2'],
  );
});

test('two actions with the same label and the same intent are still two buttons', async () => {
  const m = await mount((v) =>
    v.chat.push({
      kind: 'result',
      id: 'r:y',
      at: 1,
      result: {
        taskId: 't1',
        title: 'Quote',
        state: 'done',
        summary: 'Ready.',
        machine: { machineId: 'studio', name: 'Studio' },
        files: [],
        actions: [
          { id: 'a1', label: 'Open' },
          { id: 'a1', label: 'Open' },
        ],
      },
    }),
  );
  const opens = [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Open');
  assert.equal(opens.length, 2);
  assert.ok(m.text().includes('Ready.'));
});
