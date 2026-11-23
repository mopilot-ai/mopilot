// The chat file format: one threads/<id>.v2 per chat (the record, its segments and meta), and the frozen legacy files
// (ui-state.json and threads/<id>.json) it is read from until the 2026-10-threads-v2 migration has run. Legacy files are
// read, never written here. The chat store (chats.cjs) and the migration (electron/migrations) both use it.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonRecord } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { ownTable } = require('../../shared/ownTable.mjs');

/**
 * A chat's v2 file is threads/<id>.v2. It must not end in .json: 0.2.0 reads every *.json there that has a
 * segments array (readSegments) and would take these files' bare native ids for its own segments.
 */
const V2_EXT = '.v2';
const SCHEMA_VERSION = 2;
const STATE_VERSION = 2;

/** A declared chat schema is a positive safe integer; coercion cannot establish file ownership. */
function schemaVersionOf(record) {
  const version = record?.schemaVersion;
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

const v2File = (dir, id) => path.join(dir, encodeURIComponent(id) + V2_EXT);

/**
 * The first segment of a chat that never switched, from its id alone. This is the one place the
 * old rule lives ('claude:' means Claude Code, anything else is Codex); everything else reads the
 * segment records. The runtime calls it only to create a v2 file lazily for such a chat.
 */
function legacyFirstSegment(id) {
  const claude = id.startsWith('claude:');
  return segment({ kind: claude ? 'claude' : 'codex', nativeId: claude ? id.slice('claude:'.length) : id });
}

/** A v2 segment with every field present. */
function segment(s) {
  return {
    kind: s.kind,
    nativeId: s.nativeId,
    instance: s.instance ?? null,
    provider: s.provider ?? null,
    model: s.model ?? null,
    handoff: s.handoff ?? null,
    start: s.start ?? 0,
    count: s.count ?? null,
  };
}

/** An old-format segment ({harness, nativeId: 'claude:<id>' | <codex id>, ...}) as a v2 one. */
function fromLegacySegment(s) {
  if (!s || typeof s.nativeId !== 'string') throw new Error('Invalid legacy chat segment');
  const kind = s.harness === 'claude' ? 'claude' : 'codex';
  const nativeId = kind === 'claude' && s.nativeId.startsWith('claude:') ? s.nativeId.slice('claude:'.length) : s.nativeId;
  if (!nativeId) throw new Error('Invalid legacy chat segment');
  return segment({ ...s, kind, nativeId });
}

/**
 * @returns {{ archived: number | null, pinned: boolean, unread: boolean, projectId: string | null, worktreeOf: string | null,
 *             account: { id: string, pinned: boolean } | null, config: object | null, continueModel: {owner: string, model: string | null} | null, goalHeld: unknown, notes: unknown[],
 *             computerGrants: unknown[], navigationBookmarks: unknown[], forkOf: string | null, controllerPlan: object | null, activeAt: number | null,
 *             momo: string | null, routineId: string | null, topicId: string | null, authored: Record<string, object> | null, momoModel: string | null,
 *             momoEffort: string | null, initialTitle: string | null, nativeSideFork?: string }}
 */
function emptyMeta() {
  return {
    archived: null,
    pinned: false,
    unread: false,
    projectId: null,
    /** A linked session's supplied task title, visible before its first message or generated native title. */
    initialTitle: null,
    worktreeOf: null,
    account: null,
    config: null,
    /** The model captured before a returning host handoff starts; its owner includes the segment and handoff identity. */
    continueModel: null,
    goalHeld: null,
    notes: [],
    computerGrants: [],
    navigationBookmarks: [],
    /** the chat a fork was made from (#1941): Codex lists a fork only once it has a message of its own */
    forkOf: null,
    /** who controls each surface on the chat's current segment (electron/session/controllerPlan.cjs) */
    controllerPlan: null,
    /** when the chat was last restored from the archive: automatic archiving counts it as use (electron/session/autoArchive.cjs) */
    activeAt: null,
    /** MoMo's own chat ('main', or 'previous' once a brain change replaced it): main sets it, and no list of chats shows it (shared/momoChat.mjs) */
    momo: null,
    /** a MoMo background chat's routine (meta.momo 'routine', the run's task id) or topic ('topic'): main sets them with the tag */
    routineId: null,
    topicId: null,
    /** the Claude Code model a MoMo chat's brain names (#2304): main sets it, and every Claude turn of the chat runs on it */
    momoModel: null,
    /** the effort pinned with that model (electron/momo/brainModel.cjs): null is the model's default */
    momoEffort: null,
    /** how windows show each input main sent no human wrote, by its client id (electron/session/authoredInput.cjs) */
    authored: null,
  };
}

function emptyRecord(id, segments, now) {
  return { schemaVersion: SCHEMA_VERSION, id, segments, meta: emptyMeta(), updatedAt: now };
}

/**
 * What ui-state.json and the old segment files say about each chat. `strict` (a run): a threads folder that
 * exists but can't be listed throws, so the run stops before writing and is tried again at the next start
 * instead of being recorded as done with the chats' segments missing. The fallback reads what it can.
 */
/** The canonical legacy filename's owner, independent of an untrusted record body. */
function legacyFileOwner(name) {
  try {
    const id = decodeURIComponent(name.slice(0, -5));
    return encodeURIComponent(id) + '.json' === name ? id : null;
  } catch {
    return null;
  }
}

function readLegacy(userData, { strict = false } = {}) {
  const ui = readJsonRecord(path.join(userData, 'ui-state.json'), {});
  const dir = path.join(userData, 'threads');
  const files = ownTable({});
  const unreadable = new Set();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // no threads folder yet (ENOENT): nothing to migrate
    if (strict && /** @type {any} */ (error)?.code !== 'ENOENT') throw error;
    noteIgnored('list the old chat files', error, ['ENOENT']);
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const owner = legacyFileOwner(f);
    if (owner === null) continue;
    const d = readLegacyFile(path.join(dir, f), strict, () => unreadable.add(owner));
    if (!d) continue;
    if (typeof d.id !== 'string' || d.id !== owner) {
      unreadable.add(owner);
      continue;
    }
    if (Array.isArray(d.segments) && d.segments.length) files[owner] = d.segments;
  }
  const map = (k) => ownTable(ui[k] && typeof ui[k] === 'object' && !Array.isArray(ui[k]) ? ui[k] : {});
  const pinned = map('pinned');
  const unread = map('unread');
  const worktreeOf = map('worktreeOf');
  const claudeArchived = map('claudeArchived');
  const claudeChats = map('claudeChats');
  // older builds kept segments in ui-state; the files win
  const segments = ownTable({ ...map('segments'), ...files });
  // Failed file owners must also keep migration in fallback, even without UI metadata.
  const ids = new Set(unreadable);
  for (const [id, v] of Object.entries(pinned)) if (v) ids.add(id);
  for (const [id, v] of Object.entries(unread)) if (v) ids.add(id);
  for (const [id, v] of Object.entries(worktreeOf)) if (typeof v === 'string' && v) ids.add(id);
  for (const [id, v] of Object.entries(claudeArchived)) if (typeof v === 'number') ids.add(id);
  for (const [id, v] of Object.entries(claudeChats)) if (v && typeof v.id === 'string') ids.add(id);
  for (const [id, v] of Object.entries(segments)) if (Array.isArray(v) && v.length) ids.add(id);
  return { ui, ids: [...ids].sort(), pinned, unread, worktreeOf, claudeArchived, claudeChats, segments, unreadable };
}

