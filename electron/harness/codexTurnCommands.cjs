// The commands each running Codex turn started that still run: Stop ends the stopped turn's own commands with it, as Stop does on Claude Code (#1940).
const { methodMissing } = require('./versions.cjs');
const { errorText } = require('../../shared/userError.mjs');
const { identityKey } = require('../../shared/identityKey.mjs');

/** How long the background-terminal list and each terminate may take before Stop says it couldn't end the command. */
const STOP_COMMANDS_MS = 5_000;

/**
 * The app-server's turn/interrupt ends the turn but leaves a unified-exec command it started running in the
 * background, where the model waited on it (#1940). Each thread's command items that started and have not completed
 * are kept by turn; Stop reads the stopped turn's before its interrupt goes out, then terminates their processes.
 * A turn that completes on its own leaves its still-running commands as background terminals: no longer its own.
 */
class CodexTurnCommands {
  constructor() {
    /** native thread id -> (command item id -> the turn that started it) */
    this.running = new Map();
    /** thread/item keys of commands a Stop is ending: their completion reads as cut off, as on Claude Code and ACP */
    this.stopping = new Set();
  }

  /** Notes command items starting and completing, and forgets a turn's when it completes. */
  observe(method, p) {
    const threadId = p?.threadId;
    if (!threadId) return;
    const item = p.item;
    if (method === 'item/started' && item?.type === 'commandExecution' && item.id && p.turnId) {
      if (!this.running.has(threadId)) this.running.set(threadId, new Map());
      this.running.get(threadId).set(item.id, p.turnId);
    } else if (method === 'item/completed' && item?.type === 'commandExecution') this.drop(threadId, (id) => id === item.id);
    else if (method === 'turn/completed' && p.turn?.id) this.drop(threadId, (_, turnId) => turnId === p.turn.id);
  }

  /**
   * The command items `turnId` started that still run: a snapshot, so a Stop that fails (or another Stop of the same
   * turn) still finds them. Their completion is marked cut off until `release`.
   */
  take(threadId, turnId) {
    const taken = [...(this.running.get(threadId) ?? [])].filter(([, turn]) => turn === turnId).map(([id]) => id);
    for (const id of taken) this.stopping.add(identityKey(threadId, id));
    return taken;
  }

  /** A Stop that failed: its commands' completion is not marked. */
  release(threadId, itemIds) {
    for (const id of itemIds) this.stopping.delete(identityKey(threadId, id));
  }

  /** A stopped command's completion carries cutOff, so its row reads "Interrupted" rather than its exit code. */
  markStopped(method, p) {
    if (method !== 'item/completed' || p.item?.type !== 'commandExecution') return p;
    if (!this.stopping.delete(identityKey(p.threadId, p.item.id))) return p;
    return { ...p, item: { ...p.item, cutOff: true } };
  }

  drop(threadId, match) {
    const cmds = this.running.get(threadId);
    if (!cmds) return;
    for (const [id, turnId] of cmds) if (match(id, turnId)) cmds.delete(id);
    if (!cmds.size) this.running.delete(threadId);
  }
}

/**
 * Terminates the processes of `itemIds` (a stopped turn's commands) that still run in `threadId`. One already gone is
 * not in the list; a list or terminate that fails is said, so a command left running is never silent.
 * @param {{ call: (method: string, params: object, timeoutMs?: number) => Promise<any>, toast: (text: string) => void }} io
 */
async function stopTurnCommands(io, threadId, itemIds) {
  let list;
  try {
    list = await io.call('thread/backgroundTerminals/list', { threadId }, STOP_COMMANDS_MS);
  } catch (e) {
    // an app-server without background terminals ended the command with its turn
    if (!methodMissing(e)) io.toast(`Couldn't stop the command this turn started: ${errorText(e)}`);
    return;
  }
  const own = (Array.isArray(list?.data) ? list.data : []).filter((t) => itemIds.includes(t?.itemId) && t.processId);
  await Promise.all(
    own.map((t) =>
      io
        .call('thread/backgroundTerminals/terminate', { threadId, processId: t.processId }, STOP_COMMANDS_MS)
        .catch((e) => io.toast(`Couldn't stop ${t.command || 'the command'}: ${errorText(e)}`)),
    ),
  );
}

module.exports = { CodexTurnCommands, stopTurnCommands, STOP_COMMANDS_MS };
