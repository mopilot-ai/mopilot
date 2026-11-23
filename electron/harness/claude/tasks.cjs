// Claude Code's background tasks for one CLI process (design commandLayer tasks, D-17).
// background_tasks_changed is the level signal: each one replaces the set of live tasks. task_*
// messages are the edges and carry the details (what the task is, its progress, how it ended). The
// level is per process, so a new process starts from an empty table. Finished tasks stay listed (the
// newest FINISHED_MAX) with how they ended; only running ones count as activity.
const { clock } = require('../../platform/ports/clock.cjs');
const { settledStatus } = require('../../../shared/claudeTaskStatus.mjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { withAsyncCleanup } = require('../../platform/fsutil.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');

/** A fresh table: tasks by id, whether this process has sent a level yet, and what background shells said. */
const emptyTasks = () => ({ byId: new Map(), level: null, commands: new Map(), shells: new Map() });

const TASK_SUBTYPES = new Set(['background_tasks_changed', 'task_started', 'task_progress', 'task_updated', 'task_notification']);
/** How many finished tasks a session keeps listed. */
const FINISHED_MAX = 100;
const NOTED_MAX = 200;
/** A Bash tool_result for a command sent to the background (Claude Desktop reads the same text). */
const BG_COMMAND_RE = /Command running in background with ID: (\S+?)\.?(?:\s|$)[\s\S]*?Output is being written to: (\S+\.output)/;

const isRunning = (x) => settledStatus(x.status) === null;

/** Whether `p` is a task's own output file (`…/tasks/<id>.output`), the only files the output tail reads. */
function isTaskOutput(taskId, p) {
  return (
    typeof p === 'string' &&
    typeof taskId === 'string' &&
    /^[\w-]+$/.test(taskId) &&
    (p.startsWith('/') || /^[A-Za-z]:\\/.test(p)) &&
    !/(^|[\\/])\.\.([\\/]|$)/.test(p) &&
    /[\\/]tasks[\\/]([^\\/]+)\.output$/.exec(p)?.[1] === taskId
  );
}

/** A number the SDK sent, or what was known. */
const num = (v, prev) => (typeof v === 'number' && Number.isFinite(v) ? v : prev);

function settle(x, status, now, summary) {
  x.status = status;
  x.completedAt ??= now;
  if (summary && !x.summary) x.summary = summary;
}

/** What a background Bash call said about its task: its command, and where its output goes. */
function applyShell(t, x) {
  const sh = t.shells.get(x.id);
  if (!sh) return;
  t.shells.delete(x.id);
  x.command ??= sh.command;
  x.toolUseId ??= sh.toolUseId;
  if (!x.output && isTaskOutput(x.id, sh.path)) x.output = { kind: 'file', path: sh.path };
}

/** Bash calls sent to the background: their command (tool_use) and their task id and output file (tool_result). */
function noteShells(t, m, now) {
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const b of content) {
    if (m.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && b.input?.command) {
      t.commands.set(b.id, String(b.input.command));
      // the ids of calls long done aren't needed
      if (t.commands.size > NOTED_MAX) t.commands.delete(t.commands.keys().next().value);
    } else if (m.type === 'user' && b?.type === 'tool_result') {
      const text =
        typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content : []).map((c) => c?.text ?? '').join('\n');
      const hit = BG_COMMAND_RE.exec(text);
      if (!hit) continue;
      t.shells.set(hit[1], { command: t.commands.get(b.tool_use_id) ?? null, toolUseId: b.tool_use_id, path: hit[2] });
      if (t.shells.size > NOTED_MAX) t.shells.delete(t.shells.keys().next().value);
      const x = t.byId.get(hit[1]);
      if (x) {
        applyShell(t, x);
        x.startedAt ??= now;
        changed = true;
      }
    }
  }
  return changed;
}

/** Drop finished foreground tasks, and the oldest finished ones beyond FINISHED_MAX. */
function prune(t) {
  const finished = [];
  for (const x of t.byId.values()) {
    if (isRunning(x)) continue;
    if (!shown(t, x)) t.byId.delete(x.id);
    else finished.push(x);
  }
  finished.sort((a, b) => a.completedAt - b.completedAt);
  for (const x of finished.slice(0, Math.max(0, finished.length - FINISHED_MAX))) t.byId.delete(x.id);
}

/**
 * Apply one SDK message to the table. Returns true when what the table shows changed.
 * A CLI that never sends background_tasks_changed still settles a task on its task_notification.
 */
