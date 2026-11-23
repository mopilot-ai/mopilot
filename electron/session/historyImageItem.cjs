// Resolve a phone image reference only inside its chat's retained source/turn/item slices, shared by message attachments and screenshot steps.
const { toRendererSegment } = require('../platform/chats.cjs');
const { sliceSegments } = require('../../shared/handoff.mjs');
const { turnIdentity } = require('../../shared/chatNotes.mjs');

/** A native item id or a structured history row id. @param {string} ref */
function itemIdOf(ref) {
  if (!ref.startsWith('[')) return ref;
  try {
    const parts = JSON.parse(ref);
    return Array.isArray(parts) && typeof parts.at(-1) === 'string' ? parts.at(-1) : null;
  } catch {
    return null;
  }
}

/**
 * The history item a reference names that `accepts` takes. With a `cache` (./historyImageCache.cjs) the chat's history is read once for all its
 * pictures; without one it is read for this ask alone.
 * @param {any} record @param {any} readTurns @param {string} ref @param {(item: any) => boolean} accepts @param {() => void} [check] @param {any} [cache]
 */
async function historyImageItem(record, readTurns, ref, accepts, check = () => undefined, cache = null) {
  const id = itemIdOf(ref);
  if (!record || !id) return null;
  const scope = ref.startsWith('[') ? JSON.parse(ref) : null;
  if (scope?.[0] === 'live') return null;
  if (cache) return cache.find(record, readTurns, id, scope, accepts, check);
  const segments = record.segments.map(toRendererSegment);
  const history = new Map();
  for (const [index, segment] of segments.entries()) {
    if (history.has(segment.nativeId) || (scope?.[0] != null && scope[0] !== segment.nativeId)) continue;
    check();
    const page = await readTurns(record.segments[index], undefined, {});
    check();
    history.set(segment.nativeId, Array.isArray(page?.turns) ? page.turns : []);
  }
  const slices = sliceSegments(segments, history);
  for (let i = slices.length - 1; i >= 0; i--) {
    if (scope?.[0] != null && scope[0] !== segments[i].nativeId) continue;
    for (const turn of slices[i]) {
      if (scope?.[1] != null && scope[1] !== turnIdentity(turn?.id)) continue;
      for (const item of Array.isArray(turn?.items) ? turn.items : []) if (item?.id === id && accepts(item)) return item;
    }
  }
  return null;
}
module.exports = { itemIdOf, historyImageItem };
