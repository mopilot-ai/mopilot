// Codex collaboration events that create parent-child thread relations, shared by native routing and agent views.
export const isCodexAgentSpawn = (item) => item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent';
export const isCodexChildThreadId = (id, parent) => typeof id === 'string' && id.length > 0 && id !== parent;

/** Ancestry is first-writer-owned and acyclic; collaboration cannot steal an established child. */
export function canLinkCodexChild(child, parent, parents) {
  if (!isCodexChildThreadId(child, parent) || !isCodexChildThreadId(parent, child) || parents.has(child)) return false;
  const seen = new Set([child]);
  let key = parent;
  while (!seen.has(key)) {
    seen.add(key);
    if (!parents.has(key)) return true;
    key = parents.get(key);
  }
  return false;
}
