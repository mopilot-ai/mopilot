// Restore native hook notices and assistant error types the SDK strips, without restoring retired conversation branches.
const fs = require('node:fs');
const { createInterface } = require('node:readline');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');

const conversation = (m) => m.type === 'user' || m.type === 'assistant';
const hidden = (m) => m.isSidechain || m.teamName || m.isMeta;
const notice = (m) => m.type === 'system' && m.subtype === 'informational' && !hidden(m);

/** What is kept of one transcript line: a notice whole, any other line only its metadata (never a second copy of conversation text or inline media). */
const hookRecord = (m) =>
  notice(m)
    ? m
    : {
        type: m.type,
        uuid: m.uuid,
        parentUuid: m.parentUuid,
        isSidechain: m.isSidechain,
        teamName: m.teamName,
        isMeta: m.isMeta,
        error: m.error,
      };

/** The records of lines already parsed (the end of a transcript), by uuid in file order, as readHookRecords makes them from the whole file. */
function hookRecordsOf(entries) {
  const records = new Map();
  for (const m of entries) if (typeof m?.uuid === 'string') records.set(m.uuid, hookRecord(m));
  return records;
}

/** Read the metadata and notice bodies without keeping a second copy of conversation text or inline media. */
async function readHookRecords(file) {
  if (!file) return new Map();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const records = new Map();
  try {
    for await (const line of lines) {
      const parsed = parseJsonRecord(line);
      if (!parsed.ok || typeof parsed.record.uuid !== 'string') continue;
      records.set(parsed.record.uuid, hookRecord(parsed.record));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return records;
}

/** SDK-selected messages remain authoritative; apply the current edit cutoff only after all reads have settled. */
function withHookNotices(messages, records, cutoff) {
  // Restore metadata only on SDK-selected assistant messages; never admit a raw conversation branch.
  let changed = false;
  const restored = messages.map((m) => {
    const error = records.get(m.uuid)?.error;
    if (m.type !== 'assistant' || typeof error !== 'string' || m.error === error) return m;
    changed = true;
    return { ...m, error };
  });
  if (changed) messages = restored;
  if (![...records.values()].some(notice)) return messages;
  const kept = new Map();
  for (const m of records.values()) {
    kept.set(m.uuid, m);
    if (m.uuid === cutoff) break;
  }
  records = kept;
  const selected = new Set(messages.map((m) => m.uuid));
  const excluded = new Set();
  const hasConversation = messages.some(conversation) || [...records.values()].some(conversation);
  // A notice leading into a retired user/assistant branch belongs to that branch too.
  for (const m of records.values()) {
    if (!conversation(m) || selected.has(m.uuid)) continue;
    let node = m;
    while (node && !selected.has(node.uuid) && !excluded.has(node.uuid)) {
      excluded.add(node.uuid);
      node = records.get(node.parentUuid);
    }
  }
  const admitted = new Set();
  for (const m of records.values()) {
    if (!notice(m) || selected.has(m.uuid)) continue;
    let node = m;
    const seen = new Set();
    while (node && !hidden(node) && !excluded.has(node.uuid) && !seen.has(node.uuid) && !selected.has(node.uuid)) {
      seen.add(node.uuid);
      if (!node.parentUuid && !hasConversation) break;
      node = records.get(node.parentUuid);
    }
    if (!node || hidden(node) || excluded.has(node.uuid) || (!selected.has(node.uuid) && (hasConversation || node.parentUuid))) continue;
    admitted.add(m.uuid);
  }
  // Ancestry decides admission; file order places a notice beside the retained messages it originally followed.
  const after = new Map();
  let anchor = null;
  for (const m of records.values()) {
    if (selected.has(m.uuid)) anchor = m.uuid;
    if (!admitted.has(m.uuid)) continue;
    const notes = after.get(anchor) ?? [];
    notes.push(m);
    after.set(anchor, notes);
  }
  return [
    ...(after.get(null) ?? []),
    ...messages.flatMap((m) => {
      const raw = records.get(m.uuid);
      return [raw && notice(raw) ? { ...m, ...raw } : m, ...(after.get(m.uuid) ?? [])];
    }),
  ];
}

module.exports = { readHookRecords, hookRecordsOf, withHookNotices };
