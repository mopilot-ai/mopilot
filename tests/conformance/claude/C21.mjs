// Killing the CLI (SIGKILL) in the middle of a turn that is running a shell command: what the SDK client sees,
// whether the command's own process survives, what the interrupted turn leaves in the transcript, and whether
// a new process can resume the session and answer a new turn. Runs in a temp dir.
import { execFileSync } from 'node:child_process';
import { sdk, open, brief, transcript, sleep } from '../lib/claude.mjs';

export const id = 'C21';
export const title = 'CLI killed mid-turn, then resumed';
export const timeoutMs = 400000;

// the CLI refuses a bare `sleep N`, so the command waits in a loop; MARK finds it in the process list
const MARK = 'MARKC21Q7';
const COMMAND = `sh -c 'echo ${MARK}; i=0; while [ $i -lt 94 ]; do sleep 1; i=$((i+1)); done'`;
const PATTERN = MARK;
const alive = () => {
  try {
    return execFileSync('pgrep', ['-f', PATTERN]).toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const reap = () => {
  try {
    execFileSync('pkill', ['-f', PATTERN]);
  } catch {
    /* pkill exits non-zero when nothing matched */
  }
};

export default async function run(ctx) {
  const cwd = ctx.cwd('kill');
  ctx.defer(reap);
  const o = {};
  const a = open(ctx, 'killed', {
    cwd,
    persist: true,
    captureSpawn: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  });
  await a.q.initializationResult();
  const i0 = a.msgs.length;
  a.send(`Run exactly this shell command with the Bash tool, unchanged, and wait for it to finish, then reply "done":\n${COMMAND}`);
  const use = await a.waitFor(
    (m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use' && b.name === 'Bash'),
    120000,
    'Bash tool use',
    i0,
  );
  const toolId = use.message.content.find((b) => b.type === 'tool_use').id;
  const sid = a.sessionId();
  ctx.defer(async () => {
    try {
      await sdk.deleteSession(sid);
    } catch {
      /* cleanup: the session may already be gone */
    }
  });
  await sleep(3000);
  o.commandRunningBeforeKill = alive().length > 0;
  const child = a.spawned[0]?.child;
  child?.kill('SIGKILL');
  const ended = await Promise.race([a.ended().then(() => true), sleep(20000).then(() => false)]);
  await sleep(2000);
  o.kill = {
    exit: a.spawned[0]?.exit ?? null,
    streamEnded: ended,
    streamError: a.streamError(),
    resultAfterKill: a.since(i0).some((m) => m.type === 'result'),
    toolResultSeen: a.since(i0).some((m) => m.type === 'user' && JSON.stringify(m.message?.content ?? '').includes(toolId)),
  };
  o.commandSurvivedKill = alive().length > 0;
  reap();
  await a.close({ keep: true });

  const records = transcript(sid);
  const results = records.filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes(toolId));
  o.transcript = {
    records: records.length,
    toolUseRecorded: records.some((r) => r.type === 'assistant' && JSON.stringify(r.message?.content ?? '').includes(toolId)),
    toolResultRecorded: results.length > 0,
  };

  const b = open(ctx, 'resumed', {
    cwd,
    persist: true,
    resume: sid,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  });
  const r = await b.turn('Reply with just "ok".', {}, 150000);
  o.resumed = { result: brief(r), sameSession: b.sessionId() === sid };
  await b.close();

  return ctx.result(o, {
    'the command was running when the CLI was killed': o.commandRunningBeforeKill,
    'the CLI dies from SIGKILL and the stream ends with no result for the turn':
      o.kill.exit?.signal === 'SIGKILL' && o.kill.streamEnded && !o.kill.resultAfterKill,
    "the command's own process survives the CLI (an orphan MoPilot has to stop itself)": o.commandSurvivedKill,
    'the interrupted tool call has no result in the transcript': o.transcript.toolUseRecorded ? !o.transcript.toolResultRecorded : true,
    'a new process resumes the session and answers a new turn': o.resumed.result?.subtype === 'success' && o.resumed.sameSession,
  });
}
