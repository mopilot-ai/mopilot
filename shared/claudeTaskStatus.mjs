// A Claude Code background task's native status as a settled one, as the task registry (electron/harness/claude/tasks.cjs) and
// the exit gate (electron/platform/exitGate.cjs) read it. A task with no status yet is still running; an agent run's
// trailer reads its own statuses (core/crates/translate/src/claude/agent_runs.rs settled_status).

/** A task's native status as a settled one (killed → stopped; blocked, cancelled → failed); null while it runs. */
export function settledStatus(status) {
  switch (status) {
    case undefined:
    case null:
    case 'running':
    case 'pending':
    case 'paused':
      return null;
    case 'failed':
    case 'error':
    case 'blocked':
    case 'cancelled':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return 'completed';
  }
}
