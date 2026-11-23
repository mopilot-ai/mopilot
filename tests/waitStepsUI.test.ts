// A wait draws as a step in its group (its row, the group's summary, the running line's countdown), and repeated checks
// fold into one poll row in the turn, open to every check and its status message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, text, user, reply, turn, chat, view } from './support/thread-view/fixture.ts';

const { StepGroup } = await import('../src/components/thread/Items.tsx');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { itemSteps } = await import('../src/components/thread/items/stepModel.ts');
const { TurnTimingContext } = await import('../src/components/thread/items/turnTiming.ts');
const { PollRow } = await import('../src/components/thread/items/PollRow.tsx');
const { foldPolls } = await import('../src/components/thread/items/pollRuns.ts');
const { buildBlocks } = await import('../src/components/thread/items/stepModel.ts');

const sleep = (id: string, durationMs: number | null = 50_000) => ({ id, type: 'sleep', durationMs }) as any;
const cmd = (id: string, command: string, extra: any = {}): any => ({
  id,
  type: 'commandExecution',
  command,
  status: 'completed',
  commandActions: [],
  ...extra,
});
const timed = (timeOf: (id: string) => any, child: any) => h(TurnTimingContext.Provider, { value: { timeOf, interrupted: false } }, child);

test('a wait row says how long it waited; a leading sleep reads as the wait before its command', async (t) => {
  const v = await render(h(StepRow, { step: { kind: 'wait', item: sleep('s'), ms: 50_000 } as any, cwd: '/r' }));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.step-text')), 'Waited 50s');
  assert.ok(v.$('.step-icon svg'), 'the clock, shown while it runs or when it failed');
  await v.rerender(h(StepRow, { step: { kind: 'wait', item: sleep('s', null), ms: null } as any, cwd: '/r' }));
  assert.equal(text(v.$('.step-text')), 'Waited');
  const lead = (item: any) =>
    h(StepRow, { step: { kind: 'command', item, network: false, wait: { ms: 50_000, rest: 'gh api x', loop: false } } as any, cwd: '/r' });
  await v.rerender(lead(cmd('c', 'sleep 50 && gh api x')));
  assert.equal(text(v.$('.step-text')), 'Waited 50s, then ran gh api x');
  // declined, it ran nothing: no wait (itemSteps), so the whole command, as declined commands read
  const [declined] = itemSteps(cmd('c', 'sleep 50 && gh api x', { status: 'declined' }));
  await v.rerender(h(StepRow, { step: declined, cwd: '/r' }));
  assert.equal(text(v.$('.step-text')), 'Declined sleep 50 && gh api x');
});

test('a settled group sums its wait; the running line counts the wait down and says it waited once it ended', async (t) => {
  const v = await render(h(StepGroup, { items: [sleep('s'), cmd('c', 'gh api x')], cwd: '/r', active: false }));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.step-row.summary .step-text')), 'Ran a command, waited 50s');
  // running, the Codex look: the wait shimmers with what is left of it
  const started = Date.now() - 10_000;
  await v.rerender(timed(() => ({ start: started }), h(StepGroup, { items: [cmd('c', 'ls'), sleep('s')], cwd: '/r', active: true })));
  assert.match(text(v.$('.step-row.active .shimmer')), /^Waiting 50s · (39|40)s left$/);
  assert.ok(v.$('.step-row.active .step-icon svg'), 'a wait running shows its clock');
  // its item ended while the model thinks: it waited, and the thinking glyph takes the icon's place
  await v.rerender(
    timed(() => ({ start: started, end: Date.now() }), h(StepGroup, { items: [cmd('c', 'ls'), sleep('s')], cwd: '/r', active: true })),
  );
  assert.equal(text(v.$('.step-row.active .shimmer')), 'Waited 50s');
  assert.equal(v.$('.step-row.active .step-icon'), null);
  // the Claude look: the running row names the wait
  const dots = await render(timed(() => ({ start: started }), h(StepGroup, { items: [sleep('s')], cwd: '/r', active: true, ux: 'dots' })));
  t.after(() => dots.unmount());
  assert.match(text(dots.$('.claude-activity-label')), /^Waiting 50s · (39|40)s left/);
});

const check = (n: number) => [sleep(`s${n}`), cmd(`c${n}`, 'gh api repos/o/r/actions/runs/1/jobs')];
const status = (n: number) => reply(`m${n}`, `Still queued (${n}).`);

