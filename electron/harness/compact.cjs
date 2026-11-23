// Compaction adapter dispatch: native Codex requests and the current command of Claude Code or an ACP session.
const { byFamily } = require('../session/contract/route.cjs');
const { acpBindings, claudeBindings } = require('./bindings.cjs');
const { assertCodexRef } = require('./codexRef.cjs');
const { assertInputCurrent, carryInputGuard, guardSend } = require('../session/contract/inputGuard.cjs');

/** @typedef {import('../../shared/model/session').QueuedMessage} QueuedMessage */
/** @typedef {{ kind: string, id: string, key: string }} CompactRef */
/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter */
/** @typedef {{ startTurn: (chatId: string, ref: CompactRef, item: QueuedMessage, origin: number | null) => Promise<{ started: boolean, turnId?: string, error?: string }> }} CommandAdapter */

/**
 * Compaction starts its own native turn, without sending a prompt to the model. A stop during resume
 * retires the queued input before the transport; a failed request keeps it available for retry.
 * @param {CodexAdapter} adapter
 * @param {CompactRef} ref
 * @param {QueuedMessage} item
 */
async function compactCodex(adapter, ref, item) {
  const { id } = assertCodexRef(ref);
  await adapter.ensureResumed(id);
  assertInputCurrent(item);
  adapter.touch(id);
  adapter.compacting.add(id);
  try {
    await adapter.request('thread/compact/start', carryInputGuard(item, { threadId: id }));
  } catch (error) {
    adapter.compacting.delete(id);
    throw error;
  } finally {
    adapter.touch(id);
  }
  return { started: true };
}

/** The receiving adapter resolves the command at dispatch, including after a queued harness switch. */
/** @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (session: import('../../shared/model/session').SessionState) => import('../../shared/model/harness').Binding | null>} */
const BINDING = {
  codex: () => null,
  claude: () => claudeBindings().compact,
  acp: (session) => acpBindings({ commands: session.acp?.commands }).compact,
};

/**
 * @param {CodexAdapter | CommandAdapter} adapter the current turn adapter; native request support is confined to this harness layer
 * @param {string} chatId stable MoPilot chat id
 * @param {CompactRef} ref current native segment
 * @param {QueuedMessage} item typed compaction intent retained by the ordinary message queue
 * @param {number | null} origin
 * @param {() => import('../../shared/model/session').SessionState} session
 * @param {() => void} current rechecks the controller's turn and current native segment at transport
 */
async function startCompact(adapter, chatId, ref, item, origin, session, current) {
  const binding = byFamily(BINDING, ref.kind)(session());
  const release = guardSend(item, () => {
    current();
    if (binding?.via === 'passthrough') {
      const latest = byFamily(BINDING, ref.kind)(session());
      if (latest?.via !== 'passthrough' || latest.template !== binding.template)
        throw new Error('The compaction command changed before it could be sent. Retry when ready.');
    }
  });
  try {
    assertInputCurrent(item);
    if (typeof item.opts.compact?.args !== 'string') throw new Error('Invalid compaction request. Remove it and try again.');
    const { args } = item.opts.compact;
    if (item.attachments.length) throw new Error('Compaction cannot include attachments. Remove them and try again.');
    if (!binding) {
      if (args.trim()) throw new Error("This chat can't apply custom compaction instructions. Remove them and retry.");
      return await compactCodex(/** @type {CodexAdapter} */ (adapter), ref, item);
    }
    if (binding.via !== 'passthrough') throw new Error("This agent can't compact this chat. The request is kept in the queue.");
    const text = binding.template.replace('{args}', () => args).trim();
    const command = carryInputGuard(item, {
      ...item,
      text,
      // Handoff context must not turn a native slash command into an ordinary prompt.
      opts: { ...item.opts, prefix: undefined, goal: undefined, plan: false },
    });
    return await /** @type {CommandAdapter} */ (adapter).startTurn(chatId, ref, command, origin);
  } finally {
    release();
  }
}

module.exports = { startCompact };
