// '/goal <condition>' passthrough: the loop runs inside one turn, show/clear are local,
// interrupt keeps the goal, a queued clear waits for the loop, and no active_goal reaches the stream.
import fs from 'node:fs';
import { open, brief, assistantText } from '../lib/claude.mjs';

export const id = 'C4';
export const title = "'/goal <condition>' passthrough, show, clear, interrupt";
export const timeoutMs = 900000;

const RULE =
  'House rule for this session: in each reply create AT MOST ONE new file with the Write tool, then end your reply immediately without doing anything else. Reply now with just "ok".';
const goal = (files) => `/goal the current working directory contains ${files.join(', ')}, each with exactly one line of text`;
const isFeedback = (m) => m.type === 'user' && m.isSynthetic && JSON.stringify(m.message?.content ?? '').includes('Stop hook feedback');

export default async function run(ctx) {
  const cwd = ctx.cwd('goal');
  const s = open(ctx, 'session', {
    cwd,
    persist: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    perTaskStopAffordance: true,
  });
  const has = (files) => files.every((f) => fs.existsSync(`${cwd}/${f}`));
  const o = {};
  await s.turn(RULE, {}, 120000);

  // 1. plain-string /goal runs to completion inside one result
  let i0 = s.msgs.length;
  const r1 = await s.turn(goal(['a.txt', 'b.txt', 'c.txt']), {}, 300000);
  const run1 = s.since(i0);
  o.loop = {
    result: brief(r1),
    goalSet: /^Goal set:/m.test(assistantText(run1)),
    feedbackMessages: run1.filter(isFeedback).length,
    results: run1.filter((m) => m.type === 'result').length,
    files: has(['a.txt', 'b.txt', 'c.txt']),
  };

  // 2. show after the goal is met
  o.showAfterMet = brief(await s.turn('/goal', {}, 60000));

  // 3. a /goal clear queued while the loop runs (content-array form) does not cut the loop
  i0 = s.msgs.length;
  const loopDone = s.nextResult(300000);
  s.send([{ type: 'text', text: goal(['d.txt', 'e.txt', 'f.txt']) }], { origin: { kind: 'human' } });
  await s.waitFor(isFeedback, 240000, 'first Stop hook feedback', i0);
  const filesAtClear = fs.readdirSync(cwd).length;
  const clearDone = s.waitFor((m) => m.type === 'result' && /Goal cleared|No goal set/.test(String(m.result)), 300000, 'queued clear', i0);
  s.send('/goal clear', { origin: { kind: 'human' } });
  const r3 = await loopDone;
  o.queuedClear = {
    filesAtClear,
    loopResult: brief(r3),
    loopFinishedAllFiles: has(['d.txt', 'e.txt', 'f.txt']),
    clear: brief(await clearDone),
  };

  // 4. interrupt keeps the goal active; show and clear report it
  i0 = s.msgs.length;
  s.send(goal(['g.txt', 'h.txt', 'i.txt', 'j.txt']));
  await s.waitFor((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use'), 120000, 'first tool use', i0);
  const interrupted = s.nextResult(60000);
  await s.q.interrupt();
  o.interrupted = brief(await interrupted.catch(() => null));
  o.showAfterInterrupt = brief(await s.turn('/goal', {}, 60000));
  o.clear = brief(await s.turn('/goal clear', {}, 60000));
  o.showAfterClear = brief(await s.turn('/goal', {}, 60000));
  o.activeGoalMessages = s.msgs.filter((m) => m.type === 'active_goal').length;

  return ctx.result(o, {
    'plain /goal echoes "Goal set:"': o.loop.goalSet,
    'goal loop finishes inside one result': o.loop.results === 1 && o.loop.files,
    'unmet checks arrive as synthetic Stop hook feedback': o.loop.feedbackMessages >= 1,
    '/goal after met says no goal set (local)': /No goal set/.test(o.showAfterMet?.result) && o.showAfterMet?.num_turns === 0,
    'queued /goal clear waits for the loop': o.queuedClear.loopFinishedAllFiles,
    'interrupt leaves the goal active': /Goal active:.*not yet evaluated/.test(o.showAfterInterrupt?.result),
    '/goal clear clears (local)': /Goal cleared:/.test(o.clear?.result) && o.clear?.num_turns === 0,
    'no active_goal message on the local stream': o.activeGoalMessages === 0,
  });
}
