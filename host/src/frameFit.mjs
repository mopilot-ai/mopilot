// Fits a stream frame to what one wire message may carry: a frame over the limit would be dropped on the way out and the app would never learn of the revision it carried (docs: design/host/index.html, package 2.3).
const CUT = '\n[cut: too long to pass on]';
/** The longest string a frame keeps, tried in turn until the frame fits. */
const STRING_LIMITS = [256 * 1024, 16 * 1024, 1024];

/** @param {unknown} value */
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** A copy of `value` with every string cut to `limit` characters (and a note saying so). @param {unknown} value @param {number} limit @returns {any} */
function clip(value, limit) {
  if (typeof value === 'string') return value.length <= limit ? value : `${value.slice(0, limit - CUT.length)}${CUT}`;
  if (Array.isArray(value)) return value.map((v) => clip(v, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, limit)]));
  return value;
}

/**
 * The frame, cut as little as it takes to fit `budget` bytes once encoded: long strings first, then (a Hello's snapshot) the oldest items. Same revisions, same keys: the app sees every frame it was owed.
 * Null when nothing short of losing the frame would do.
 * @param {Record<string, any>} frame @param {number} budget
 * @returns {Record<string, any> | null}
 */
export function fitFrame(frame, budget) {
  if (bytes(frame) <= budget) return frame;
  if (frame.t === 'hello' && Array.isArray(frame.snapshot?.items)) frame = { ...frame, snapshot: { ...frame.snapshot, paged: true } };
  for (const limit of STRING_LIMITS) {
    const cut = clip(frame, limit);
    if (bytes(cut) <= budget) return cut;
  }
  // a snapshot of many items that are small one by one: keep the newest, as the Host's own history limit does
  const items = frame.snapshot?.items;
  if (frame.t !== 'hello' || !Array.isArray(items)) return null;
  const small = clip(frame, STRING_LIMITS[STRING_LIMITS.length - 1]);
  let keep = items.length;
  while (keep > 0) {
    keep = Math.floor(keep / 2);
    const cut = {
      ...small,
      snapshot: { ...small.snapshot, items: small.snapshot.items.slice(items.length - keep), droppedItems: items.length - keep },
    };
    if (bytes(cut) <= budget) return cut;
  }
  return null;
}
