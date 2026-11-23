// Which apps computer use may control. "Allow in this chat" is kept in the chat's v2 meta
// (computerGrants); "Always allow" goes on the global list, with the user's own deny-list additions,
// in userData/capabilities/computer.json. "Allow once" is never stored. The same file keeps the
// "brief switching" setting and, per app, which rung of background control worked last.
const { writeAtomic } = require('../platform/fsutil.cjs');
const { readCheckedStore } = require('../platform/checkedStore.cjs');
const { displayNumber } = require('../platform/storedDisplay.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { ToolError } = require('./contract/registry.cjs');
const { LEVELS, rank } = require('./contract/policy.cjs');

/** @typedef {{ bundleId: string, name: string, level: string, at: number }} Grant */
/** @returns {Grant | null} */
const clean = (g) =>
  g && typeof g.bundleId === 'string' && g.bundleId && LEVELS.includes(g.level)
    ? {
        ...g,
        bundleId: g.bundleId,
        name: typeof g.name === 'string' && g.name ? g.name : g.bundleId,
        level: g.level,
        at: displayNumber(g.at),
      }
    : null;

/** The rungs background control escalates through; a remembered rung is where the next action starts. */
const RUNGS = ['background', 'foreground'];

/** Remembered rungs: lowercased bundle id -> { name, actions: { [action]: rung }, at }; junk dropped. */
function cleanRungs(r) {
  /** @type {Record<string, { name: string, actions: Record<string, string>, at: number }>} */
  const out = {};
  if (!r || typeof r !== 'object' || Array.isArray(r)) return out;
  for (const [k, v] of Object.entries(r)) {
    if (!k || !v || typeof v !== 'object' || !v.actions || typeof v.actions !== 'object') continue;
    const actions = Object.fromEntries(Object.entries(v.actions).filter(([, rung]) => RUNGS.includes(rung)));
    if (Object.keys(actions).length)
      Object.defineProperty(out, k.toLowerCase(), {
        value: { ...v, name: typeof v.name === 'string' && v.name ? v.name : k, actions, at: displayNumber(v.at) },
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return out;
}

/**
 * @param {Grant | null} g
 * @returns {g is Grant}
 */
const isGrant = (g) => g !== null;

/** A list with the app's grant set to `level` (raised, never lowered by a weaker grant); null removes it. */
function withGrant(list, app, level, at) {
  const id = app.bundleId.toLowerCase();
  const cur = (list || []).map(clean).filter(isGrant);
  const old = cur.find((g) => g.bundleId.toLowerCase() === id);
  const rest = cur.filter((g) => g !== old);
  if (level === null) return rest;
  const keep = old && rank(old.level) > rank(level) ? old.level : level;
  return [...rest, { ...old, bundleId: app.bundleId, name: app.name || app.bundleId, level: keep, at }];
}

const validLabels = (entry) =>
  (!Object.hasOwn(entry, 'name') || typeof entry.name === 'string') &&
  (!Object.hasOwn(entry, 'at') || (typeof entry.at === 'number' && Number.isFinite(entry.at)));
const validGrants = (list) =>
  Array.isArray(list) &&
  list.every(
    (g) =>
      isJsonRecord(g) &&
      typeof g.bundleId === 'string' &&
      !!g.bundleId &&
      typeof g.level === 'string' &&
      LEVELS.includes(g.level) &&
      validLabels(g),
  );
const validRungs = (value) => {
  if (!isJsonRecord(value)) return false;
  const keys = Object.keys(value).map((id) => id.toLowerCase());
  return (
    new Set(keys).size === keys.length &&
    Object.entries(value).every(
      ([id, v]) =>
        id &&
        isJsonRecord(v) &&
        isJsonRecord(v.actions) &&
        Object.keys(v.actions).length > 0 &&
        Object.values(v.actions).every((rung) => typeof rung === 'string' && RUNGS.includes(rung)) &&
        validLabels(v),
    )
  );
};
const validStore = (d) =>
  isJsonRecord(d) &&
  !Object.hasOwn(d, 'version') &&
  (!Object.hasOwn(d, 'global') || validGrants(d.global)) &&
  (!Object.hasOwn(d, 'deny') || (Array.isArray(d.deny) && d.deny.every((id) => typeof id === 'string' && id))) &&
  (!Object.hasOwn(d, 'briefForeground') || typeof d.briefForeground === 'boolean') &&
  (!Object.hasOwn(d, 'codexNativeComputer') || typeof d.codexNativeComputer === 'boolean') &&
  (!Object.hasOwn(d, 'rungs') || validRungs(d.rungs));

class GrantStore {
  /**
   * @param {{ file: string, chats: { get(id: string): any, patchMeta(id: string, patch: object): boolean },
   *           remote?: { get(id: string): { appGrants: any[] } | null } | null,
   *           onChange?: (chatId: string | null) => void, now?: () => number }} o
   *   remote: the remote owners (electron/computerAccess/owners.cjs): their grants live with them, never in the chat
   *   store, and they never get the global list
   */
  constructor(o) {
    this.file = o.file;
    this.chats = o.chats;
    this.remote = o.remote ?? null;
    this.onChange =
      o.onChange ||
      (() => {
        /* no change listener */
      });
    this.now = o.now || Date.now;
    this.#load();
  }
  #load(keepOnError = false) {
    const { data, error } = readCheckedStore(this.file, 'the saved computer permissions', validStore);
    this.writeError = error;
    if (error && keepOnError) return;
    const d = isJsonRecord(data) ? data : {};
    this.data = {
      ...d,
      global: (Array.isArray(d.global) ? d.global : []).map(clean).filter(isGrant),
      deny: (Array.isArray(d.deny) ? d.deny : []).filter((s) => typeof s === 'string' && s),
      briefForeground: d.briefForeground !== false,
      codexNativeComputer: d.codexNativeComputer === true,
      rungs: cleanRungs(d.rungs),
    };
  }
  #refresh() {
    if (this.writeError) this.#load(true);
  }
  #save(data) {
    if (this.writeError)
      throw new ToolError(
        "Couldn't read the saved computer permissions, so they weren't changed. Restore the file and reopen the app before editing it.",
        'save_failed',
      );
    try {
      writeAtomic(this.file, JSON.stringify(data, null, 2));
    } catch {
      throw new ToolError("Couldn't save computer permissions. Please try again.", 'save_failed');
    }
    this.data = data;
  }

  global() {
    return this.data.global.slice();
  }
  chat(chatId) {
    const owner = this.remote?.get(chatId);
    if (owner) return owner.appGrants.slice();
    const g = this.chats.get(chatId)?.meta?.computerGrants;
    return (Array.isArray(g) ? g : []).map(clean).filter(isGrant);
  }
  /** Keep a chat's unrecognized grants intact rather than writing a filtered display list back to its metadata. */
  #chatForChange(chatId) {
    const raw = this.chats.get(chatId)?.meta?.computerGrants;
    if (raw !== undefined && !validGrants(raw))
      throw new ToolError("Couldn't read this chat's saved computer permissions, so they weren't changed.", 'save_failed');
    return raw ?? [];
  }
  /** Every grant that applies in the chat. */
  forChat(chatId) {
    // a remote owner gets only what was granted to it: "Always allow" was given to this Mac's own chats
    if (this.remote?.get(chatId)) return this.chat(chatId);
    return [...this.chat(chatId), ...this.data.global];
  }
  /** The user's own deny-list additions (the built-in floor lives in the helper). */
  deny() {
    return this.data.deny.slice();
  }

  /** Keeps an answer: 'chat' in the chat's meta, 'always' on the global list; 'once' keeps nothing. */
  grant(chatId, app, level, scope) {
    if (!app?.bundleId || !LEVELS.includes(level)) return false;
    const owner = this.remote?.get(chatId);
    if (owner) {
      // any lasting answer for a remote owner lasts as long as the owner, never on the global list
      if (scope !== 'chat' && scope !== 'always') return false;
      owner.appGrants = withGrant(owner.appGrants, app, level, this.now());
      this.onChange(chatId);
      return true;
    }
    if (scope === 'always') {
      this.#refresh();
      this.#save({ ...this.data, global: withGrant(this.data.global, app, level, this.now()) });
      this.onChange(null);
      return true;
    }
    if (scope === 'chat' && chatId) {
      // patchMeta-changes: the grant carries a fresh timestamp, so it always changes
      const ok = this.chats.patchMeta(chatId, { computerGrants: withGrant(this.#chatForChange(chatId), app, level, this.now()) });
      if (ok) this.onChange(chatId);
      return ok;
    }
    return false;
  }

  /** Removes the app from one chat's list, or (chatId null) from the global list. */
  revoke(chatId, bundleId) {
    const app = { bundleId };
    const owner = chatId ? this.remote?.get(chatId) : null;
    if (owner) {
      const before = owner.appGrants.length;
      owner.appGrants = withGrant(owner.appGrants, app, null, 0);
      if (owner.appGrants.length === before) return false;
      this.onChange(chatId);
      return true;
    }
    if (!chatId) {
      this.#refresh();
      const before = this.data.global.length;
      const global = withGrant(this.data.global, app, null, 0);
      if (global.length === before) return false;
      this.#save({ ...this.data, global });
      this.onChange(null);
      return true;
    }
    // patchMeta-changes: false means there was no grant to remove, which the caller is told
    const ok = this.chats.patchMeta(chatId, { computerGrants: withGrant(this.#chatForChange(chatId), app, null, 0) });
    if (ok) this.onChange(chatId);
    return ok;
  }

  /** Settings' "Remove all": empties the global list. Chats keep what they were already granted. */
  clearGlobal() {
    this.#refresh();
    if (!this.data.global.length) return false;
    this.#save({ ...this.data, global: [] });
    this.onChange(null);
    return true;
  }

  /** Settings → Computer use: "Allow brief switching to the app when background control doesn't work" (default on). */
  briefForeground() {
    return this.data.briefForeground !== false;
  }
  setBriefForeground(on) {
    this.#refresh();
    this.#save({ ...this.data, briefForeground: !!on });
    this.onChange(null);
    return this.briefForeground();
  }

  /**
   * Settings → Computer use: Codex chats use Codex's own computer use (Codex Computer Use) instead of MoPilot's
   * (default off: MoPilot's helper passed more of the 12-grid tasks and acts about 4× faster, #1381).
   */
  codexNativeComputer() {
    return this.data.codexNativeComputer === true;
  }
  setCodexNativeComputer(on) {
    this.#refresh();
    this.#save({ ...this.data, codexNativeComputer: !!on });
    this.onChange(null);
    return this.codexNativeComputer();
  }

  /** The switches Settings → Computer use shows. */
  settings() {
    return { briefForeground: this.briefForeground(), codexNativeComputer: this.codexNativeComputer() };
  }

  /** The rung that worked last for an action in the app ('background' when nothing is remembered). */
  rung(bundleId, action) {
    const key = String(bundleId || '').toLowerCase();
    const actions = Object.hasOwn(this.data.rungs, key) ? this.data.rungs[key].actions : null;
    return actions && Object.hasOwn(actions, action) ? actions[action] : 'background';
  }
  /** Remembers the rung that worked; returns whether that changed anything. A failed save keeps it in memory only. */
  rememberRung(app, action, rung) {
    this.#refresh();
    if (!app?.bundleId || !RUNGS.includes(rung) || this.rung(app.bundleId, action) === rung) return false;
    const k = app.bundleId.toLowerCase();
    const cur = Object.hasOwn(this.data.rungs, k) ? this.data.rungs[k] : null;
    const actions = { ...cur?.actions, [action]: rung };
    const rungs = { ...this.data.rungs, [k]: { ...cur, name: app.name || app.bundleId, actions, at: this.now() } };
    try {
      this.#save({ ...this.data, rungs });
    } catch {
      this.data = { ...this.data, rungs };
    }
    return true;
  }

  setDeny(list) {
    this.#refresh();
    const deny = [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean))];
    this.#save({ ...this.data, deny });
    this.onChange(null);
    return this.deny();
  }
}

module.exports = { GrantStore, withGrant, cleanRungs, RUNGS };
