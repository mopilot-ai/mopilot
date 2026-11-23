// Explicit fake-native and real-Git barriers for the prepared-child cancellation/restore race; only scratch-owned paths qualify.
const fs = require('node:fs');
const path = require('node:path');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A single real native thread/start is created and announced before its actual RPC answer is released. */
function holdNativeAllocationReply(message, result, send, logFile, { io = fs, schedule = setTimeout, now = Date.now } = {}) {
  if (!logFile || message.method !== 'thread/start' || message.params?.ephemeral === true) return false;
  const file = `${logFile}.prepared-start.json`;
  if (!io.existsSync(file)) return false;
  const policy = JSON.parse(io.readFileSync(file, 'utf8'));
  if (typeof policy.root !== 'string' || typeof message.params?.cwd !== 'string') throw new Error('Invalid prepared-start fixture gate');
  if (!inside(policy.root, message.params.cwd)) return false;
  io.unlinkSync(file);
  io.writeFileSync(`${logFile}.prepared-start.entered`, JSON.stringify({ id: result.thread.id, cwd: message.params.cwd }));
  const deadline = now() + 20_000;
  const poll = () => {
    if (io.existsSync(`${logFile}.prepared-start.release`)) send({ id: message.id, result });
    else if (now() >= deadline) send({ id: message.id, error: { code: -32000, message: 'Prepared native start gate timed out' } });
    else schedule(poll, 10);
  };
  poll();
  return true;
}

/** Only the production non-force removal form for a managed scratch checkout can enter the Git barrier. */
function removalTarget(args, root) {
  return args.length === 3 && args[0] === 'worktree' && args[1] === 'remove' && inside(root, args[2]) ? args[2] : null;
}

/** Reply to the actual fake-native request, preserving its synchronous save and native error envelope. */
function replyNativeRequest(message, run, send, { logFile, saveState }) {
  try {
    const result = run();
    if (!holdNativeAllocationReply(message, result, send, logFile)) send({ id: message.id, result });
    saveState();
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message || error) } });
  }
}

module.exports = { holdNativeAllocationReply, removalTarget, replyNativeRequest };
