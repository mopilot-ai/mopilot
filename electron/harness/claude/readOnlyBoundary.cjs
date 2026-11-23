// When a Claude CLI process must restart for a chat's next message to run in the mode it chose (Read-only's tool whitelist is set only at start), and when the CLI is owed nothing.
const { wantsReadOnly } = require('./sessionOptions.cjs');
const { clock } = require('../../platform/ports/clock.cjs');

/** How long after the CLI says idle that a prompt it was still owed has to start before it is given up on as folded into the turn that ended. */
const IDLE_GRACE_MS = 400;

/** The grace is over (it ran out, or the CLI went on working): sends that waited for it go on. */
function endGrace(s) {
  clock.clearTimeout(s.idleTimer);
  s.idleDone?.();
  s.idleDone = null;
}

/**
 * The CLI says it is idle (session_state_changed, #1834): a steer it folded into its running loop got no result of its own, so a
 * count of prompts per result would stay above zero for good, and a chat moved to or from Read-only would never get its CLI replaced.
 * A prompt still queued behind the turn that ended starts right after the idle, so what is owed is cleared only when nothing has
 * started within IDLE_GRACE_MS and no newer prompt went in. Called for every message of the process.
 */
function settleIdle(s, msg) {
  if (msg.parent_tool_use_id) return;
  const state = msg.type === 'system' && msg.subtype === 'session_state_changed' ? msg.state : null;
  if (state !== 'idle') {
    // the CLI is working again: whatever it is owed is a prompt it is on
    if (state || msg.type === 'assistant' || msg.type === 'stream_event') endGrace(s);
    return;
  }
  if (s.owed === 0) return;
  const sent = s.sent;
  endGrace(s);
  s.idleWait = new Promise((resolve) => (s.idleDone = resolve));
  s.idleTimer = clock.setTimeout(() => {
    if (s.sent === sent) {
      s.owed = 0;
      s.busy = false;
      s.woken = false;
    }
    endGrace(s);
  }, IDLE_GRACE_MS);
  s.idleTimer.unref?.();
}

/**
 * The session a send decides about, once a grace that is running has ended: a message that comes within IDLE_GRACE_MS of the idle
 * (a fast client, a phone's queue) would see what is owed still counted and skip the restart a Read-only move needs (#4704). A steer
 * (priority) goes straight to the live CLI and does not wait.
 */
async function settled(s, priority) {
  if (s?.idleDone && !priority) await s.idleWait;
  return s;
}

/**
 * Whether an idle process has to be replaced to run the chat's next message in the permission it picked. Read-only is a mode plus a
 * tool whitelist set at start, so the process's start-time flag and the mode the CLI last confirmed must both say Read-only for a
 * Read-only message to keep it, and neither may for any other: a live switch into dontAsk (a process started in another mode has no
 * whitelist) and a live switch out that the CLI never took (it still reports dontAsk) both end in a fresh process. A confirmed plan
 * mode says nothing about the whitelist, so the start-time flag decides there.
 */
function moved(s, opts) {
  if (s.busy || s.unpersisted || !opts.permission) return false;
  const confirmed = s.nativeMode && s.nativeMode !== 'plan' ? s.nativeMode === 'dontAsk' : s.readOnly;
  return wantsReadOnly(opts) ? !(s.readOnly && confirmed) : s.readOnly || confirmed;
}

module.exports = { settleIdle, settled, moved };
