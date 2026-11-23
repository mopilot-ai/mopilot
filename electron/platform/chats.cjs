// Per-chat state, owned by the main process: threads/<id>.v2 holds a chat's segments and its @host-portable: loads in the Host process without Electron (host/boundary.json).
// meta (archived, pinned, unread, worktree, account, ...). Windows read a snapshot and send patches;
// every write is atomic and goes to one chat's file. ui-state.json's prefs are merged per key here
// too, so two windows never overwrite each other's changes (#39).
const { registerShortcutPrefs } = require('./shortcutPrefs.cjs');
const { registerPrefs } = require('./prefsIpc.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic, writeAtomicAsync, readStateFile } = require('./fsutil.cjs');
const { WriteBehind, REMOVE } = require('./writeBehind.cjs');
const { writeDurable } = require('./durableFile.cjs');
const { createUiStateFiles } = require('./uiStateFile.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { setRecordValue } = require('../../shared/recordProperties.mjs');
const { ItemsLog } = require('./itemsLog.cjs');
const { readRecordFiles, writeRecordFile } = require('./recordFiles.cjs');
const { windowPatch } = require('./windowMetaPatch.cjs');
const v2 = require('./chatRecord.cjs');
const { switchedOwner } = require('../../shared/segmentAlias.mjs');
const { segmentKey } = require('./segmentOwner.cjs');
const { labeled } = require('../perf/stalls.cjs');
const { defaultHarnessPatch } = require('../../shared/defaultHarness.mjs');
const { observe } = require('../../shared/observations.cjs');

const SCHEMA_VERSION = v2.SCHEMA_VERSION;
const STATE_VERSION = v2.STATE_VERSION;
const META_KEYS = Object.keys(v2.emptyMeta());
/** Kinds older builds understand; a chat with any other segment is never mirrored back. */
const LEGACY_KINDS = new Set(['codex', 'claude']);
/** ui-state.json keys only main writes: prefs, and the frozen legacy keys it mirrors. */
const OWNED_KEYS = ['prefs', 'pinned', 'unread', 'worktreeOf', 'claudeArchived', 'claudeChats', 'segments', 'stateVersion'];

/* ------------------------------------------------------------------ */
/* segments as the renderer sees them                                  */
/* ------------------------------------------------------------------ */
/** The renderer names a native session '<kind>:<id>' except for Codex, whose ids are bare (the key tool calls name too). */
const rendererNative = segmentKey;

function toRendererSegment(s) {
  return {
    harness: s.kind,
    nativeId: rendererNative(s.kind, s.nativeId),
    start: s.start ?? 0,
    count: s.count ?? null,
    model: s.model ?? null,
    handoff: s.handoff ?? null,
  };
}
function fromRendererSegment(s) {
  const kind = String(s.harness);
  const prefix = `${kind}:`;
  const nativeId = kind !== 'codex' && String(s.nativeId).startsWith(prefix) ? String(s.nativeId).slice(prefix.length) : String(s.nativeId);
  return v2.segment({ ...s, kind, nativeId });
}

/** A chat as the renderer gets it: segments only when it spans several native sessions. */
/** A chat's own first segment, from its id: 'acp:<harness>:<id>', 'claude:<id>' or a bare Codex id. */
function firstSegment(id) {
  const acp = /^acp:([^:]+):(.+)$/.exec(id);
  return acp ? v2.segment({ kind: `acp:${acp[1]}`, nativeId: acp[2] }) : v2.legacyFirstSegment(id);
}

function view(rec) {
  return { segments: rec.segments.length > 1 ? rec.segments.map(toRendererSegment) : null, kind: rec.segments[0].kind, meta: rec.meta };
}

/* ------------------------------------------------------------------ */
/* ui-state.json (held in memory, written behind: uiStateFile.cjs)      */
/* ------------------------------------------------------------------ */
/** Told once when a file keeps failing to save (set by main: a notice the user sees). */
let saveFailed = (/** @type {string} */ _file, /** @type {unknown} */ _error) => {
  /* nobody to tell yet */
};
const setSaveFailureNotice = (/** @type {typeof saveFailed} */ fn) => {
  saveFailed = fn;
};
/** The derived state (ui-state.json, the legacy mirror) is written behind this, and at exit whichever way the process ends. */
const writer = new WriteBehind({
  writeAsync: writeAtomicAsync,
  writeSync: writeAtomic,
  remove: (file) => fs.rmSync(file, { force: true }),
  fs,
  note: noteIgnored,
  failed: (file, error) => {
    console.error(`could not save ${file}`, error);
    saveFailed(file, error);
  },
  onFirstWrite: () => process.once('exit', () => writer.flushSync()),
});
const { readUiState, peekUiState, inspectUiState, touchUiState, updateUiState, prepareUiState, dropUiState } = createUiStateFiles({
  writer,
  readStateFile,
});
const flushPendingWrites = () => writer.flushSync();
const uiStateNewer = (s) => typeof s.stateVersion === 'number' && s.stateVersion > STATE_VERSION;

/** Merge a prefs delta into ui-state.json: `set` keys are replaced, `unset` keys removed. */
function patchPrefs(file, set = {}, unset = []) {
  if (uiStateNewer(readUiState(file))) return null;
  return updateUiState(file, (s) => {
    if (uiStateNewer(s)) throw new Error('Cannot save preferences from a newer app version');
    const prefs = { ...(isJsonRecord(s.prefs) ? s.prefs : {}), ...(isJsonRecord(set) ? set : {}) };
    for (const k of unset) delete prefs[k];
    return { ...s, prefs };
  }).prefs;
}

/** Persist a consent change before acknowledging it, fencing any older in-flight write. */
function patchPrefsSync(file, set = {}, unset = []) {
  const prefs = patchPrefs(file, set, unset);
  if (!prefs || !writer.flushFile(file, writeDurable)) throw new Error('Could not save Mobile Remote consent');
  return prefs;
}

/**
 * Move the default harness for new chats from the two prefs it used to be (shared/defaultHarness.mjs) to `defaultHarness`,
 * before any window reads them. Returns the prefs written, or null when there was nothing to move.
 */
function migrateDefaultHarness(file) {
  const d = defaultHarnessPatch(readUiState(file).prefs);
  return d ? patchPrefs(file, d.set, d.unset) : null;
}

/**
 * Whether the welcome page was finished (#2034), settled once before any window reads the prefs, so windows that boot
 * together agree: an install a window already saved its own state in (any key main doesn't own) was set up before the
 * page kept the mark; a new one is welcomed until Continue. Returns the prefs written, or null when already settled.
 */
function settleWelcome(file) {
  const s = readUiState(file);
  if (isJsonRecord(s.prefs) && 'welcomeDone' in s.prefs) return null;
  return patchPrefs(file, { welcomeDone: Object.keys(s).some((k) => !OWNED_KEYS.includes(k)) }, []);
}

/** The window's own keys (sidebar, projects, caches); the keys main owns are left as they are. */
function writeRendererState(file, s) {
  if (!isJsonRecord(s) || uiStateNewer(readUiState(file))) return;
  const own = { ...s };
  for (const k of OWNED_KEYS) delete own[k];
  updateUiState(file, (cur) => ({ ...cur, ...own }));
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Each chat's segments as [chat id, their native ids in the window's form], for the shared alias rule
 * (shared/segmentAlias.mjs).
 * @param {Map<string, { segments: any[] }>} records
 * @returns {Generator<[string, string[]]>}
 */
function* nativeIdsOf(records) {
  for (const [id, rec] of records) yield [id, rec.segments.map((s) => toRendererSegment(s).nativeId)];
}

/** The canonical filename's chat owner, or null when decoding does not round-trip. */
function idOfFile(f) {
  try {
    const id = decodeURIComponent(f.slice(0, -v2.V2_EXT.length));
    return id && encodeURIComponent(id) + v2.V2_EXT === f ? id : null;
  } catch {
    return null;
  }
}

class ChatsStore {
  /**
   * @param dir userData/threads
   * @param {object} [opts]
   * @param [opts.uiState] ui-state.json, where the legacy keys are mirrored
   * @param [opts.legacyMirror] keep writing the frozen legacy keys and segment files for older builds (boolean, or a function asked on every write)
   * @param [opts.onChange] (id, view) after each change
   * @param [opts.fallback] the migration hasn't finished: serve what the legacy files say and keep
   *   writing only those, so nothing is lost and a later run still sees the whole picture
   * @param [opts.now] () => ms
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.uiState = opts.uiState ?? null;
    this.legacyMirrorOpt = opts.legacyMirror ?? true;
    this.onChange =
      opts.onChange ??
      (() => {
        /* no listener */
      });
    this.fallback = !!opts.fallback;
    this.now = opts.now ?? (() => Date.now());
    this.records = new Map();
    /** Process-local ownership generation: archive/restore can cycle while a read is awaiting, even at one clock tick. */
    this.archiveEpochs = new Map();
    this.isDeleted = (_id) => false;
    this.admitCommit = (_record) => true;
    /** chats a newer build wrote: shown, never written */
    this.newer = new Set();
    /** legacy chats that failed conversion: keep their original files untouched */
    this.unreadable = new Set();
    /** Whether the last load could not list the folder. */
    this.unlisted = false;
    this.load();
  }
  /** Keep writing the frozen legacy keys: a boolean, or a function so the remote switch applies as it changes. */
  get legacyMirror() {
    const o = this.legacyMirrorOpt;
    return typeof o === 'function' ? o() !== false : o !== false;
  }
  file(id) {
    return path.join(this.dir, encodeURIComponent(id) + v2.V2_EXT);
  }
  legacyFile(id) {
    return path.join(this.dir, encodeURIComponent(id) + '.json');
  }
  load() {
    // A shadow migration receiver must never advance a map still shared with the admitted live snapshot.
    this.archiveEpochs = new Map(
      [...new Set([...this.archiveEpochs.keys(), ...this.records.keys()])].map((id) => [id, this.archiveEpoch(id) + 1]),
    );
    // the derived files (the legacy mirror) are on the disk before they are read
    writer.flushSync();
    this.records.clear();
    this.newer.clear();
    this.unreadable.clear();
    if (this.fallback) {
      for (const r of v2.legacyRecords(path.dirname(this.dir), this.now(), (id) => this.unreadable.add(id))) this.records.set(r.id, r);
      return;
    }
    const read = readRecordFiles(this.dir, v2.V2_EXT);
    // no chats folder yet (ENOENT): start empty
    if (read.error) noteIgnored('list the saved chats', read.error, ['ENOENT']);
    this.unlisted = Boolean(read.error) && /** @type {any} */ (read.error).code !== 'ENOENT';
    for (const { name: f, record: r } of read.entries ?? []) {
      // a chat file that can't be read (bad JSON, an I/O error) is kept as it is: opening the chat, or a pin, would
      // otherwise write an empty record over it, with its later segments and its settings
      if (!r || typeof r.id !== 'string') {
        const id = idOfFile(f);
        if (id) this.unreadable.add(id);
        noteIgnored('load a saved chat', new Error(`${f} can't be read`));
        continue;
      }
      try {
        if (path.basename(this.file(r.id)) !== f) throw new Error('Chat id does not match its file');
      } catch (error) {
        // Preserve the damaged file, but do not let it replace or freeze another chat.
        noteIgnored('load a chat with an invalid file owner', error);
        const owner = idOfFile(f);
        if (owner) this.unreadable.add(owner);
        continue;
      }
      const version = v2.schemaVersionOf(r);
      if (version === null) {
        this.unreadable.add(r.id);
        noteIgnored('load a saved chat schema', new Error(`${f} has no supported schema declaration`));
        continue;
      }
      if (version > SCHEMA_VERSION) this.newer.add(r.id);
      // A view needs a first native session; preserve a future file's write lock even when it has none.
      if (
        !Array.isArray(r.segments) ||
        !r.segments.length ||
        !r.segments.every((s) => s && typeof s.kind === 'string' && typeof s.nativeId === 'string')
      ) {
        this.unreadable.add(r.id);
        continue;
      }
      this.records.set(r.id, { ...r, meta: { ...v2.emptyMeta(), ...(r.meta || {}) } });
    }
  }
  snapshot() {
    const chats = {};
    for (const [id, r] of this.records) setRecordValue(chats, id, view(r));
    return { chats, newer: [...this.newer] };
  }
  get(id) {
    const r = this.records.get(id);
    return r ? view(r) : null;
  }
  /** The chat's record, created lazily for a chat that has none yet. */
  record(id) {
    return this.records.get(id) ?? v2.emptyRecord(id, [firstSegment(id)], this.now());
  }
  /** Whether a chat's record names this native session (window form): as its own first segment, or a switch's later one. */
  names(nativeId) {
    if (this.records.has(nativeId)) return true;
    for (const [, ids] of nativeIdsOf(this.records)) if (ids.includes(nativeId)) return true;
    return false;
  }
  /** Whether the chat has a file of its own: a temporary chat's record lives only in memory, and a new one has none yet. */
  saved(id) {
    return fs.existsSync(this.file(id));
  }
  /** Persist an empty record for a chat that has none yet (a new chat no meta key has touched); true when it now has one. */
  ensure(id) {
    if (typeof id !== 'string' || !id || id.length > 256) return false;
    if (this.isDeleted(id)) return false;
    if (this.records.has(id)) return true;
    return this.commit(this.record(id));
  }
  commit(rec) {
    if (!this.admitCommit(rec)) return false;
    if (this.newer.has(rec.id) || this.unreadable.has(rec.id)) return false;
    // the folder couldn't be listed, so a chat on the disk may be missing here: this record would write over it
    if (this.unlisted && !this.records.has(rec.id) && fs.existsSync(this.file(rec.id))) return false;
    // a switch's native session is a segment of the chat that switched: it never becomes a chat of its own (a window
    // asking for its session, its turn marking it unread, its controller plan), which would take its events from that chat
    if (!this.records.has(rec.id) && switchedOwner(nativeIdsOf(this.records), rec.id) !== null) return false;
    const next = { ...rec, schemaVersion: SCHEMA_VERSION, updatedAt: this.now() };
    const wasArchived = this.records.get(rec.id)?.meta?.archived ?? null;
    const created = !this.records.has(rec.id);
    // the record is on the disk before this returns (archive, owner switches and permissions act on the answer): the core
    // writes it whole, synchronously (store.writeRecord); compact, not pretty-printed, and a failure throws to the caller
    if (!this.fallback) labeled('chats.commit', () => writeRecordFile(this.file(rec.id), JSON.stringify(next)));
    this.records.set(rec.id, next);
    if (wasArchived !== (next.meta?.archived ?? null)) this.archiveEpochs.set(rec.id, this.archiveEpoch(rec.id) + 1);
    if (this.legacyMirror || this.fallback) this.mirror(next);
    this.onChange(rec.id, view(next));
    if (created) observe({ kind: 'chat', action: 'created' });
    else if (!!wasArchived !== !!next.meta?.archived) observe({ kind: 'chat', action: next.meta?.archived ? 'archived' : 'restored' });
    return true;
  }
  /** Write every derived change still waiting (quit, and before something else reads or replaces the files). */
  flush() {
    writer.flushSync();
  }
  /** Forget the ui-state.json held in memory, after writing it: something else replaced it (a migration retry or restore). */
  releaseUiState() {
    if (this.uiState) dropUiState(this.uiState);
  }
  /** Never persisted: asynchronous effects cannot outlive this process, but a successful archive transition retires them. */
  archiveEpoch(id) {
    return this.archiveEpochs.get(id) ?? 0;
  }
  /** Merge meta keys into a chat; unknown keys are ignored, null clears. Returns whether it changed. */
  patchMeta(id, patch) {
    if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') return false;
    const rec = this.record(id);
    const meta = { ...rec.meta };
    let changed = false;
    for (const k of META_KEYS) {
      if (!(k in patch)) continue;
      const v = patch[k] === undefined ? null : patch[k];
      if (JSON.stringify(meta[k]) === JSON.stringify(v)) continue;
      meta[k] = v;
      changed = true;
    }
    // a chat restored from the archive was just used: automatic archiving counts from now (electron/session/autoArchive.cjs)
    if (changed && typeof rec.meta?.archived === 'number' && meta.archived === null) meta.activeAt = this.now();
    return changed ? this.commit({ ...rec, meta }) : false;
  }
  /** Replace a chat's segments (renderer form); null leaves only the chat's own first segment. */
  setSegments(id, segments) {
    if (typeof id !== 'string' || !id) return false;
    const rec = this.record(id);
    const next = Array.isArray(segments) && segments.length ? segments.map(fromRendererSegment) : rec.segments.slice(0, 1);
    if (JSON.stringify(next) === JSON.stringify(rec.segments) && this.records.has(id)) return false;
    if (!this.records.has(id) && next.length < 2) return false;
    return this.commit({ ...rec, segments: next });
  }

  /**
   * A deleted chat's files leave the disk (Reset MoMo, #2291): its record stays in memory, so this process's deletion
   * fence and aliases hold until it quits, and no record of it is read again after. Refused unless the chat is deleted.
   */
  forgetDeleted(id) {
    if (typeof id !== 'string' || !id || !this.isDeleted(id)) return false;
    // a mirror change not yet written must not bring the file back
    writer.cancel(this.legacyFile(id));
    fs.rmSync(this.file(id), { force: true });
    fs.rmSync(this.legacyFile(id), { force: true });
    return true;
  }

  /* -- legacy mirror: write-only and written behind with everything else, for builds that read ui-state.json and threads/<id>.json -- */
  mirror(rec) {
    const legacy = rec.segments.every((s) => LEGACY_KINDS.has(s.kind));
    writer.set(this.legacyFile(rec.id), () =>
      legacy && rec.segments.length > 1 ? JSON.stringify({ id: rec.id, segments: rec.segments.map(toRendererSegment) }) : REMOVE,
    );
    try {
      if (!this.uiState || uiStateNewer(readUiState(this.uiState))) return;
      // the keys are made from every record when the file is written, not once per change
      prepareUiState(this.uiState, this, (s) =>
        uiStateNewer(s) || !(this.legacyMirror || this.fallback) ? s : { ...s, ...this.legacyKeys(s) },
      );
      touchUiState(this.uiState);
      // in fallback the legacy files are the only copy of the chats: they are on the disk before this returns
      if (this.fallback) writer.flushSync();
    } catch (error) {
      // the legacy ui-state mirror is only for older builds
      noteIgnored('mirror the chat list for older builds', error);
    }
  }
  /** The frozen ui-state keys as 0.2.0 reads them, from every chat it can show. */
  legacyKeys(previous) {
    const out = { pinned: {}, unread: {}, worktreeOf: {}, claudeArchived: {}, claudeChats: {} };
    // A healthy fallback write cannot erase the unreadable chats' original metadata.
    for (const id of this.unreadable)
      for (const key of Object.keys(out)) if (Object.hasOwn(previous[key] ?? {}, id)) setRecordValue(out[key], id, previous[key][id]);
    for (const [id, r] of [...this.records].sort(([a], [b]) => (a < b ? -1 : 1)) /* ids are unique: never equal */) {
      // a deleted chat's pin, account and the rest are not written back for older builds (forgetDeleted)
      if (!r.segments.every((s) => LEGACY_KINDS.has(s.kind)) || this.isDeleted(id)) continue;
      const m = r.meta;
      if (m.pinned) setRecordValue(out.pinned, id, true);
      if (m.unread) setRecordValue(out.unread, id, true);
      if (m.worktreeOf) setRecordValue(out.worktreeOf, id, m.worktreeOf);
      if (typeof m.archived === 'number') setRecordValue(out.claudeArchived, id, m.archived);
      if (m.account) setRecordValue(out.claudeChats, id, m.account);
    }
    return out;
  }
}

