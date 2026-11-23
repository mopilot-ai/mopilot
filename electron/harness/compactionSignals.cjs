// Native compaction notifications normalized at the harness boundary; unknown or malformed signals never release input.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const text = (v) => typeof v === 'string';

/** Codex reports a compaction item in a specific native turn, for manual and automatic compaction alike. */
function codexCompaction(msg) {
  if (msg?.method !== 'item/started' && msg?.method !== 'item/completed') return null;
  const p = msg.params;
  if (
    !isJsonRecord(p) ||
    !text(p.threadId) ||
    !text(p.turnId) ||
    !isJsonRecord(p.item) ||
    p.item.type !== 'contextCompaction' ||
    !text(p.item.id)
  )
    return null;
  return {
    source: { kind: 'codex', key: p.threadId },
    turnId: p.turnId,
    id: p.item.id,
    phase: msg.method === 'item/started' ? 'active' : 'complete',
  };
}

/** Claude's SDK identifies the session; a status-only permission update is not a compaction completion. */
function claudeCompaction(e) {
  const m = e?.msg;
  if (e?.kind !== 'message' || !text(e.key) || !isJsonRecord(m) || !text(m.session_id)) return null;
  if (m.type === 'conversation_reset' && text(m.new_conversation_id))
    return { source: { kind: 'claude', key: e.key }, id: m.session_id, phase: 'reset', account: e.account };
  if (m.type !== 'system') return null;
  let phase;
  if (m.subtype === 'compact_boundary') phase = 'complete';
  else if (m.subtype === 'status') {
    if (m.status === 'compacting') phase = 'active';
    else if (m.compact_result === 'success') phase = 'complete';
    else if (m.compact_result === 'failed') phase = 'failed';
    else if (m.status === null || m.status === 'requesting') phase = 'ended';
  }
  if (!phase) return null;
  return { source: { kind: 'claude', key: e.key }, id: m.session_id, phase, account: e.account };
}

module.exports = { codexCompaction, claudeCompaction };
