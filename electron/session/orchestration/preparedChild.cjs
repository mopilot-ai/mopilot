// A retired native child may be archived while idle; its worktree already belongs to the chat's normal lifecycle.
const { noteIgnored } = require('../../ignored.cjs');

async function discardPrepared(orch, made, reserved = false) {
  if (reserved) return;
  const state = orch.o.controller.state.get(made.chatId);
  if (state.turn !== 'idle' || state.queue.length || state.approvals.length) {
    orch.o.starter.retainWorktree?.(made.cwd);
    return;
  }
  try {
    orch.o.archive(made.chatId);
  } catch (error) {
    // The task was never sent; a failed cleanup preserves its history/worktree rather than hiding the failure.
    noteIgnored('retire an unused linked-session allocation', error);
  }
}

async function requireCurrentChild(orch, made, args) {
  if (!args.claim || args.claim.current()) return;
  await discardPrepared(orch, made, !!args.reservedChatId);
  throw Object.assign(
    new Error('This session changed while the child was prepared. Its task was not sent; any unclaimed empty session was archived.'),
    { code: 'start_cancelled' },
  );
}

module.exports = { discardPrepared, requireCurrentChild };