/**
 * One old segment file. A file that is not JSON (an older build's torn write) is skipped; one that can't be read
 * (EACCES, EIO) stops a run (`strict`) like an unlistable folder, so its chat is not recorded without its segments.
 */
function readLegacyFile(file, strict, onUnreadable) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const unreadable = !(error instanceof SyntaxError) && /** @type {any} */ (error)?.code !== 'ENOENT';
    if (strict && unreadable) throw error;
    if (unreadable) onUnreadable();
    // removed meanwhile (ENOENT): nothing to read
    noteIgnored('read an old chat file', error, ['ENOENT']);
    return null;
  }
}

/** The v2 record the legacy data describes for one chat. */
function legacyRecord(L, id, now) {
  // Read-only fallback records must still fit their canonical file identity.
  v2File('', id);
  if (L.unreadable.has(id)) throw new Error('Legacy chat file is unreadable or has an invalid owner');
  const segs = Array.isArray(L.segments[id]) && L.segments[id].length ? L.segments[id].map(fromLegacySegment) : [legacyFirstSegment(id)];
  const r = emptyRecord(id, segs, now);
  r.meta.pinned = !!L.pinned[id];
  r.meta.unread = !!L.unread[id];
  if (typeof L.worktreeOf[id] === 'string' && L.worktreeOf[id]) r.meta.worktreeOf = L.worktreeOf[id];
  if (typeof L.claudeArchived[id] === 'number') r.meta.archived = L.claudeArchived[id];
  const acct = L.claudeChats[id];
  if (acct && typeof acct.id === 'string') r.meta.account = { id: acct.id, pinned: !!acct.pinned };
  return r;
}

/** The records a run would write, without writing them (the runtime's fallback until a run finishes). */
function legacyRecords(userData, now = Date.now(), onInvalid) {
  const L = readLegacy(userData);
  for (const id of L.unreadable) onInvalid?.(id);
  return L.ids.flatMap((id) => {
    if (L.unreadable.has(id)) return [];
    try {
      return [legacyRecord(L, id, now)];
    } catch (error) {
      noteIgnored(`read the damaged legacy chat ${id}`, error);
      onInvalid?.(id);
      return [];
    }
  });
}

module.exports = {
  V2_EXT,
  SCHEMA_VERSION,
  STATE_VERSION,
  schemaVersionOf,
  v2File,
  legacyFirstSegment,
  fromLegacySegment,
  segment,
  emptyMeta,
  emptyRecord,
  readLegacy,
  legacyRecord,
  legacyRecords,
};
