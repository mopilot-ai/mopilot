// The conversation a compaction folded away. The SDK's reader follows parentUuid back from the newest message and stops
// at a compact_boundary (its parentUuid is null), so a compacted chat read back shows only what came after; the folded
// messages are still in the file, joined to the boundary by logicalParentUuid.
const fs = require('node:fs');
const { createInterface } = require('node:readline');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');

const BOUNDARY = 'compact_boundary';
const shown = (r) =>
  (r.type === 'user' || r.type === 'assistant' || (r.type === 'system' && r.subtype === BOUNDARY)) && !r.isSidechain && !r.teamName;

async function eachRecord(file, visit) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const parsed = parseJsonRecord(line);
      if (parsed.ok && typeof parsed.record.uuid === 'string') visit(parsed.record);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** A transcript record in the shape getSessionMessages returns it. */
function asSdkMessage(r) {
  const base = {
    type: r.type,
    uuid: r.uuid,
    session_id: r.sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: r.timestamp,
  };
  // a boundary as the SDK lists the last one: bare, so the summary after it is the compaction's one divider
  if (r.type === 'system') return base;
  return {
    ...base,
    message: r.message,
    ...(r.isMeta ? { is_meta: true } : {}),
    ...(r.isCompactSummary ? { isCompactSummary: true } : {}),
  };
}

/**
 * The messages before the SDK's first one, oldest first: from the transcript file, the chain that led into the
 * compaction (boundary to logical parent, then parent to parent, through earlier compactions' boundaries too).
 * Empty when nothing was compacted, or the file has no earlier chain.
 * @param {string | null} file
 * @param {{ uuid?: string, isCompactSummary?: boolean }[]} sdkMessages
 */
async function compactedHistory(file, sdkMessages) {
  // the summary is what a compaction leaves in the SDK's list; without one nothing was folded away
  if (!file || !sdkMessages.some((m) => m.isCompactSummary === true)) return [];
  const have = new Set(sdkMessages.map((m) => m.uuid));
  // first pass: only the links, so a long transcript's bodies are not all held at once
  const links = new Map();
  // every record is a link, shown or not: the chain can pass through an attachment, a progress or a sidechain record
  await eachRecord(file, (r) => links.set(r.uuid, { parent: (r.type === 'system' ? r.logicalParentUuid : r.parentUuid) ?? null }));
  const wanted = new Set();
  for (const m of sdkMessages) {
    // a boundary's link is its logical parent; the SDK's first kept message may itself be one
    for (let id = links.get(m.uuid)?.parent; id && links.has(id) && !wanted.has(id) && !have.has(id); id = links.get(id).parent)
      wanted.add(id);
  }
  if (!wanted.size) return [];
  const found = [];
  await eachRecord(file, (r) => {
    if (!wanted.delete(r.uuid) || !shown(r)) return;
    found.push(asSdkMessage(r));
  });
  return found;
}

module.exports = { compactedHistory };
