// Live output of a running Claude Code Bash command (D-68). The SDK stream carries nothing between task_started and the tool
// result (C19, C23), but the Query has a get_task_output control request (runtime method getTaskOutput, absent from the SDK's
// types) that returns the last 8 KiB a foreground shell task wrote, answered while it runs (C24). Main polls it for each
// foreground Bash task and forwards what changed as a synthetic `system/sage_bash_output` message, which the translator puts
// on the command card. A CLI without the request, or one that refuses it, just leaves the output to arrive with the result.

const { clock } = require('../../platform/ports/clock.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const POLL_MS = 700;
/** Consecutive failures after which the session stops asking. */
const MAX_FAILS = 3;

/**
 * One per CLI process. `emit(msg)` forwards a synthetic message; `timers` is injectable for tests. `visible()` says whether
 * any app window is on screen: nobody sees a card while every window is hidden, so a tick then asks the CLI for nothing
 * (the next tick after a window shows reads fresh; the tool result carries the final output either way).
 * Feed every SDK message to `onMessage`; call `close()` when the process ends.
 */
function createLiveOutput({
  q,
  emit,
  intervalMs = POLL_MS,
  visible = () => true,
  timers = { setInterval: clock.setInterval, clearInterval: clock.clearInterval },
}) {
  const watching = new Map(); // task_id -> { toolUseId, last, busy, fails, timer }
  let off = typeof q?.getTaskOutput !== 'function';

  const stop = (taskId) => {
    const w = watching.get(taskId);
    if (!w) return;
    timers.clearInterval(w.timer);
    watching.delete(taskId);
  };

  const poll = async (taskId) => {
    const w = watching.get(taskId);
    if (!w || w.busy || !visible()) return;
    w.busy = true;
    try {
      const r = await q.getTaskOutput(taskId);
      // the task may have ended while the request was out; its tool result carries the final output
      if (watching.get(taskId) !== w) return;
      w.fails = 0;
      const output = typeof r?.output === 'string' ? r.output : '';
      if (output && output !== w.last) {
        w.last = output;
        emit({ type: 'system', subtype: 'sage_bash_output', tool_use_id: w.toolUseId, task_id: taskId, output, truncated: !!r.truncated });
      }
    } catch {
      if (watching.get(taskId) !== w) return;
      if (++w.fails >= MAX_FAILS) {
        off = true;
        close();
      }
    } finally {
      w.busy = false;
    }
  };

  function onMessage(m) {
    if (!m) return;
    if (m.type === 'system' && m.subtype === 'task_started') {
      // a backgrounded shell has already returned its tool result: nothing on a card to fill
      if (off || m.task_type !== 'local_bash' || m.is_backgrounded || !m.tool_use_id || !m.task_id || watching.has(m.task_id)) return;
      const w = { toolUseId: m.tool_use_id, last: '', busy: false, fails: 0, timer: /** @type {NodeJS.Timeout | null} */ (null) };
      watching.set(m.task_id, w);
      w.timer = timers.setInterval(() => poll(m.task_id), intervalMs);
      w.timer.unref?.();
      // cannot reject: poll catches every failure and counts it toward MAX_FAILS
      void poll(m.task_id);
      return;
    }
    if (m.type === 'system' && (m.subtype === 'task_notification' || (m.subtype === 'task_updated' && m.patch?.is_backgrounded)))
      return stop(m.task_id);
    if (m.type === 'user' && Array.isArray(m.message?.content))
      for (const b of contentBlocks(m.message.content))
        if (b.type === 'tool_result') for (const [id, w] of watching) if (w.toolUseId === b.tool_use_id) stop(id);
  }

  function close() {
    for (const id of [...watching.keys()]) stop(id);
  }

  return { onMessage, close, watching: () => watching.size, disabled: () => off };
}

module.exports = { createLiveOutput, POLL_MS };