function reduceTasks(t, m, now = clock.now()) {
  if (m?.type === 'assistant' || m?.type === 'user') return noteShells(t, m, now);
  if (!m || m.type !== 'system' || !TASK_SUBTYPES.has(m.subtype)) return false;
  const get = (id) => {
    let x = t.byId.get(id);
    if (!x) {
      x = {
        id,
        type: null,
        description: '',
        status: 'running',
        summary: null,
        toolUseId: null,
        subagentType: null,
        workflowName: null,
        parentTaskId: null,
        ambient: false,
        backgrounded: null,
        startedAt: now,
        completedAt: null,
        lastTool: null,
        tokens: null,
        toolUses: null,
        command: null,
        output: null,
        runId: null,
        inLevel: false,
        notified: false,
      };
      t.byId.set(id, x);
      applyShell(t, x);
    }
    return x;
  };
  switch (m.subtype) {
    case 'background_tasks_changed': {
      t.level = new Set();
      for (const e of m.tasks ?? []) {
        if (!e?.task_id) continue;
        t.level.add(e.task_id);
        const x = get(e.task_id);
        Object.assign(x, {
          type: e.task_type ?? x.type,
          description: e.description ?? x.description,
          subagentType: e.subagent_type ?? x.subagentType,
          parentTaskId: e.parent_task_id ?? null,
          ambient: !!e.ambient,
          backgrounded: true,
          inLevel: true,
        });
        // a task its notification already settled stays settled, unless this is a new run of it (a resumed agent)
        const newRun = !!e.run_id && e.run_id !== x.runId;
        if (e.run_id) x.runId = e.run_id;
        if (x.status !== 'running' && x.status !== 'paused' && (!x.notified || newRun)) {
          x.status = 'running';
          x.completedAt = null;
          x.notified = false;
        }
      }
      // a task gone from the level is over: one still running ended without a word (it was stopped with its process)
      for (const x of [...t.byId.values()])
        if (!t.level.has(x.id) && isRunning(x)) {
          if (x.inLevel || x.backgrounded === true) settle(x, 'stopped', now, 'Ended in the background');
          else t.byId.delete(x.id);
        }
      prune(t);
      return true;
    }
    case 'task_started': {
      // a task that already ended (the level dropped it first) isn't brought back
      if (t.level && !t.level.has(m.task_id) && m.is_backgrounded === false) return false;
      const x = get(m.task_id);
      Object.assign(x, {
        type: m.task_type ?? x.type,
        description: m.description ?? x.description,
        toolUseId: m.tool_use_id ?? x.toolUseId,
        subagentType: m.subagent_type ?? x.subagentType,
        workflowName: m.workflow_name ?? x.workflowName,
        parentTaskId: m.parent_task_id ?? x.parentTaskId,
        ambient: m.ambient ?? x.ambient,
        backgrounded: m.is_backgrounded ?? x.backgrounded,
        runId: m.run_id ?? x.runId,
      });
      if (m.tool_use_id && t.commands.has(m.tool_use_id)) x.command ??= t.commands.get(m.tool_use_id);
      return true;
    }
    case 'task_progress': {
      if (!t.byId.has(m.task_id) && t.level && !t.level.has(m.task_id)) return false;
      const x = get(m.task_id);
      if (m.summary) x.summary = m.summary;
      // the progress line's description is what the task is doing now; the task's own title stays the one it started with
      if (m.description && !x.description) x.description = m.description;
      if (m.tool_use_id) x.toolUseId = m.tool_use_id;
      if (m.last_tool_name) x.lastTool = m.last_tool_name;
      x.tokens = num(m.usage?.total_tokens, x.tokens);
      x.toolUses = num(m.usage?.tool_uses, x.toolUses);
      return true;
    }
    case 'task_updated': {
      const x = t.byId.get(m.task_id);
      if (!x) return false;
      const p = m.patch ?? {};
      if (p.status) {
        const s = settledStatus(p.status);
        if (s) settle(x, s, now);
        else {
          x.status = p.status;
          x.completedAt = null;
        }
      }
      if (p.description) x.description = p.description;
      if (p.is_backgrounded !== undefined) x.backgrounded = p.is_backgrounded;
      prune(t);
      return true;
    }
    case 'task_notification': {
      const x = t.byId.get(m.task_id);
      if (!x) return false;
      x.status = settledStatus(m.status) ?? 'completed';
      x.completedAt = now;
      x.notified = true;
      if (m.summary) x.summary = m.summary;
      x.tokens = num(m.usage?.total_tokens, x.tokens);
      x.toolUses = num(m.usage?.tool_uses, x.toolUses);
      if (x.type !== 'local_agent' && isTaskOutput(x.id, m.output_file)) x.output = { kind: 'file', path: m.output_file };
      prune(t);
      return true;
    }
  }
}