test('a poll row: one summary that opens to each check and the status message after it', async (t) => {
  const items = [...check(1), status(1), ...check(2), status(2), ...check(3)];
  const [poll] = foldPolls(buildBlocks(items as any)) as any[];
  const narrated: string[] = [];
  const v = await render(
    h(PollRow, {
      block: poll,
      cwd: '/r',
      narrationOf: (id: string) => {
        narrated.push(id);
        return undefined;
      },
    }),
  );
  t.after(() => v.unmount());
  const head = v.$('.poll-run > .step-row.summary')!;
  assert.equal(
    text(head.querySelector('.step-text')),
    'Ran the same command 3 times, waited 2m 30s · gh api repos/o/r/actions/runs/1/jobs',
  );
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(v.$('.poll-checks'), null);
  await settle(() => head.click());
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.match(v.$('.poll-run')!.className, /open/);
  assert.deepEqual(v.$$('.poll-checks > .step-group > .step-row.summary .step-text').map(text), [
    'Ran a command, waited 50s',
    'Ran a command, waited 50s',
    'Ran a command, waited 50s',
  ]);
  assert.deepEqual(
    v.$$('.poll-checks .commentary [data-stub="Markdown"]').map((m: any) => m.dataset.text),
    ['Still queued (1).', 'Still queued (2).'],
  );
  assert.deepEqual([...new Set(narrated)], ['s1', 's2', 's3'], 'each check narrates with the bindings before it');
  // the turn folds again on the next delta: an equal poll keeps the row as it is, open
  const [again] = foldPolls(buildBlocks(items as any)) as any[];
  await v.rerender(h(PollRow, { block: again, cwd: '/r', narrationOf: () => undefined }));
  assert.match(v.$('.poll-run')!.className, /open/);
  // with no narration to read (the agent page), the checks draw all the same
  await v.rerender(h(PollRow, { block: again, cwd: '/r' }));
  assert.equal(v.$$('.poll-checks > .step-group').length, 3);
  // a failed check is counted on the folded row
  const failing = [
    ...check(1),
    status(1),
    sleep('s2'),
    cmd('c2', 'gh api repos/o/r/actions/runs/1/jobs', { exitCode: 1 }),
    status(2),
    ...check(3),
  ];
  const [withFailure] = foldPolls(buildBlocks(failing as any)) as any[];
  await v.rerender(h(PollRow, { block: withFailure, cwd: '/r' }));
  assert.equal(text(v.$('.poll-run > .step-row.summary .step-exit')), ' · 1 failed');
});

test('a turn folds its poll: running, the live check stays out below the latest status; finished, every check folds', async (t) => {
  const items = [user('u1', 'Merge it when green'), ...check(1), status(1), ...check(2), status(2), ...check(3), status(3), ...check(4)];
  const now = Date.now();
  chat([turn('t1', items, { status: 'inProgress', startedAt: (now - 200_000) / 1000 })], { activeTurnId: 't1' });
  const v = await render(view());
  t.after(() => v.unmount());
  const work = () => v.$('.turn .work')!;
  assert.equal(v.$$('.turn .work .poll-run').length, 1);
  assert.equal(
    text(work().querySelector('.poll-run .step-text')),
    'Ran the same command 3 times, waited 2m 30s · gh api repos/o/r/actions/runs/1/jobs',
  );
  // the latest status shows, and the live check's line is still there
  assert.deepEqual(
    [...work().querySelectorAll(':scope > * .commentary [data-stub="Markdown"], :scope > .commentary [data-stub="Markdown"]')]
      .filter((m) => !m.closest('.poll-run'))
      .map((m: any) => m.dataset.text),
    ['Still queued (3).'],
  );
  assert.ok(v.$('.turn-status-slot .claude-activity'), 'the running check keeps its live line below the task list');
  assert.equal(work().querySelector('.claude-activity'), null, 'no second live line in the transcript');
  // the turn ends: the live check joins the poll
  const completedAt = Date.parse('2026-11-21T08:22:00Z') / 1_000;
  chat([turn('t1', items, { status: 'completed', durationMs: 220_000, completedAt })]);
  await settle(() => {});
  await settle(() => v.$('.worked-for')!.click());
  assert.equal(
    text(v.$('.turn .work .poll-run .step-text')),
    'Ran the same command 4 times, waited 3m 20s · gh api repos/o/r/actions/runs/1/jobs',
  );
  await settle(() => work().querySelector<HTMLButtonElement>('.poll-run > .summary')!.click());
  const messages = v.$$('.poll-checks .commentary [data-stub="Markdown"]');
  assert.ok(messages.length);
  assert.ok(messages.every((message) => message.getAttribute('data-referencetime') === String(completedAt)));
});
