// A goal paused before the app-server exits: after a new app-server starts and the thread is resumed, is the
// goal still paused, and does anything run by itself? A second thread whose goal is still active at exit is the
// control: does Codex carry on with it after a restart (the reason MoPilot pauses active goals on quit)?
// Runs in a throwaway CODEX_HOME shared by both app-servers. Two short turns plus the control's.
import fs from 'node:fs';
import { open, errMsg, tempHome, sleep } from '../lib/codex.mjs';

export const id = 'X17';
export const title = 'Goal paused before exit stays paused after a restart';
export const timeoutMs = 600000;

// The goal can't be finished by the model: release.txt is for someone else to create, and the probe never does.
// Each turn only waits and looks, so a goal that is not paused keeps starting turns.
const OBJECTIVE =
  'The goal is complete only when the file release.txt exists in the current working directory. Do not create release.txt yourself: someone else will. In each turn, run the shell command `sleep 20`, then `ls`, then end the turn.';
const WINDOW_MS = 40000;

export default async function run(ctx) {
  const env = tempHome(ctx);
  const o = {};
  const cwdPaused = ctx.cwd('paused');
  const cwdActive = ctx.cwd('active');

  // before: one goal paused mid-turn, one left active, then the app-server exits
  const a = await open(ctx, 'before', { env });
  const paused = (await a.startThread({ cwd: cwdPaused })).result?.thread?.id;
  const active = (await a.startThread({ cwd: cwdActive })).result?.thread?.id;
  if (!paused || !active) return ctx.result({ startError: errMsg(await a.startThread({ cwd: cwdPaused })) }, {}, { verdict: 'error' });
  const started = (tid) => a.notes.filter((n) => n.method === 'turn/started' && n.params?.threadId === tid).length;
  await a.request('thread/goal/set', { threadId: paused, objective: OBJECTIVE });
  await a.waitFor((n) => n.method === 'turn/started' && n.params?.threadId === paused, 60000);
  // paused while the first turn is still waiting, so that turn cannot already have finished the goal
  await sleep(1500);
  await a.request('thread/goal/set', { threadId: paused, status: 'paused' });
  const tc = await a.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === paused, 120000);
  await sleep(10000);
  const pausedGoal = (await a.request('thread/goal/get', { threadId: paused })).result?.goal ?? null;
  o.before = {
    firstTurn: tc?.params?.turn?.status ?? null,
    turns: started(paused),
    goalStatus: pausedGoal?.status ?? null,
    fileWritten: fs.existsSync(`${cwdPaused}/release.txt`),
  };

  await a.request('thread/goal/set', { threadId: active, objective: OBJECTIVE });
  await a.waitFor((n) => n.method === 'turn/started' && n.params?.threadId === active, 60000);
  await sleep(3000);
  o.activeBefore = {
    goalStatus: (await a.request('thread/goal/get', { threadId: active })).result?.goal?.status ?? null,
    turns: started(active),
  };
  // neither thread is archived by the client's close: both have to be resumable
  a.threads.delete(paused);
  a.threads.delete(active);
  await a.close();

  // after: a new app-server, the threads resumed, nothing asked of them
  const b = await open(ctx, 'after', { env });
  const t0 = b.notes.length;
  const resumed = {};
  for (const [name, tid] of [
    ['paused', paused],
    ['active', active],
  ]) {
    const r = await b.request('thread/resume', { threadId: tid, excludeTurns: true });
    resumed[name] = { error: errMsg(r), goal: (await b.request('thread/goal/get', { threadId: tid })).result?.goal?.status ?? null };
    b.threads.add(tid);
  }
  await sleep(WINDOW_MS);
  const turnsAfter = (tid) => b.notes.slice(t0).filter((n) => n.method === 'turn/started' && n.params?.threadId === tid).length;
  const goalAfter = async (tid) => (await b.request('thread/goal/get', { threadId: tid })).result?.goal?.status ?? null;
  o.after = {
    paused: {
      resumeError: resumed.paused.error,
      goalOnResume: resumed.paused.goal,
      goalAfterWindow: await goalAfter(paused),
      turnsStarted: turnsAfter(paused),
      fileWritten: fs.existsSync(`${cwdPaused}/release.txt`),
    },
    // the control: whether Codex carries on with a goal that was active at exit (observation, not a requirement)
    active: {
      resumeError: resumed.active.error,
      goalOnResume: resumed.active.goal,
      goalAfterWindow: await goalAfter(active),
      turnsStarted: turnsAfter(active),
      fileWritten: fs.existsSync(`${cwdActive}/release.txt`),
    },
    goalMethods: [
      ...new Set(
        b.notes
          .slice(t0)
          .filter((n) => n.method.startsWith('thread/goal'))
          .map((n) => n.method),
      ),
    ],
  };
  await b.request('thread/goal/clear', { threadId: paused });
  await b.request('thread/goal/clear', { threadId: active });
  await b.close();

  return ctx.result(o, {
    'the goal reads paused before the exit, and the running turn finished without starting another':
      o.before.goalStatus === 'paused' && o.before.turns === 1,
    'the app-server resumes the thread with no error': !o.after.paused.resumeError,
    'the goal is still paused after the restart and the resume':
      o.after.paused.goalOnResume === 'paused' && o.after.paused.goalAfterWindow === 'paused',
    'no turn starts by itself in 40 s after the resume': o.after.paused.turnsStarted === 0,
    'control: a goal that was active at exit carries on by itself after the resume (why MoPilot pauses goals on quit)':
      o.after.active.turnsStarted > 0,
  });
}