/** Whether a task is listed: a background one (in a level, or, before any level, not started in the foreground). */
function shown(t, x) {
  if (!isRunning(x)) return x.inLevel || x.backgrounded !== false;
  return t.level ? t.level.has(x.id) : x.backgrounded !== false;
}

/** The background tasks to show: live ones, then how the finished ones ended. */
function taskList(t) {
  const out = [];
  for (const x of t.byId.values()) {
    if (!shown(t, x)) continue;
    out.push({
      id: x.id,
      type: x.type,
      description: x.description,
      status: x.status,
      summary: x.summary,
      toolUseId: x.toolUseId,
      subagentType: x.subagentType,
      workflowName: x.workflowName,
      parentTaskId: x.parentTaskId,
      ambient: x.ambient,
      startedAt: x.startedAt,
      completedAt: x.completedAt,
      latestTool: x.lastTool,
      model: null,
      tokens: x.tokens,
      toolUses: x.toolUses,
      agentKey: x.type === 'local_agent' ? x.toolUseId : null,
      command: x.command,
      output: x.output,
    });
  }
  return out;
}

/** The background tasks still running. */
const runningTasks = (t) => taskList(t).filter(isRunning);

/** Whether something is still running in the background, which an idle close would kill. */
const hasActivity = (t) => runningTasks(t).some((x) => !x.ambient);

/** The process is gone: what it still ran stopped with it. Returns true when any task was running. */
function settleAll(t, now = clock.now()) {
  let any = false;
  for (const x of t.byId.values())
    if (isRunning(x)) {
      settle(x, 'stopped', now, 'Ended when the Claude Code process exited');
      any = true;
    }
  return any;
}

/**
 * A session's task list once a process reported its own: a task the new list lacks (a process that ended,
 * or one that replaced it) is kept, settled as stopped if it still ran. The newest FINISHED_MAX finished stay.
 */
function mergeTaskLists(prev, next, now = clock.now()) {
  const ids = new Set(next.map((x) => x.id));
  const kept = (prev ?? [])
    .filter((x) => !ids.has(x.id))
    .map((x) =>
      isRunning(x)
        ? { ...x, status: 'stopped', completedAt: x.completedAt ?? now, summary: x.summary || 'Ended when the Claude Code process exited' }
        : x,
    );
  const all = [...next, ...kept];
  // a list from an older main may have finished tasks without a time: they count as oldest
  const at = (x) => x.completedAt ?? 0;
  const finished = all.filter((x) => !isRunning(x)).sort((a, b) => at(b) - at(a));
  const drop = new Set(finished.slice(FINISHED_MAX));
  return all.filter((x) => !drop.has(x));
}

/** A session's list once its process is gone: running tasks stopped with it. */
const settleTaskList = (tasks, now = clock.now()) => mergeTaskLists(tasks, [], now);

/** The last `max` bytes of a task's output file, as text; refuses any other file. */
async function readTaskOutput(taskId, file, max = 64 * 1024) {
  if (!isTaskOutput(taskId, file)) throw new Error('Not a task output file');
  const fh = await fs.promises.open(file, 'r');
  return withAsyncCleanup(
    async () => {
      const { size } = await fh.stat();
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    },
    () => fh.close(),
  );
}

/**
 * Work the session scheduled for later lives in its process too: cron jobs (CronCreate, until
 * CronDelete) and a /loop's next wake-up (ScheduleWakeup). `sched` is {crons, wakeAt}.
 */
function noteSchedule(sched, m, now = clock.now()) {
  if (m?.type !== 'assistant') return;
  for (const b of contentBlocks(m.message?.content)) {
    if (b?.type !== 'tool_use') continue;
    if (b.name === 'CronCreate') sched.crons++;
    else if (b.name === 'CronDelete') sched.crons = Math.max(0, sched.crons - 1);
    else if (b.name === 'ScheduleWakeup') {
      const input = isJsonRecord(b.input) ? b.input : {};
      const delay = Math.min(3600, Math.max(60, Number(input.delaySeconds) || 60));
      // a minute's slack for the wake-up's own turn to start
      sched.wakeAt = input.stop ? 0 : now + (delay + 60) * 1000;
    }
  }
}

/** The idle reaper leaves a process alone while it has background work or scheduled work. */
const keepAlive = (t, sched, now = clock.now()) => hasActivity(t) || sched.crons > 0 || sched.wakeAt > now;

module.exports = {
  emptyTasks,
  reduceTasks,
  taskList,
  runningTasks,
  hasActivity,
  settleAll,
  mergeTaskLists,
  settleTaskList,
  settledStatus,
  isTaskOutput,
  readTaskOutput,
  noteSchedule,
  keepAlive,
  FINISHED_MAX,
};