/**
 * IPC for the renderer; a change is pushed to the other windows as chats:changed / prefs:changed. Returns the same prefs
 * change for main itself (Chrome's side panel), which every window hears.
 * @param ipcMain
 * @param {{ store: any, uiState: string, broadcast: (channel: string, sender: any, payload?: any) => void, onPrefs?: (prefs: any) => void, runOnName?: (id: string) => string | undefined }} o
 */
function registerChats(
  ipcMain,
  {
    store,
    uiState,
    broadcast,
    runOnName,
    onPrefs = () => {
      /* no prefs listener */
    },
  },
) {
  registerShortcutPrefs(ipcMain, { file: uiState, broadcast, onPrefs, ui: { inspect: inspectUiState, update: updateUiState } });
  ipcMain.handle('chats:snapshot', () => store.snapshot());
  ipcMain.handle('chats:patchMeta', (e, id, patch) => {
    if (store.isDeleted(id)) throw new Error('Chat was deleted');
    // patchMeta-changes: the answer goes back to the window as 'changed', not as an error
    const ok = store.patchMeta(id, windowPatch(patch, store.get(id)?.meta));
    // the sender too (null excludes no window): it hears the chat as main merged it, and a change it made meanwhile
    // lands in a later send, so no window is left on an older copy (#2520)
    if (ok) broadcast('chats:changed', null, { id, chat: store.get(id) });
    return ok;
  });
  ipcMain.handle('chats:setSegments', (e, id, segments) => {
    if (store.isDeleted(id)) throw new Error('Chat was deleted');
    const ok = store.setSegments(id, segments);
    if (ok) broadcast('chats:changed', null, { id, chat: store.get(id) });
    return ok;
  });
  return registerPrefs(ipcMain, {
    read: () => readUiState(uiState),
    write: (set, unset) => patchPrefs(uiState, set, unset),
    broadcast,
    onPrefs,
    runOnName,
  });
}

module.exports = {
  settleWelcome,
  ChatsStore,
  ItemsLog,
  firstSegment,
  registerChats,
  patchPrefs,
  patchPrefsSync,
  migrateDefaultHarness,
  writeRendererState,
  readUiState,
  peekUiState,
  inspectUiState,
  updateUiState,
  touchUiState,
  dropUiState,
  flushPendingWrites,
  setSaveFailureNotice,
  toRendererSegment,
  fromRendererSegment,
  nativeIdsOf,
  OWNED_KEYS,
  META_KEYS,
  SCHEMA_VERSION,
  STATE_VERSION,
};
