// The push notifier rule, the relay's copy of electron/platform/notify.cjs: one notification per chat, "needs you"
// outranks "done" for ten minutes, and the same kind arriving for other chats within 60 s merges into "(n)". The title is
// the kind's fixed text and the body is always empty, so nothing a chat wrote reaches a lock screen.

export const MERGE_MS = 60_000;
export const HOLD_MS = 10 * 60_000;
/** How long a chat's shared collapse id is remembered for its clearing: a card may wait a long time, and a forgotten id only means the clearing is shown beside the merged notification. */
export const COLLAPSE_MS = 24 * 60 * 60_000;
/**
 * The least gap between two pushes of the same kind for the same chat. A Mac that asks again and again (a chat with approval after
 * approval; an older Mac that pushes each card) is heard once per window. Two minutes covers answers given back to back at the
 * phone, and is short enough that a person who walked away is told of the next real need; another chat is never held back by it.
 */
export const REPEAT_MS = 2 * 60_000;

/** Same texts as shared/momoNotices.mjs for MoMo; tests/relayNotifier.test.ts keeps them equal. */
export const TITLES = Object.freeze({
  needsYou: 'A chat needs you',
  done: 'A chat finished',
  momoNeedsYou: 'MoMo needs you',
  machineOffline: 'Your Mac went offline',
  // true whatever ended the card (answered on another device, stopped, its turn ended): the chat may well still be running
  cleared: 'A chat no longer needs you',
});

const NEEDS = new Set(['needsYou', 'momoNeedsYou']);

/** One notifier per receiving phone, so "one per chat" never mixes two people's chats. */
export class Notifier {
  constructor() {
    /** @type {Map<string, { prio: number, at: number }>} */
    this.byRef = new Map();
    /** @type {Map<string, { at: number, refs: Set<string> }>} */
    this.groups = new Map();
    /** When each kind last went out for each chat, `kind|ref`. @type {Map<string, number>} */
    this.sent = new Map();
    /** The collapse id a chat's "needs you" went out under when that was not its own (a merged "(n)"), so its clearing replaces that notification. @type {Map<string, { id: string, at: number }>} */
    this.collapse = new Map();
  }

  /** A chat's "needs you" went out under a shared collapse id: its clearing must use the same one. @param {string} ref @param {string} id @param {number} now */
  remember(ref, id, now) {
    this.collapse.set(ref, { id, at: now });
  }

  /** The collapse id a chat's last "needs you" shared with others, once, or undefined when it had its own. @param {string} ref */
  takeCollapse(ref) {
    const id = this.collapse.get(ref)?.id;
    this.collapse.delete(ref);
    return id;
  }

  /**
   * @param {string} kind one of TITLES' keys
   * @param {string} ref the opaque chat handle (the pair id for machineOffline)
   * @param {number} now
   * @param {boolean} [fromHost] a Host's own push: it already sends one push per card and the clearing that replaces it, so neither the hold of a "needs you" over a "done" nor the repeat window applies (they are for a Mac that asks again and again)
   * @returns {{ title: string, count: number, merged: boolean, ref: string, undo: () => void } | null} null when a held "needs you" outranks this, or the same kind went out for this chat within REPEAT_MS;
   * `undo` takes the notice back (the push did not go out), unless something newer has been recorded since
   */
  push(kind, ref, now, fromHost = false) {
    if (kind === 'cleared') {
      // a withdrawal: the card it replaces never holds it back, it is never one of a "(n)" group, it ends that chat's hold on a later "done",
      // and the chat no longer counts in the "(n)" of the next "needs you"
      this.byRef.delete(ref);
      const needs = this.groups.get('needsYou');
      if (needs) {
        needs.refs.delete(ref);
        if (!needs.refs.size) this.groups.delete('needsYou');
      }
      return { title: TITLES.cleared, count: 1, merged: false, ref, undo: () => undefined };
    }
    const prio = NEEDS.has(kind) ? 2 : 1;
    const held = this.byRef.get(ref);
    if (!fromHost && held && held.prio > prio && now - held.at < HOLD_MS) return null;
    const sentKey = `${kind}|${ref}`;
    const lastSent = this.sent.get(sentKey);
    if (!fromHost && lastSent !== undefined && now - lastSent < REPEAT_MS) return null;
    this.sent.set(sentKey, now);
    const previous = this.groups.get(kind);
    const live = previous && now - previous.at < MERGE_MS ? previous : null;
    const group = live && [...live.refs].some((r) => r !== ref) ? live : { at: now, refs: new Set() };
    const before = { at: group.at, refs: new Set(group.refs), kept: group === live };
    group.refs.delete(ref);
    group.refs.add(ref);
    group.at = now;
    this.groups.set(kind, group);
    const entry = { prio, at: now };
    this.byRef.set(ref, entry);
    const undo = () => {
      // the push did not go out: it does not count against the next one
      if (this.sent.get(sentKey) === now) {
        if (lastSent !== undefined) this.sent.set(sentKey, lastSent);
        else this.sent.delete(sentKey);
      }
      if (this.byRef.get(ref) === entry) {
        if (held) this.byRef.set(ref, held);
        else this.byRef.delete(ref);
      }
      // the group goes back only while it is still the one this notice made or joined, and nothing joined it since
      if (this.groups.get(kind) === group && group.at === now) {
        if (before.kept) {
          group.at = before.at;
          group.refs = before.refs;
        } else if (previous) this.groups.set(kind, previous);
        else this.groups.delete(kind);
      }
    };
    const count = group.refs.size;
    const title =
      count > 1 ? `${TITLES[/** @type {keyof typeof TITLES} */ (kind)]} (${count})` : TITLES[/** @type {keyof typeof TITLES} */ (kind)];
    return { title, count, merged: count > 1, ref, undo };
  }

  /** Forgets everything held for the chats of one pair (its refs are `<pairId>:<ref>`), when that pair is removed. */
  forgetPair(/** @type {string} */ pairId) {
    const prefix = `${pairId}:`;
    for (const ref of this.byRef.keys()) if (ref.startsWith(prefix)) this.byRef.delete(ref);
    for (const key of this.sent.keys()) if (key.slice(key.indexOf('|') + 1).startsWith(prefix)) this.sent.delete(key);
    for (const ref of this.collapse.keys()) if (ref.startsWith(prefix)) this.collapse.delete(ref);
    for (const [kind, g] of this.groups) {
      for (const ref of g.refs) if (ref.startsWith(prefix)) g.refs.delete(ref);
      if (!g.refs.size) this.groups.delete(kind);
    }
  }

  /** Forgets entries nothing can still depend on, so a long-lived relay does not keep every chat handle it ever saw. */
  prune(/** @type {number} */ now) {
    for (const [ref, e] of this.byRef) if (now - e.at >= HOLD_MS) this.byRef.delete(ref);
    for (const [key, at] of this.sent) if (now - at >= REPEAT_MS) this.sent.delete(key);
    for (const [ref, c] of this.collapse) if (now - c.at >= COLLAPSE_MS) this.collapse.delete(ref);
    for (const [kind, g] of this.groups) if (now - g.at >= MERGE_MS) this.groups.delete(kind);
  }
}
