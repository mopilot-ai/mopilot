// A wait is a step in its group on every harness, summed into the group's summary, and repeated checks fold into one
// poll row (stepModel.ts, pollRuns.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import {
  buildBlocks,
  commandAfterWait,
  isBlockItem,
  itemSteps,
  stepsWaited,
  summarizeSteps,
} from '../src/components/thread/items/stepModel.ts';
import { foldPolls, pollSummary, pollTarget, samePoll, MAX_STATUS_CHARS } from '../src/components/thread/items/pollRuns.ts';
import { activeStepLabel, stepIcon, waitWords } from '../src/components/thread/items/presentation.tsx';
import { claudeActivityParts } from '../src/session/activityUx.ts';
import { shownToolName } from '../src/lib/ownToolLines.ts';

const sleep = (id: string, durationMs: number | null = 50_000) => ({ id, type: 'sleep', durationMs }) as any;
const cmd = (id: string, command: string, extra: any = {}) =>
  ({ id, type: 'commandExecution', command, status: 'completed', commandActions: [], ...extra }) as any;
const tool = (id: string, extra: any = {}) =>
  ({ id, type: 'mcpToolCall', server: '', tool: 'gh_runs', arguments: { run: 1 }, status: 'completed', ...extra }) as any;
const msg = (id: string, text = 'Still queued.') => ({ id, type: 'agentMessage', text }) as any;
const think = (id: string) => ({ id, type: 'reasoning', summary: [], content: [] }) as any;
const steps = (...items: any[]) => items.flatMap(itemSteps);
const shape = (blocks: any[]) =>
  blocks.map((b) =>
    b.kind === 'block'
      ? b.item.id
      : b.kind === 'poll'
        ? `poll(${b.checks.map((c: any) => c.items.map((i: any) => i.id).join('+')).join('|')})`
        : b.items.map((i: any) => i.id).join('+'),
  );

test('a Codex sleep item, a bare sleep command and an ACP sleep tool are each a wait step', () => {
  assert.deepEqual(itemSteps(sleep('s')), [{ kind: 'wait', item: sleep('s'), ms: 50_000 }]);
  assert.deepEqual(itemSteps({ id: 's', type: 'sleep' } as any)[0], { kind: 'wait', item: { id: 's', type: 'sleep' }, ms: null });
  assert.deepEqual(
    itemSteps(cmd('c', 'sleep 30')).map((s: any) => [s.kind, s.ms]),
    [['wait', 30_000]],
  );
  assert.deepEqual(
    itemSteps(tool('t', { tool: 'sleep', arguments: { seconds: 5 } })).map((s: any) => [s.kind, s.ms]),
    [['wait', 5000]],
  );
  assert.equal(itemSteps(tool('t'))[0].kind, 'tool');
  assert.equal(itemSteps({ id: 'd', type: 'dynamicToolCall', tool: 'wait', arguments: { ms: 10 } } as any)[0].kind, 'wait');
});

test('a command after a leading sleep stays a command that carries its wait; what runs after it decides the network', () => {
  const [s] = itemSteps(cmd('c', 'sleep 50 && curl -s https://x')) as any[];
  assert.equal(s.kind, 'command');
  assert.equal(s.network, true);
  assert.deepEqual(s.wait, { ms: 50_000, rest: 'curl -s https://x', loop: false });
  assert.equal(commandAfterWait(s), 'curl -s https://x');
  const [plain] = itemSteps(cmd('c', '  gh api x ')) as any[];
  assert.equal(plain.wait, undefined);
  assert.equal(commandAfterWait(plain), 'gh api x');
  const [loop] = itemSteps(cmd('c', 'until x; do sleep 5; done', { durationMs: 20_000 })) as any[];
  assert.equal(loop.kind, 'command');
  assert.equal(loop.wait.loop, true);
  assert.equal(commandAfterWait(loop), 'until x; do sleep 5; done');
});

