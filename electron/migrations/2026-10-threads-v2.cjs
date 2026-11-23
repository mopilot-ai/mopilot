// Chat state moves from ui-state.json (pinned, unread, worktreeOf, claudeArchived, claudeChats) and
// the old threads/<id>.json segment files into one threads/<id>.v2 per chat. Legacy files are
// read, never written: they stay frozen for older builds (the runtime mirrors into them).
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writeAtomic, readJson, readStateFile } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const {
  V2_EXT,
  SCHEMA_VERSION,
  STATE_VERSION,
  schemaVersionOf,
  v2File,
  emptyMeta,
  readLegacy,
  legacyRecord,
} = require('../platform/chatRecord.cjs');

const ID = '2026-10-threads-v2';

/** Fill only what `existing` leaves empty, so a rerun (or a run after a crash) gives the same file. */
function fillEmpty(existing, legacy) {
  if (!existing) return legacy;
  const meta = { ...emptyMeta(), ...(existing.meta || {}) };
  for (const k of Object.keys(legacy.meta)) if (existing.meta?.[k] === undefined || existing.meta?.[k] === null) meta[k] = legacy.meta[k];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: legacy.id,
    segments: Array.isArray(existing.segments) && existing.segments.length ? existing.segments : legacy.segments,
    meta,
    updatedAt: existing.updatedAt ?? legacy.updatedAt,
  };
}

function countLegacy(L) {
  const c = { chats: L.ids.length, pinned: 0, unread: 0, archived: 0, worktree: 0, accounts: 0, accountsPinned: 0, multiSegment: 0 };
  for (const id of L.ids) {
    if (L.pinned[id]) c.pinned++;
    if (L.unread[id]) c.unread++;
    if (typeof L.claudeArchived[id] === 'number') c.archived++;
    if (typeof L.worktreeOf[id] === 'string' && L.worktreeOf[id]) c.worktree++;
    const a = L.claudeChats[id];
    if (a && typeof a.id === 'string') {
      c.accounts++;
      if (a.pinned) c.accountsPinned++;
    }
    if (Array.isArray(L.segments[id]) && L.segments[id].length > 1) c.multiSegment++;
  }
  return c;
}

function countV2(records) {
  const c = { chats: records.length, pinned: 0, unread: 0, archived: 0, worktree: 0, accounts: 0, accountsPinned: 0, multiSegment: 0 };
  for (const r of records) {
    const m = r.meta || {};
    if (m.pinned) c.pinned++;
    if (m.unread) c.unread++;
    if (typeof m.archived === 'number') c.archived++;
    if (m.worktreeOf) c.worktree++;
    if (m.account) {
      c.accounts++;
      if (m.account.pinned) c.accountsPinned++;
    }
    if ((r.segments || []).length > 1) c.multiSegment++;
  }
  return c;
}

/** Step 8 preserves saved choices. Recorded media never establishes consent to choose a cloud recognizer. */
function migratePrefs(userData, opts = {}) {
  const file = path.join(userData, 'ui-state.json');
  const ui = readStateFile(file, 'the app state (ui-state.json)', isJsonRecord) ?? {};
  const prefs = ui.prefs && typeof ui.prefs === 'object' && !Array.isArray(ui.prefs) ? ui.prefs : {};
  return { dictationEngine: prefs.dictationEngine ?? null };
}

/**
 * Write a v2 file for every chat the legacy data knows about. `crashAfter` (tests) throws after
 * that many files, as if the process died there. Returns { ok, before, after, failed, written }.
 */
function run({ userData, now = Date.now(), crashAfter = Infinity }) {
  const dir = path.join(userData, 'threads');
  const L = readLegacy(userData, { strict: true });
  const before = countLegacy(L);
  const failed = [];
  let written = 0;
  for (const id of L.ids) {
    try {
      const file = v2File(dir, id);
      const existing = readJson(file);
      // A present unreadable/non-record file is not a missing file we may create over.
      if (existing !== null || fs.lstatSync(file, { throwIfNoEntry: false })) {
        const version = schemaVersionOf(existing);
        if (existing?.id !== id || version === null) {
          failed.push(id);
          continue;
        }
        if (version > SCHEMA_VERSION) continue; // a newer build owns it
      }
      const next = fillEmpty(existing, legacyRecord(L, id, now));
      const text = JSON.stringify(next, null, 2);
      if (existing && JSON.stringify(existing, null, 2) === text) continue;
      if (written >= crashAfter) throw Object.assign(new Error('simulated crash'), { crash: true });
      writeAtomic(file, text);
      written++;
    } catch (e) {
      if (e.crash) throw e;
      failed.push(id);
    }
  }
  const after = countV2(
    L.ids
      .map((id) => {
        try {
          const r = readJson(v2File(dir, id));
          return r?.id === id ? r : null;
        } catch (error) {
          noteIgnored('read a migrated chat identity', error);
          return null;
        }
      })
      .filter(Boolean),
  );
  const ok = failed.length === 0 && JSON.stringify(before) === JSON.stringify(after);
  return { ok, before, after, failed, written };
}

/** Undo a failed run: only files this schema owns go; legacy and foreign/newer files stay. */
function rollback({ userData }) {
  const dir = path.join(userData, 'threads');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(V2_EXT)) continue;
      const r = readJson(path.join(dir, f));
      const version = schemaVersionOf(r);
      if (!r || typeof r.id !== 'string' || version === null || version > SCHEMA_VERSION) continue;
      try {
        if (v2File(dir, r.id) !== path.join(dir, f)) continue;
      } catch (error) {
        noteIgnored('read a rollback chat identity', error);
        continue;
      }
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch (error) {
    // nothing to roll back when the threads folder is missing (ENOENT); a v2 file left behind is read only
    // once a run finishes, and the next run fills it again
    noteIgnored('remove the chat files of a failed migration', error, ['ENOENT']);
  }
}

// STATE_VERSION: the ui-state version this migration writes, which electron/migrations/migrate.cjs reads (a newer one is left alone)
module.exports = { id: ID, ID, STATE_VERSION, run, rollback, migratePrefs };
