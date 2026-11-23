// Killing the app-server (SIGKILL) in the middle of a turn that is running a shell command:
// what the client sees, whether the command's child process survives, and whether a fresh app-server
// can resume the thread (what the interrupted turn looks like, and whether a new turn works).
// Runs in a throwaway CODEX_HOME. One cheap turn plus one short turn.
import { execFileSync } from 'node:child_process';
import { open, agentText, tempHome, sleep } from '../lib/codex.mjs';

export const id = 'X16';
export const title = 'App-server killed mid-turn, then resumed';
export const timeoutMs = 400000;

const MARK = 'sleep 97';
const alive = () => {
  try {
    return execFileSync('pgrep', ['-f', `^(/bin/)?(zsh|bash|sh)? ?.*${MARK}`])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

export default async function run(ctx) {
  const env = tempHome(ctx);
  const o = {};
  const c1 = await open(ctx, 'killed', { env });
  const t = await c1.startThread();
  const threadId = t.result?.thread?.id;
  o.start = { ok: !!threadId };
  const from = c1.notes.length;
  const start = await c1.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `Run the shell command \`${MARK}\` and wait for it, then reply "done".`, text_elements: [] }],
  });
  o.turnStart = { ok: !start.error, error: start.error?.message };
  const cmd = await c1.waitFor((n) => n.method === 'item/started' && n.params?.item?.type === 'commandExecution', 90000, from);
  o.commandStarted = !!cmd;
  await sleep(1500);
  o.childrenBeforeKill = alive().length;
  const sawEnd = { completed: false };
  c1.waitFor((n) => n.method === 'turn/completed', 3000, from).then((n) => (sawEnd.completed = !!n));
  const exited = c1.exited;
  c1.proc.kill('SIGKILL');
  await exited;
  await sleep(3500);
  o.killed = { signal: c1.proc.signalCode, turnCompletedSeen: sawEnd.completed };
  const left = alive();
  o.childrenAfterKill = left.length;
  for (const pid of left) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* the process may already have exited */
    }
  }

  const c2 = await open(ctx, 'resumed', { env });
  const r = await c2.request(
    'thread/resume',
    { threadId, model: ctx.model, approvalPolicy: 'never', sandbox: 'workspace-write', config: { model_reasoning_effort: ctx.effort } },
    60000,
  );
  o.resume = {
    ok: !r.error,
    error: r.error?.message,
    turns: r.result?.thread?.turns?.length ?? null,
    status: r.result?.thread?.status ?? null,
  };
  const read = await c2.request('thread/read', { threadId, includeTurns: true }, 60000);
  const turns = read.result?.thread?.turns ?? [];
  o.read = {
    ok: !read.error,
    error: read.error?.message,
    turnStatuses: turns.map((x) => x.status),
    lastItemTypes: (turns.at(-1)?.items ?? []).map((i) => i.type),
  };
  const next = await c2.turn(threadId, 'Reply with exactly: ok', {}, 120000);
  o.nextTurn = { status: next.status, reply: agentText(c2.items(next.from, threadId)).slice(0, 80) };
  await c2.close();
  return ctx.result(o, {
    'the command was running when the app-server was killed': o.commandStarted && o.childrenBeforeKill >= 1,
    'no turn/completed reaches the client': !o.killed.turnCompletedSeen,
    // whether the command outlives its app-server is recorded (childrenAfterKill), not judged: 0.162.0-alpha.17.2
    // left it orphaned, 0.162.1 takes it down with it, and MoPilot relies on neither (docs/multi-harness/FOLLOWUPS.md)
    'a new app-server resumes the thread and reports it idle': o.resume.ok && o.resume.status?.type === 'idle',
    'the killed turn is stored as interrupted': o.read.turnStatuses.length === 1 && o.read.turnStatuses[0] === 'interrupted',
    'a new turn on the resumed thread completes': o.nextTurn.status === 'completed',
  });
}