test('a group sums what it waited into its summary, after what it did', () => {
  assert.equal(summarizeSteps(steps(sleep('s'), cmd('c', 'gh api x'))).text, 'Ran a command, waited 50s');
  assert.equal(summarizeSteps(steps(cmd('c', 'sleep 45 && gh api x'), sleep('s', 75_000))).text, 'Ran a command, waited 2m');
  // a wait loop counts how long it ran
  assert.equal(summarizeSteps(steps(cmd('c', 'until x; do sleep 5; done', { durationMs: 360_000 }))).text, 'Ran a command, waited 6m');
  // a wait that said no duration still says it waited
  const only = summarizeSteps(steps(sleep('s', null)));
  assert.deepEqual(only, { text: 'Waited', icon: 'wait' });
  assert.equal(stepsWaited(steps(cmd('c', 'ls'))), null);
  assert.deepEqual(stepsWaited(steps(sleep('a', null), sleep('b', 2000))), { ms: 2000 });
});

test('a sleep item is no longer a block of its own: it joins the step group around it', () => {
  assert.equal(isBlockItem(sleep('s')), false);
  assert.deepEqual(shape(buildBlocks([cmd('a', 'ls'), sleep('s'), cmd('b', 'gh api x'), msg('m')] as any)), ['a+s+b', 'm']);
});

test('the running line names a wait, with what is left of it, and says it waited once it ended', () => {
  const [w] = itemSteps(sleep('s')) as any[];
  assert.equal(activeStepLabel(w), 'Waiting 50s');
  assert.equal(waitWords(w, { start: 1000 }, 33_000), 'Waiting 50s · 18s left');
  // under a second left, or no start known: just the wait
  assert.equal(waitWords(w, { start: 1000 }, 50_500), 'Waiting 50s');
  assert.equal(waitWords(w, undefined, 0), 'Waiting 50s');
  assert.equal(waitWords(w, { start: 0, end: 50_000 }, 60_000), 'Waited 50s');
  const [none] = itemSteps(sleep('n', null)) as any[];
  assert.equal(waitWords(none, { start: 0 }, 1), 'Waiting');
  assert.equal(waitWords(none, { start: 0, end: 5 }, 9), 'Waited');
  assert.deepEqual(claudeActivityParts(w), { verb: 'Waiting', meta: '50s' });
  assert.deepEqual(claudeActivityParts(none), { verb: 'Waiting' });
});

test('a poll check waited and did one thing: a command (after its sleep) or a tool call with the same arguments', () => {
  assert.deepEqual(pollTarget([sleep('s'), think('r'), cmd('c', 'gh api x')]), {
    key: 'command:gh api x',
    kind: 'command',
    text: 'gh api x',
  });
  assert.deepEqual(pollTarget([cmd('c', 'sleep 50 && gh api x')]), { key: 'command:gh api x', kind: 'command', text: 'gh api x' });
  assert.deepEqual(pollTarget([sleep('s'), tool('t')]), { key: 'tool:/gh_runs:{"run":1}', kind: 'tool', text: shownToolName(tool('t')) });
  assert.equal(pollTarget([sleep('s'), tool('t', { server: 'github', arguments: undefined })])!.key, 'tool:github/gh_runs:null');
  // no wait, two things, or a step that is neither
  assert.equal(pollTarget([cmd('c', 'gh api x')]), null);
  assert.equal(pollTarget([sleep('s'), cmd('a', 'ls'), cmd('b', 'pwd')]), null);
  assert.equal(pollTarget([sleep('s'), { id: 'w', type: 'webSearch', query: 'x' } as any]), null);
});

const check = (n: number, command = 'gh api x') => [sleep(`s${n}`), cmd(`c${n}`, command)];
const turnOf = (...parts: any[][]) => buildBlocks(parts.flat() as any);

test('three or more checks of the same target fold into one poll, the message after the last staying out', () => {
  const blocks = turnOf(check(1), [msg('m1')], check(2), [msg('m2')], check(3), [msg('m3')]);
  const folded = foldPolls(blocks);
  assert.deepEqual(shape(folded), ['poll(s1+c1|s2+c2|s3+c3)', 'm3']);
  const poll = folded[0] as any;
  assert.deepEqual(
    poll.checks.map((c: any) => c.message?.id ?? null),
    ['m1', 'm2', null],
  );
  assert.deepEqual(pollSummary(poll), { text: 'Ran the same command 3 times, waited 2m 30s', target: 'gh api x', failed: 0 });
});

