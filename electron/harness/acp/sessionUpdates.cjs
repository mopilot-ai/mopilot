// Native ACP updates keep each session's settings current, then record and publish its live turn.
const { acpStateUpdate } = require('../../../shared/acpSessionState.mjs');
const { isForeignSageCall } = require('./clientMethods.cjs');
const { acpPromptSuggestion } = require('./promptSuggestions.cjs');
function recordSessionUpdate(host, chat, update, meta) {
  if (!update || typeof update !== 'object') return;
  const normalize = host.quirksOf(chat.harness)?.normalizeUpdate;
  if (typeof normalize === 'function') update = normalize(update, meta);
  if (!update || typeof update !== 'object') return;
  const standard = update.sessionUpdate === 'prompt_suggestions_update';
  const legacy = update.sessionUpdate === 'session_info_update' && update._meta && Object.hasOwn(update._meta, 'promptSuggestions');
  if (standard || legacy) {
    const suggestion = acpPromptSuggestion(update);
    const run = chat.prompting;
    // An old offer can cross the next prompt in transit. Only accept it after that prompt's own reply has arrived.
    if (suggestion !== undefined && !chat.loading && !chat.isolated && (!run || run.receipt?.received))
      host.emitEvent({ key: chat.key, kind: 'promptSuggestion', turnId: run?.turnId ?? null, text: suggestion });
    if (standard) return;
    // Preserve other session metadata while keeping the prediction out of the transcript.
    const { promptSuggestions, ...meta } = update._meta;
    update = { ...update, _meta: meta };
  }
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
