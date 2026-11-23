// What a streamed delta leaves alone in the chat it streams into: the composer area, the rail's entries, and the settled
// step groups and blocks of the running turn; and what re-renders the view at all (runtime fields it does not show do not).
import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, flush, navProps, T, user, reply, turn, view } from './support/thread-view/fixture.ts';

const runtime = (turns: any[], extra: any = {}) => ({ loaded: true, turns, activeTurnId: turns.at(-1)?.id ?? null, ...extra });
const show = (turns: any[], extra: any = {}, thread: any = { id: T, cwd: '/repo' }) =>
  setStore({ threads: { [T]: thread }, runtime: { [T]: runtime(turns, extra) } });
const command = (id: string, extra: any = {}) => ({ id, type: 'commandExecution', command: `run ${id}`, status: 'completed', ...extra });
const { sameStepGroup } = await import('../src/components/thread/items/StepGroups.tsx');
const ids = (name: string, of: (props: any) => string) => rendersOf(name).map(of);

test('a delta renders the transcript, not the composer area; runtime fields and thread metadata it does not show render nothing', async () => {
  const live = (out: string) =>
    turn('t1', [user('u1', 'Go'), command('c1', { status: 'inProgress', aggregatedOutput: out })], { status: 'inProgress' });
  resetCommits();
  show([live('a')]);
  const v = await render(view());
  await flush();
  assert.equal(rendersOf('ComposerArea').length, 1);
  const entries = navProps.items;

  resetCommits();
  await settle(() => show([live('ab')]));
  assert.equal(rendersOf('ThreadView').length, 1);
  // nor what sits under it: the composer and the strips beside it
  assert.deepEqual(rendersOf('ComposerArea'), []);
  // the command's output is not on the rail: its entries keep their array, so the memoized rail does not re-render
  assert.equal(navProps.items, entries);

  // a reply is: the running turn's entry changes, and the rail gets new entries
  resetCommits();
  await settle(() => show([turn('t1', [user('u1', 'Go'), command('c1'), reply('r1', 'Done')], { status: 'inProgress' })]));
  assert.notEqual(navProps.items, entries);
  assert.equal(navProps.items[0].response, 'Done');
  assert.deepEqual(rendersOf('ComposerArea'), []);

  // token usage, a held message, the chat's title: none of them is shown here
  const turns = [turn('t1', [user('u1', 'Go'), reply('r1', 'Done')])];
  await settle(() => show(turns, { activeTurnId: null }));
  resetCommits();
  await settle(() => show(turns, { activeTurnId: null, tokenUsage: { total: 1 }, held: { text: 'x' } }));
  await settle(() => show(turns, { activeTurnId: null, tokenUsage: { total: 2 } }, { id: T, cwd: '/repo', title: 'Renamed' }));
  assert.deepEqual(rendersOf('ThreadView'), []);
  // the same props from its parent render nothing either
  await v.rerender(view());
  assert.deepEqual(rendersOf('ThreadView'), []);

  // the chat's folder is the composer area's: it renders with it
  resetCommits();
  await settle(() => show(turns, { activeTurnId: null }, { id: T, cwd: '/elsewhere', title: 'Renamed' }));
  assert.deepEqual(
    ids('ComposerArea', (p) => p.cwd),
    ['/elsewhere'],
  );
  await v.unmount();
});

test('an approval puts the status strip and the approval in place of the composer, with no confirm step', async () => {
  show([turn('t1', [user('u1', 'Go')], { status: 'inProgress' })]);
  const v = await render(view());
  await flush();
  assert.ok(v.$('[data-stub="Composer"]'));
  resetCommits();
  await settle(() => setStore({ pending: [{ threadId: T }] }));
  assert.deepEqual(
    ids('ComposerArea', (p) => String(p.hasApproval)),
    ['true'],
  );
  const strip = v.$('[data-stub="StatusStrip"]')!;
  assert.equal(strip.dataset.confirm, 'false');
  assert.ok(v.$('[data-stub="Approvals"]'));
  assert.equal(v.$('[data-stub="Composer"]'), null);
  // asking for the confirm step changes nothing while the approval shows
  await settle(() => strip.click());
  assert.equal(v.$('[data-stub="StatusStrip"]')!.dataset.confirm, 'false');
  await v.unmount();
});

test("the running turn's settled step groups and blocks keep their render while its last group streams", async () => {
  // the store keeps a settled item's object while later items change
  const settled = [user('u1', 'Go'), command('c1'), command('c2'), reply('m1', 'Looking around', { phase: 'commentary' })];
  const live = (out: string) =>
    turn('t1', [...settled, command('c3', { status: 'inProgress', aggregatedOutput: out })], {
      status: 'inProgress',
      itemTimes: { m1: { start: 1, end: 2 } },
    });
  resetCommits();
  show([live('a')]);
  const v = await render(view());
  await flush();
  assert.deepEqual(
    ids('StepGroup', (p) => p.items.map((i: any) => i.id).join()),
    ['c1,c2', 'c3'],
  );
  assert.deepEqual(
    ids('BlockItem', (p) => p.item.id),
    ['m1'],
  );

  resetCommits();
  await settle(() => show([live('ab')]));
  await settle(() => show([live('abc')]));
  // only the group whose command streams renders; the settled group and the commentary before it do not
  assert.deepEqual(
    ids('StepGroup', (p) => p.items.map((i: any) => i.id).join()),
    ['c3', 'c3'],
  );
  assert.deepEqual(rendersOf('BlockItem'), []);
  await v.unmount();
});

test('a step group shows the same while its items are the same objects, its narration binds the same apps, and only a running group shows its clock', async () => {
  const a = command('a');
  const b = command('b');
  const apps = (app: string | null) => new Map([['k', { surface: 'desktop' as const, app }]]);
  const group = (extra: any = {}) => ({ items: [a, b], cwd: '/r', active: false, elapsedMs: 1000, narration: apps('Finder'), ...extra });
  // the turn rebuilds the items array and the narration maps on every delta; a settled group's clock is not shown
  assert.equal(sameStepGroup(group(), group({ elapsedMs: 2000 })), true);
  assert.equal(sameStepGroup(group({ narration: undefined }), group({ narration: undefined })), true);
  const narration = apps('Finder');
  assert.equal(sameStepGroup(group({ narration }), group({ narration })), true);
  for (const changed of [
    { cwd: '/s' },
    { active: true },
    { ux: 'dots' },
    { hideTime: true },
    { items: [a] },
    { items: [a, command('b')] },
    { narration: undefined },
    { narration: apps('Safari') },
    { narration: new Map([['other', { surface: 'desktop', app: 'Finder' }]]) },
    { narration: new Map<string, any>([...apps('Finder'), ['k2', { surface: 'browser', app: null }]]) },
    { narration: new Map([['k', { surface: 'browser', app: 'Finder' }]]) },
  ])
    assert.equal(sameStepGroup(group(), group(changed)), false, JSON.stringify(Object.keys(changed)));
  assert.equal(sameStepGroup(group({ narration: undefined }), group()), false);
  // the running group's clock is shown: a tick re-renders it
  assert.equal(sameStepGroup(group({ active: true }), group({ active: true })), true);
  assert.equal(sameStepGroup(group({ active: true }), group({ active: true, elapsedMs: 2000 })), false);
});