test('two checks, a long or fenced message, another target or another block between checks end the poll', () => {
  assert.deepEqual(shape(foldPolls(turnOf(check(1), [msg('m1')], check(2)))), ['s1+c1', 'm1', 's2+c2']);
  const long = msg('m2', 'x'.repeat(MAX_STATUS_CHARS + 1));
  assert.deepEqual(shape(foldPolls(turnOf(check(1), [msg('m1')], check(2), [long], check(3), [msg('m3')], check(4)))), [
    's1+c1',
    'm1',
    's2+c2',
    'm2',
    's3+c3',
    'm3',
    's4+c4',
  ]);
  const fenced = msg('m2', 'see:\n```\nlog\n```');
  assert.equal(
    foldPolls(turnOf(check(1), [msg('m1')], check(2), [fenced], check(3))).some((b) => b.kind === 'poll'),
    false,
  );
  assert.equal(
    foldPolls(turnOf(check(1), [msg('m1')], check(2), [msg('m2')], check(3, 'gh pr checks'))).some((b) => b.kind === 'poll'),
    false,
  );
  assert.equal(
    foldPolls(turnOf(check(1), [msg('m1', '  ')], check(2), [msg('m2')], check(3))).some((b) => b.kind === 'poll'),
    false,
  );
  // a message with no text yet (still streaming its first token) says nothing about the poll
  const empty = { id: 'm1', type: 'agentMessage' } as any;
  assert.equal(
    foldPolls(turnOf(check(1), [empty], check(2), [msg('m2')], check(3))).some((b) => b.kind === 'poll'),
    false,
  );
  // a group that is no check leaves the blocks as they were
  assert.deepEqual(shape(foldPolls(turnOf([cmd('a', 'ls')], [msg('m')]))), ['a', 'm']);
});

test('the running group stays out of the poll, so the live line keeps its place; settled, it joins', () => {
  const blocks = turnOf(check(1), [msg('m1')], check(2), [msg('m2')], check(3), [msg('m3')], check(4));
  assert.deepEqual(shape(foldPolls(blocks, true)), ['poll(s1+c1|s2+c2|s3+c3)', 'm3', 's4+c4']);
  assert.deepEqual(shape(foldPolls(blocks)), ['poll(s1+c1|s2+c2|s3+c3|s4+c4)']);
  // a live last check would make a third: two settled checks stay as they are
  assert.deepEqual(shape(foldPolls(turnOf(check(1), [msg('m1')], check(2), [msg('m2')], check(3)), true)), [
    's1+c1',
    'm1',
    's2+c2',
    'm2',
    's3+c3',
  ]);
});

test('a tool poll says it called the same tool; a poll whose waits gave no duration still says it waited', () => {
  const t = (n: number) => [sleep(`s${n}`, null), tool(`t${n}`, { server: 'github', tool: 'list_runs' })];
  const [poll] = foldPolls(turnOf(t(1), [msg('m1')], t(2), [msg('m2')], t(3))) as any[];
  assert.deepEqual(pollSummary(poll), { text: 'Called the same tool 3 times, waited', target: 'github · list_runs', failed: 0 });
});

test('a folded poll counts its failed checks: a bad exit, a failed or declined call', () => {
  const t = (n: number, extra: any = {}) => [sleep(`s${n}`), tool(`t${n}`, extra)];
  const [poll] = foldPolls(turnOf(t(1, { status: 'failed' }), [msg('m1')], t(2, { status: 'declined' }), [msg('m2')], t(3))) as any[];
  assert.equal(pollSummary(poll).failed, 2);
  const [bad] = foldPolls(
    turnOf(check(1), [msg('m1')], [sleep('s2'), cmd('c2', 'gh api x', { exitCode: 8 })], [msg('m2')], check(3)),
  ) as any[];
  assert.equal(pollSummary(bad).failed, 1);
});

