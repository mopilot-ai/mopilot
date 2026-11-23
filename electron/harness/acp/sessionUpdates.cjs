// Native ACP updates keep each session's settings current, then record and publish its live turn.
const { acpStateUpdate } = require('../../../shared/acpSessionState.mjs');
const { isForeignSageCall } = require('./clientMethods.cjs');
function recordSessionUpdate(host, chat, update, meta) {
  if (!update || typeof update !== 'object') return;
  const normalize = host.quirksOf(chat.harness)?.normalizeUpdate;
  if (typeof normalize === 'function') update = normalize(update, meta);
  if (!update || typeof update !== 'object') return;
  const next = acpStateUpdate(chat.state, update);
  if (next) Object.assign((chat.state ??= {}), next);
  // history the agent replays on session/load; the thread shows it from the transcript
  if (chat.loading) return;
  const kind = update.sessionUpdate;
  // the agent changed the mode itself (leaving plan mode): that is the chat's mode now
  if (kind === 'current_mode_update' && !chat.reapplying && typeof update.currentModeId === 'string')
    host.items.append(chat.key, { t: 'mode', modeId: update.currentModeId, at: host.now() });
  // the model reached for another chat's MoPilot tool server (an agent that shares MCP servers across sessions,
  // #2311, #2302): the turn is stopped, and the call shows as refused rather than as this chat's own
  if (kind === 'tool_call' && isForeignSageCall(update, chat.serverName)) {
    host.cancel(chat.key);
    update = { ...update, status: 'failed', rawOutput: "Refused: this tool belongs to another chat's MoPilot session." };
  }
  const turnId = chat.prompting?.turnId ?? null;
  if (!turnId && (kind === 'tool_call' || kind === 'tool_call_update')) host.unattended(chat, 'tool call');
  host.items.appendUpdate(chat.key, { t: 'update', turnId, update, at: host.now() });
  host.emitEvent({ key: chat.key, kind: 'update', turnId, update });
}

module.exports = { recordSessionUpdate };
