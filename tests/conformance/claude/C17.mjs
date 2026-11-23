// restartResume with an active goal (an account switch closes the CLI and resumes the same session):
// is the goal still there, is the Stop hook still attached, and does '/goal clear' then '/goal <condition>'
// give exactly one live goal afterwards?
import fs from 'node:fs';
import { sdk, open, brief, assistantText } from '../lib/claude.mjs';

export const id = 'C17';
export const title = 'Goal after restartResume (resumed session)';
export const timeoutMs = 900000;

const RULE =
  'House rule for this session: in each reply create AT MOST ONE new file with the Write tool, then end your reply immediately without doing anything else. Reply now with just "ok".';
const goal = (files) => `/goal the current working directory contains ${files.join(', ')}, each with exactly one line of text`;
const isFeedback = (m) => m.type === 'user' && m.isSynthetic && JSON.stringify(m.message?.content ?? '').includes('Stop hook feedback');
const base = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, perTaskStopAffordance: true };

export default async function run(ctx) {
  const cwd = ctx.cwd('goal');
  const o = {};

  // A: a goal that is active but unmet (interrupted), then the process goes away
  const a = open(ctx, 'before', { cwd, persist: true, ...base });
  await a.turn(RULE, {}, 120000);
  let i0 = a.msgs.length;
  a.send(goal(['a.txt', 'b.txt', 'c.txt', 'd.txt']));
  await a.waitFor((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use'), 120000, 'first tool use', i0);
  const stopped = a.nextResult(60000);
  await a.q.interrupt();
  await stopped.catch(() => null);
  o.beforeShow = brief(await a.turn('/goal', {}, 60000));
  const sid = a.sessionId();
  await a.close({ keep: true });
  ctx.defer(async () => {
    try {
      await sdk.deleteSession(sid);
    } catch {
      /* cleanup: the session may already be gone */
    }
  });
  const filesBefore = fs.readdirSync(cwd).length;

  // B: a new process resumes the session (restartResume)
  const b = open(ctx, 'after', { cwd, persist: true, resume: sid, ...base });
  o.afterShow = brief(await b.turn('/goal', {}, 90000));

  // does the Stop hook fire on an ordinary turn of the resumed session?
  i0 = b.msgs.length;
  const done = b.nextResult(240000);
  b.send('Reply with just "ok".');
  const fb = await Promise.race([b.waitFor(isFeedback, 150000, 'Stop hook feedback', i0).catch(() => null), done.then(() => null)]);
  if (fb) {
    const end = b.nextResult(60000);
    await b.q.interrupt();
    await end.catch(() => null);
  }
  o.hookAfterResume = { feedbackSeen: !!fb, filesAdded: fs.readdirSync(cwd).length - filesBefore };

  // reattach the clean way: clear, then send the condition again
  o.clear = brief(await b.turn('/goal clear', {}, 60000));
  o.showAfterClear = brief(await b.turn('/goal', {}, 60000));
  i0 = b.msgs.length;
  const r = await b.turn(goal(['e.txt', 'f.txt']), {}, 300000);
  const run2 = b.since(i0);
  o.reattach = {
    result: brief(r),
    goalSet: /^Goal set:/m.test(assistantText(run2)),
    feedbackMessages: run2.filter(isFeedback).length,
    results: run2.filter((m) => m.type === 'result').length,
    files: ['e.txt', 'f.txt'].every((f) => fs.existsSync(`${cwd}/${f}`)),
  };
  o.finalShow = brief(await b.turn('/goal', {}, 60000));
  await b.close();

  // C: what Sage does today after a switch: resume with a goal still active and send '/goal <condition>' with no clear
  const c0 = open(ctx, 'again', { cwd, persist: true, ...base });
  i0 = c0.msgs.length;
  c0.send(goal(['g.txt', 'h.txt', 'i.txt', 'j.txt']));
  await c0.waitFor((m) => m.type === 'assistant' && m.message?.content?.some((x) => x.type === 'tool_use'), 120000, 'first tool use', i0);
  const stopped2 = c0.nextResult(60000);
  await c0.q.interrupt();
  await stopped2.catch(() => null);
  const sid2 = c0.sessionId();
  await c0.close({ keep: true });
  ctx.defer(async () => {
    try {
      await sdk.deleteSession(sid2);
    } catch {
      /* cleanup: the session may already be gone */
    }
  });
  const c = open(ctx, 'again-resumed', { cwd, persist: true, resume: sid2, ...base });
  i0 = c.msgs.length;
  const rc = await c.turn(goal(['k.txt', 'l.txt']), {}, 300000);
  o.overlay = {
    result: brief(rc),
    goalSet: /^Goal set:/m.test(assistantText(c.since(i0))),
    results: c.since(i0).filter((m) => m.type === 'result').length,
    files: ['k.txt', 'l.txt'].every((f) => fs.existsSync(`${cwd}/${f}`)),
    showAfter: brief(await c.turn('/goal', {}, 60000)),
  };
  await c.close();

  return ctx.result(o, {
    'the goal is active before the restart (local /goal, no model turn)':
      /^Goal active:/.test(o.beforeShow?.result) && o.beforeShow?.num_turns === 0,
    'the resumed session still reports the same goal as active': o.afterShow?.result === o.beforeShow?.result,
    'the Stop hook is still attached after resume (synthetic feedback on an ordinary turn)': o.hookAfterResume.feedbackSeen,
    '/goal clear on the resumed session clears it (local)':
      /^Goal cleared:/.test(o.clear?.result) && /^No goal set/.test(o.showAfterClear?.result),
    "re-sending '/goal <condition>' after the clear sets a new goal that runs to completion in one result":
      o.reattach.goalSet && o.reattach.results === 1 && o.reattach.feedbackMessages >= 1 && o.reattach.files,
    "'/goal <condition>' on a resumed session that still has a goal replaces it (one goal, gone once met)":
      o.overlay.goalSet && o.overlay.files && /^No goal set/.test(o.overlay.showAfter?.result),
    'the goal is gone once it is met': /^No goal set/.test(o.finalShow?.result),
  });
}