test('two polls are the same while their checks hold the same items and messages', () => {
  const parts = () => turnOf(check(1), [msg('m1')], check(2), [msg('m2')], check(3));
  const [a] = foldPolls(parts()) as any[];
  const [b] = foldPolls(parts()) as any[];
  assert.equal(samePoll(a, b), false, 'new item objects');
  const blocks = parts();
  const [x] = foldPolls(blocks) as any[];
  const [y] = foldPolls(blocks) as any[];
  assert.equal(samePoll(x, y), true);
  assert.equal(samePoll(x, { ...y, target: { ...y.target, key: 'other' } }), false);
  assert.equal(samePoll(x, { ...y, checks: y.checks.slice(1) }), false);
  assert.equal(samePoll(x, { ...y, checks: y.checks.map((c: any, i: number) => (i ? c : { ...c, message: msg('z') })) }), false);
  assert.equal(samePoll(x, { ...y, checks: y.checks.map((c: any, i: number) => (i ? c : { ...c, items: c.items.slice(1) })) }), false);
});

test('a declined command waited for nothing', () => {
  assert.deepEqual(
    itemSteps(cmd('c', 'sleep 50 && gh api x', { status: 'declined' })).map((s: any) => [s.kind, s.wait]),
    [['command', undefined]],
  );
  assert.equal(itemSteps(cmd('c', 'sleep 50', { status: 'declined' }))[0].kind, 'command');
});

test('a monitor and a check-in are watch steps the summary counts; a blocking task read is a wait on that task', () => {
  const monitor = tool('m', { tool: 'Monitor', arguments: { description: 'CI run' } });
  const checkin = tool('w', { tool: 'ScheduleWakeup', arguments: { delaySeconds: 960 } });
  const read = tool('o', { tool: 'TaskOutput', arguments: { task_id: 'b1' }, durationMs: 120_000 });
  assert.deepEqual(
    steps(monitor, checkin, read).map((s: any) => [s.kind, s.what ?? s.on]),
    [
      ['watch', 'monitor'],
      ['watch', 'checkin'],
      ['wait', 'a background task'],
    ],
  );
  assert.equal(summarizeSteps(steps(monitor)).text, 'Started a monitor');
  assert.equal(summarizeSteps(steps(monitor, tool('m2', { tool: 'Monitor' }), checkin)).text, 'Started 2 monitors, scheduled a check-in');
  assert.equal(summarizeSteps(steps(checkin, tool('w2', { tool: 'ScheduleWakeup' }))).text, 'Scheduled 2 check-ins');
  assert.deepEqual(summarizeSteps(steps(read, cmd('c', 'gh run view'))), { text: 'Ran a command, waited 2m', icon: 'command' });
});

test('the running line says what a watch arms and what a wait waits on', () => {
  const [monitor] = steps(tool('m', { tool: 'Monitor', arguments: { description: 'CI run' } })) as any[];
  const [checkin] = steps(tool('w', { tool: 'ScheduleWakeup', arguments: { delaySeconds: 60 } })) as any[];
  const [read] = steps(tool('o', { tool: 'TaskOutput', arguments: {}, durationMs: null })) as any[];
  assert.equal(activeStepLabel(monitor), 'Starting a monitor');
  // a watch's summary leads with its own mark, not a wait's clock
  assert.notEqual(stepIcon('watch').type, stepIcon('wait').type);
  assert.equal(activeStepLabel(checkin), 'Scheduling a check-in');
  assert.equal(activeStepLabel(read), 'Waiting for a background task');
  assert.equal(waitWords(read, { start: 0 }, 5000), 'Waiting for a background task');
  assert.equal(waitWords({ ...read, ms: 90_000 }, { start: 0, end: 90_000 }, 95_000), 'Waited 1m 30s for a background task');
  assert.equal(waitWords(read, { start: 0, end: 1 }, 2), 'Waited for a background task');
  assert.deepEqual(claudeActivityParts(monitor), { verb: 'Starting monitor', meta: 'CI run' });
  assert.deepEqual(claudeActivityParts({ ...monitor, label: null }), { verb: 'Starting monitor' });
  assert.deepEqual(claudeActivityParts(checkin), { verb: 'Scheduling check-in' });
  const [stop] = steps(tool('s', { tool: 'ScheduleWakeup', arguments: { stop: true } })) as any[];
  assert.deepEqual(claudeActivityParts(stop), { verb: 'Stopping loop' });
  assert.equal(activeStepLabel(stop), 'Stopping the check-ins');
  assert.deepEqual(claudeActivityParts(read), { verb: 'Waiting', meta: 'for a background task' });
});
