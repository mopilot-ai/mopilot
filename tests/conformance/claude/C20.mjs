// A goal after a crash: the CLI is killed (SIGKILL) while a goal round is running, and a new process reopens the
// session. Is the goal still there, does the Stop hook still fire, and what is left of the interrupted round?
// Compare C17, where the goal was interrupted and the process closed cleanly.
import fs from 'node:fs';
import { sdk, open, brief, transcript } from '../lib/claude.mjs';

export const id = 'C20';
export const title = 'Goal after a crash (CLI killed mid-round) and reopen';
export const timeoutMs = 900000;

const RULE =
  'House rule for this session: in each reply create AT MOST ONE new file with the Write tool, then end your reply immediately without doing anything else. Reply now with just "ok".';
const goal = (files) => `/goal the current working directory contains ${files.join(', ')}, each with exactly one line of text`;
const isFeedback = (m) => m.type === 'user' && m.isSynthetic && JSON.stringify(m.message?.content ?? '').includes('Stop hook feedback');
const base = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, perTaskStopAffordance: true };

export default async function run(ctx) {
  const cwd = ctx.cwd('goal');
  const o = {};

  // A: a goal round is running; the process is killed, no interrupt, no clean close
  const a = open(ctx, 'crashed', { cwd, persist: true, captureSpawn: true, ...base });
  await a.turn(RULE, {}, 120000);
  const i0 = a.msgs.length;
  a.send(goal(['a.txt', 'b.txt', 'c.txt', 'd.txt']));
  await a.waitFor((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use'), 120000, 'first tool use', i0);
  const sid = a.sessionId();
  ctx.defer(async () => {
    try {
      await sdk.deleteSession(sid);
    } catch {
      /* cleanup: the session may already be gone */
    }
  });
  const child = a.spawned[0]?.child;
  child?.kill('SIGKILL');
  const ended = await Promise.race([a.ended().then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
  o.crash = {
    killed: !!child,
    exit: a.spawned[0]?.exit ?? null,
    streamEnded: ended,
    streamError: a.streamError(),
    resultAfterKill: a.since(i0).some((m) => m.type === 'result'),
  };
  await a.close({ keep: true });
  const filesAtCrash = fs.readdirSync(cwd).length;
  const records = transcript(sid);
  o.transcript = { records: records.length, lastTypes: records.slice(-4).map((r) => r.type) };

  // B: a new process reopens the session
  const b = open(ctx, 'reopened', { cwd, persist: true, resume: sid, ...base });
  o.afterShow = brief(await b.turn('/goal', {}, 90000));
  const j0 = b.msgs.length;
  const done = b.nextResult(240000);
  b.send('Reply with just "ok".');
  const fb = await Promise.race([b.waitFor(isFeedback, 150000, 'Stop hook feedback', j0).catch(() => null), done.then(() => null)]);
  if (fb) {
    const end = b.nextResult(60000);
    await b.q.interrupt();
    await end.catch(() => null);
  }
  o.hookAfterReopen = { feedbackSeen: !!fb, filesAdded: fs.readdirSync(cwd).length - filesAtCrash };
  o.clear = brief(await b.turn('/goal clear', {}, 60000));
  o.showAfterClear = brief(await b.turn('/goal', {}, 60000));
  await b.close();

  return ctx.result(o, {
    'a SIGKILLed CLI ends the stream with no result for the round':
      o.crash.killed && o.crash.exit?.signal === 'SIGKILL' && o.crash.streamEnded && !o.crash.resultAfterKill,
    'the reopened session still reports the goal as active (local /goal, no model turn)':
      /^Goal active:/.test(o.afterShow?.result) && o.afterShow?.num_turns === 0,
    'the Stop hook is still attached after the crash (synthetic feedback on an ordinary turn)': o.hookAfterReopen.feedbackSeen,
    '/goal clear on the reopened session clears it':
      /^Goal cleared:/.test(o.clear?.result) && /^No goal set/.test(o.showAfterClear?.result),
  });
}
