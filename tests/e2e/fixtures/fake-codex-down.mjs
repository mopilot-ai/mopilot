// Codex going down, for the scripted Codex fixture: an app-server that quits as it starts or mid-session, the CRASH turn,
// and the rollout files Codex writes, which the app reads a chat's history from while Codex is down.
//   - every start is logged as fake/start with its version. FAKE_CODEX_QUIT_ON_START=1 (a copy that keeps quitting), or
//     the file $FAKE_CODEX_LOG.down, makes it log fake/quit and exit before it answers anything (startOrQuit);
//   - once $FAKE_CODEX_LOG.quit appears, a running app-server removes it, logs fake/quit and exits (watchQuit);
//   - FAKE_CODEX_ROLLOUTS=1: each thread is written to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl as
//     Codex records it (session_meta, then per turn task_started, user_message, agent_message and its end), never the
//     app's title helper threads (createRollouts);
//   - a prompt with "CRASH": a delta, an approval request once $FAKE_CODEX_LOG.ask appears, then the process exits mid-turn
//     once $FAKE_CODEX_LOG.crash appears (both files are removed) (createCrashTurn).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** @typedef {(entry: object) => void} Log */
/** @typedef {(code: number) => void} Exit */
/** @typedef {Record<string, string | undefined>} Env */

/**
 * Logs this start; a copy that keeps quitting (or one the test brought down) exits at once. True when it exits.
 * @param {{ log: Log, version: string, env?: Env, exit?: Exit, stderr?: { write: (s: string) => unknown } }} o
 */
export function startOrQuit({ log, version, env = process.env, exit = process.exit, stderr = process.stderr }) {
  log({ id: null, method: 'fake/start', params: { version } });
  const down = env.FAKE_CODEX_QUIT_ON_START === '1' || (!!env.FAKE_CODEX_LOG && fs.existsSync(`${env.FAKE_CODEX_LOG}.down`));
  if (!down) return false;
  log({ id: null, method: 'fake/quit', params: { version } });
  stderr.write(`fake-codex ${version}: quitting as it starts\n`);
  exit(1);
  return true;
}

/**
 * A running app-server quits once the test writes $FAKE_CODEX_LOG.quit. Returns the poll's timer, or null without a log.
 * @param {{ log: Log, env?: Env, exit?: Exit, everyMs?: number }} o
 */
export function watchQuit({ log, env = process.env, exit = process.exit, everyMs = 50 }) {
  const file = env.FAKE_CODEX_LOG ? `${env.FAKE_CODEX_LOG}.quit` : null;
  if (!file) return null;
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    clearInterval(timer);
    log({ id: null, method: 'fake/quit', params: null });
    exit(1);
  }, everyMs);
  timer.unref?.();
  return timer;
}

const pad = (n) => String(n).padStart(2, '0');
const textOf = (content) => (content ?? []).map((c) => c.text ?? '').join('');

/** A thread's rollout lines, as Codex writes them (the event records the app reads; the model's own records left out). */
export function rolloutLines(rec) {
  const { thread } = rec;
  const at = (s) => new Date((s ?? thread.createdAt) * 1000).toISOString();
  const lines = [
    { timestamp: at(thread.createdAt), type: 'session_meta', payload: { id: thread.id, cwd: thread.cwd, cli_version: thread.cliVersion } },
  ];
  const event = (t, payload) => lines.push({ timestamp: at(t), type: 'event_msg', payload });
  for (const turn of rec.turns) {
    const turnId = turn.id;
    event(turn.startedAt, { type: 'task_started', turn_id: turnId, started_at: turn.startedAt });
    for (const item of turn.items) {
      if (item.type === 'userMessage') event(turn.startedAt, { type: 'user_message', turn_id: turnId, message: textOf(item.content) });
      else if (item.type === 'agentMessage') event(turn.startedAt, { type: 'agent_message', turn_id: turnId, message: item.text });
    }
    if (turn.status === 'interrupted') event(turn.completedAt, { type: 'turn_aborted', turn_id: turnId });
    else if (turn.status !== 'inProgress')
      event(turn.completedAt, { type: 'task_complete', turn_id: turnId, completed_at: turn.completedAt, duration_ms: turn.durationMs });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Where Codex keeps a thread's rollout: the day folder of when it started, named for that time and the thread's id. */
export function rolloutPath(codexHome, thread) {
  const d = new Date(thread.createdAt * 1000);
  const day = path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return path.join(codexHome, 'sessions', day, `rollout-${time}-${thread.id}.jsonl`);
}

/**
 * Writes each thread's rollout when it changed (FAKE_CODEX_ROLLOUTS=1); a no-op otherwise.
 * @param {{ codexHome: string, env?: Env }} o
 */
export function createRollouts({ codexHome, env = process.env }) {
  const written = new Map();
  return function writeRollouts(threads) {
    if (env.FAKE_CODEX_ROLLOUTS !== '1') return;
    for (const rec of threads.values()) {
      if (rec.title || rec.thread.ephemeral || !rec.turns.length) continue;
      const text = rolloutLines(rec);
      if (written.get(rec.thread.id) === text) continue;
      const file = rolloutPath(codexHome, rec.thread);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      written.set(rec.thread.id, text);
    }
  };
}

/**
 * The CRASH turn: it says it is working, asks to run a command once told to, then the process quits mid-turn.
 * @param {{ notify: (method: string, params: object) => void, ask: (method: string, params: object) => unknown, log: Log,
 *   saveState: () => void, env?: Env, exit?: Exit, everyMs?: number }} o
 */
export function createCrashTurn({ notify, ask, log, saveState, env = process.env, exit = process.exit, everyMs = 50 }) {
  const signal = (suffix) =>
    /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        const file = `${env.FAKE_CODEX_LOG}.${suffix}`;
        const poll = setInterval(() => {
          if (!fs.existsSync(file)) return;
          fs.rmSync(file, { force: true });
          clearInterval(poll);
          resolve();
        }, everyMs);
      })
    );
  return async function crashTurn(rec, turn, at) {
    const threadId = rec.thread.id;
    const turnId = turn.id;
    const agent = {
      type: 'agentMessage',
      id: randomUUID(),
      text: 'working on it',
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    turn.items.push(agent);
    saveState();
    notify('item/started', { item: { ...agent, text: '' }, threadId, turnId, startedAtMs: at() });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: agent.id, delta: agent.text });
    await signal('ask');
    ask('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId: randomUUID(),
      command: 'rm -rf build',
      cwd: rec.thread.cwd,
      reason: null,
    });
    await signal('crash');
    log({ id: null, method: 'fake/crash', params: null });
    exit(1);
  };
}
