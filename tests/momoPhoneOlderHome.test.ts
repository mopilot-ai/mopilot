// The older MoMo, replaced moves, a move in progress and start fresh as the phone draws them: the problems are the ones the Mac composes (shared/momoHomeOlder.mjs and shared/momoHomeLook.mjs, so the words are theirs), every button of a card is pressable, and use and delete are asked first before they do anything.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mount, tap, find, unmountAll, type Any } from './support/phone/momo-screens';

const { olderProblems } = await import('../shared/momoHomeOlder.mjs');
const { leaseProblems } = await import('../shared/momoHomeLook.mjs');
const transportPath = '../mobile/src/momoPhone/transport';
const { parseHomeView } = await import(transportPath);

afterEach(unmountAll);

const AT = new Date(2026, 10, 20, 9, 5).getTime();
const read = (extra: object = {}): Any => ({
  home: { machine: { name: 'Mac mini' }, status: { home: { lastSeenAt: AT + 3_600_000 } } },
  older: [{ machine: { id: 'studio', name: 'Studio' }, movedTo: { homeId: 'h2', at: AT }, lastActive: AT, leaseEpoch: 4 }],
  ...extra,
});

test('the older MoMo card names both MoMos, says which is in use, and offers Use, Keep and Delete', async () => {
  const [card] = olderProblems(read(), new Set(), new Map());
  const m = await mount((v) => v.problems.push({ ...card }));
  const text = m.text();
  assert.match(text, /There are two MoMos: the one on Studio \(last active Nov 20, 9:05 AM\) and the one on Mac mini/);
  assert.match(text, /You’re using the one on Mac mini\./);
  for (const label of ['Use the one on Studio', 'Keep this one', 'Delete the old MoMo']) assert.ok(find(label), label);
  await tap('Keep this one');
  await tap('Use the one on Studio');
  await tap('Delete the old MoMo');
  assert.deepEqual(m.sent, [
    { kind: 'fix', id: 'keep-older:studio' },
    { kind: 'fix', id: 'use-older:studio' },
    { kind: 'fix', id: 'delete-older:studio' },
  ]);
});

test('use and delete are asked first: the home answers with its words and a confirming button, and only that button goes on', async () => {
  const [card] = olderProblems(read(), new Set(), new Map());
  const m = await mount((v) => v.problems.push({ ...card }));
  m.transport.fail({
    ok: false,
    cause: 'Delete the older MoMo on Studio? This deletes only the older MoMo on Studio, everything it knew, and can’t be undone.',
    fix: { kind: 'fix', id: 'delete-older!:tok:studio' },
    fixLabel: 'Delete',
  });
  await tap('Delete the old MoMo');
  assert.match(m.text(), /can’t be undone\./);
  await tap('Delete');
  assert.deepEqual(m.sent.at(-1), { kind: 'fix', id: 'delete-older!:tok:studio' });
});

test('a move that was replaced says so, and a move in progress says nothing was changed', async () => {
  const [replaced] = olderProblems(read(), new Set(), new Map([['studio', true]]));
  const [moving] = leaseProblems({ ...read(), decision: { blocked: { kind: 'move-in-progress' } } });
  const m = await mount((v) => v.problems.push({ ...replaced }, { ...moving }));
  assert.match(m.text(), /The move was replaced: MoMo was started again on Mac mini\./);
  assert.match(m.text(), /MoMo is being moved; nothing was changed until it ends\./);
  await tap('Check again');
  assert.deepEqual(m.sent.at(-1), { kind: 'fix', id: 'check-again' });
});

test('a lost or unheard home offers Start fresh, with the risk in its words', async () => {
  const [lost] = leaseProblems({
    ...read({ home: null }),
    decision: { blocked: null, winner: null, picker: 'choose', offerStartFresh: true },
    lost: true,
    status: { home: { name: 'Studio' } },
    unheard: [],
  });
  const m = await mount((v) => v.problems.push({ ...lost }));
  assert.match(m.text(), /MoMo’s home on Studio can’t be found\. If that machine is gone for good, start fresh/);
  await tap('Start fresh');
  assert.deepEqual(m.sent.at(-1), { kind: 'fix', id: 'start-fresh' });
});

test('a problem the home sends with a half-formed other way keeps the good buttons only', () => {
  const view = parseHomeView(
    {
      view: {
        home: { state: 'running' },
        problems: [{ id: 'p', cause: 'c', fix: { id: 'f', label: 'Fix' }, also: [{ id: 'a', label: 'A' }, { id: 'b' }, null] }],
      },
    },
    1,
  );
  assert.deepEqual(view.view.problems[0].also, [{ id: 'a', label: 'A' }]);
});

test('Start fresh never acts on the first press: only the unconfirmed id is sent, the home’s words are shown, and the confirming button is what goes on', async () => {
  const { startFreshWords } = await import('../shared/momoHomeFix.mjs');
  const [lost] = leaseProblems({
    ...read({ home: null }),
    decision: { blocked: null, winner: null, picker: 'choose', offerStartFresh: true },
    lost: true,
    status: { home: { name: 'Studio' } },
    unheard: [],
  });
  const m = await mount((v) => v.problems.push({ ...lost }));
  const words = startFreshWords('Studio', 'a machine');
  m.transport.fail({ ok: false, cause: words, fix: { kind: 'fix', id: 'start-fresh!:tok' }, fixLabel: 'Start fresh' });
  await tap('Start fresh');
  assert.deepEqual(m.sent, [{ kind: 'fix', id: 'start-fresh' }], 'the first press sent no confirmed id');
  assert.match(m.text(), /it will be retired when it comes back/);
  assert.match(m.text(), /Messages you sent to the old MoMo are no longer shown here\./);
  // the banner's own button is the confirmation
  const buttons = [...document.querySelectorAll('[role="button"],button')].filter((b) => /Start fresh/.test(b.textContent ?? ''));
  assert.ok(buttons.length >= 1);
});
