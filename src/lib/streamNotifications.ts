// Frame-batched display deltas for a streamed transcript. A long reply arrives as hundreds of text and
// thinking deltas; applying each one as its own store update, interleaved with tool and approval
// updates, can re-render a thread faster than React allows (minified error #185, "Maximum update depth
// exceeded"). Text and thinking deltas are joined by key (every field but the delta) and applied once
// per frame, even when several chats or items interleave; every other notification first applies what
// is pending, so the order the transcript sees never changes.
import { isInvalidStreamNotification } from '../../shared/streamDelta.mjs';

type Params = Record<string, unknown>;
type Notification = { method: string; params: Params };
/** Runs `paint` later and returns a function that cancels it. */
type Schedule = (paint: () => void) => () => void;

// Every append-only display delta: message and plan text, reasoning, and a command's output (which
// otherwise concatenates onto an ever longer string once per delta).
const TEXT_DELTAS = new Set([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
]);

/** Whether `params`, whose field names are `keys`, has the same method and fields, other than `delta`, as `held`. */
function sameKey(held: Notification, method: string, params: Params, keys: string[]): boolean {
  if (held.method !== method || Object.keys(held.params).length !== keys.length) return false;
  return keys.every((key) => key === 'delta' || (Object.hasOwn(held.params, key) && Object.is(held.params[key], params[key])));
}

/** Runs a flush's deliveries together: the store sets it to hold their writes until the last one (store/core.ts). */
let batch: (run: () => void) => void = (run) => run();
export function setStreamBatch(next: (run: () => void) => void) {
  batch = next;
}

/** Next animation frame, with a 50ms timer for windows in the background, which may stop producing frames. */
export function schedulePaint(paint: () => void): () => void {
  let frame: number | undefined;
  const timer = setTimeout(paint, 50);
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(paint);
  return () => {
    clearTimeout(timer);
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  };
}

/**
 * `emit` delivers a notification, holding text and thinking deltas until the next paint; `flush`
 * delivers what is held now (before an approval, an interrupt, a turn's end or a session change).
 */
export function createStreamNotifications(deliver: (method: string, params: Params) => void, schedule: Schedule = schedulePaint) {
  let pending: Notification[] = [];
  const byItem = new Map<unknown, Notification[]>();
  let cancel: (() => void) | undefined;
  const flush = () => {
    cancel?.();
    cancel = undefined;
    const held = pending;
    pending = [];
    byItem.clear();
    // every chat's held deltas are one store commit
    batch(() => {
      for (const { method, params } of held) deliver(method, params);
    });
  };
  const emit = (method: string, params: Params) => {
    if (isInvalidStreamNotification(method, params)) return;
    if (!TEXT_DELTAS.has(method)) {
      flush();
      deliver(method, params);
      return;
    }
    // joined with any pending delta of the same key, so chats and items streaming at once still
    // cost one update each per frame; the key is every field but `delta`, so no item, index or
    // identity is lost
    const keys = Object.keys(params);
    // Item buckets narrow the search without encoding opaque identities. The exact comparison
    // still distinguishes every field, including absent fields and Object.is(-0, 0).
    const itemId = keys.includes('itemId') ? params.itemId : undefined;
    let bucket = byItem.get(itemId);
    if (!bucket) byItem.set(itemId, (bucket = []));
    const same = bucket.find((held) => sameKey(held, method, params, keys));
    if (same) same.params.delta = String(same.params.delta) + String(params.delta);
    else {
      const held = { method, params: { ...params } };
      pending.push(held);
      bucket.push(held);
    }
    cancel ??= schedule(flush);
  };
  return { emit, flush };
}
