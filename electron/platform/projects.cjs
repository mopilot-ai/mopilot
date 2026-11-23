// The project list, owned by the main process: userData/projects.json. Works without Codex; when @host-portable: loads in the Host process without Electron (host/boundary.json).
// Codex is installed its project/* list is imported once and then synced one way (Codex -> here).
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeAtomic } = require('./fsutil.cjs');
const { readCheckedStore } = require('./checkedStore.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { basename, isWinPath, winPathKey } = require('../../shared/paths.mjs');
const { canonicalPaths, folderAvailability } = require('./projectPaths.cjs');
const { phoneProjects } = require('./headBranch.cjs');

const SCHEMA_VERSION = 2;
const supportedSchema = (version) => version === 1 || version === SCHEMA_VERSION;
const isProjectId = (id) => typeof id === 'string' && id.length > 0;

const PROJECT_FIELDS = {
  id: isProjectId,
  name: (value) => typeof value === 'string',
  path: (value) => typeof value === 'string' && !!value,
  source: (value) => value === 'sage' || value === 'codex',
  codexId: isProjectId,
};
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const validFailure = (value) =>
  value === null ||
  (isJsonRecord(value) &&
    Object.keys(value).every((key) => ['at', 'message', 'attempts'].includes(key)) &&
    finiteNumber(value.at) &&
    typeof value.message === 'string' &&
    (!Object.hasOwn(value, 'attempts') || (typeof value.attempts === 'number' && Number.isInteger(value.attempts) && value.attempts > 0)));
function validProjects(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  const paths = new Set();
  return value.every((project) => {
    if (!isJsonRecord(project) || !Object.hasOwn(project, 'id') || !Object.hasOwn(project, 'path')) return false;
    if (!Object.entries(project).every(([field, entry]) => Object.hasOwn(PROJECT_FIELDS, field) && PROJECT_FIELDS[field](entry)))
      return false;
    const key = pathKey(normPath(project.path));
    if (ids.has(project.id) || paths.has(key)) return false;
    ids.add(project.id);
    paths.add(key);
    return true;
  });
}
const STATE_FIELDS = {
  schemaVersion: supportedSchema,
  projects: validProjects,
  codexImportedAt: (value) => value === null || finiteNumber(value),
  codexImportFailure: validFailure,
  removedCodexIds: (value) => Array.isArray(value) && value.every((id) => typeof id === 'string'),
  removedPaths: (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && !!entry),
};

/** Unknown declared formats are read-only; supported collections must remain intact under normalization. */
function validProjectRoot(raw) {
  return (
    isJsonRecord(raw) &&
    ((Object.hasOwn(raw, 'schemaVersion') && !supportedSchema(raw.schemaVersion)) ||
      Object.entries(raw).every(([field, value]) => Object.hasOwn(STATE_FIELDS, field) && STATE_FIELDS[field](value)))
  );
}

/** Trailing separators don't make a different folder; a root keeps its own (/, C:\). */
function normPath(p) {
  if (!isWinPath(p)) return p.replace(/\/+$/, '') || '/';
  const t = p.replace(/[\\/]+$/, '');
  return /^[A-Za-z]:$/.test(t) ? `${t}\\` : t;
}
/** Whether two normalized paths are one folder: Windows paths ignore case and which separator. */
const pathKey = (p) => (isWinPath(p) ? winPathKey(p) : p);
const baseName = (p) => basename(normPath(p));

/**
 * @returns {{ schemaVersion: number, projects: { id: string, name: string, path: string, source: 'codex' | 'sage', codexId?: string }[],
 *             codexImportedAt: number | null, codexImportFailure: { at: number, message: string, attempts: number } | null, removedCodexIds: string[], removedPaths: string[] }}
 */
function empty() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: [],
    codexImportedAt: null,
    codexImportFailure: null,
    removedCodexIds: [],
    removedPaths: [],
  };
}

/** A well-formed state from disk; malformed entries and repeated paths or ids are dropped. */
function normalize(raw) {
  const out = empty();
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set();
  const seenIds = new Set();
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (!p || typeof p.path !== 'string' || !p.path || !isProjectId(p.id)) continue;
    const at = normPath(p.path);
    if (seen.has(pathKey(at)) || seenIds.has(p.id)) continue;
    seen.add(pathKey(at));
    seenIds.add(p.id);
    out.projects.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : baseName(at),
      path: at,
      source: p.source === 'codex' ? 'codex' : 'sage',
      ...(isProjectId(p.codexId) ? { codexId: p.codexId } : {}),
    });
  }
  if (typeof raw.codexImportedAt === 'number') out.codexImportedAt = raw.codexImportedAt;
  const f = raw.codexImportFailure;
  if (f && typeof f.message === 'string' && typeof f.at === 'number')
    out.codexImportFailure = { at: f.at, message: f.message, attempts: Number.isInteger(f.attempts) && f.attempts > 0 ? f.attempts : 1 };
  if (Array.isArray(raw.removedCodexIds)) out.removedCodexIds = raw.removedCodexIds.filter((x) => typeof x === 'string');
  if (Array.isArray(raw.removedPaths))
    out.removedPaths = [
      ...new Map(
        raw.removedPaths
          .filter((p) => typeof p === 'string' && p)
          .map((p) => {
            const at = normPath(p);
            return [pathKey(at), at];
          }),
      ).values(),
    ];
  return out;
}

/**
 * Merge Codex's project/list into the local list: new Codex projects are appended in Codex's order,
 * one already here (same codexId, or same folder) is linked rather than repeated, and one removed
 * here stays removed. Nothing local is renamed or dropped. Returns the new state, or the same
 * object when nothing changed.
 */
function mergeCodex(state, codexProjects, now = Date.now()) {
  const next = {
    ...state,
    projects: state.projects.map((p) => ({ ...p })),
    codexImportedAt: state.codexImportedAt ?? now,
    codexImportFailure: null,
  };
  let changed = state.codexImportedAt == null || state.codexImportFailure != null;
  const sorted = [...(codexProjects || [])].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0)); // malformed entries are skipped below;
  for (const cp of sorted) {
    const root = cp && cp.roots && cp.roots[0] && cp.roots[0].path;
    if (!cp || !isProjectId(cp.id) || typeof root !== 'string' || !root) continue;
    if (next.removedCodexIds.includes(cp.id)) continue;
    if (next.projects.some((p) => p.codexId === cp.id)) continue;
    const at = normPath(root);
    if (next.removedPaths.some((p) => pathKey(p) === pathKey(at))) continue;
    const same = next.projects.find((p) => pathKey(p.path) === pathKey(at));
    if (same) {
      if (!same.codexId) {
        same.codexId = cp.id;
        changed = true;
      }
      continue;
    }
    // the Codex id doubles as the local one, so Codex threads' projectId keeps matching
    const id = next.projects.some((p) => p.id === cp.id) ? randomUUID() : cp.id;
    next.projects.push({ id, name: cp.name || baseName(at), path: at, source: 'codex', codexId: cp.id });
    changed = true;
  }
  return changed ? next : state;
}

/**
 * The import failed (Codex missing, no project API, no answer): kept in projects.json with a count, so
 * it is seen rather than silently retried. It is tried again on the next launch, not in a loop.
 */
function failImport(state, message, now = Date.now()) {
  const attempts = (state.codexImportFailure?.attempts ?? 0) + 1;
  return { ...state, codexImportFailure: { at: now, message: String(message || 'unknown error').slice(0, 500), attempts } };
}

/** Add a folder; an existing entry for it is returned (and linked to codexId if it had none). */
function addProject(state, { path: p, name, codexId }) {
  const at = normPath(p);
  const removedPaths = state.removedPaths.filter((p) => pathKey(p) !== pathKey(at));
  if (removedPaths.length !== state.removedPaths.length) state = { ...state, removedPaths };
  const existing = state.projects.find((x) => pathKey(x.path) === pathKey(at));
  if (existing) {
    if (codexId && !existing.codexId)
      return { state: { ...state, projects: state.projects.map((x) => (x === existing ? { ...x, codexId } : x)) }, id: existing.id };
    return { state, id: existing.id };
  }
  const entry = { id: randomUUID(), name: name || baseName(at), path: at, source: 'sage', ...(codexId ? { codexId } : {}) };
  return { state: { ...state, projects: [entry, ...state.projects] }, id: entry.id };
}

function removeProject(state, id) {
  const gone = state.projects.find((p) => p.id === id);
  if (!gone) return state;
  const removedCodexIds =
    gone.codexId && !state.removedCodexIds.includes(gone.codexId) ? [...state.removedCodexIds, gone.codexId] : state.removedCodexIds;
  const removedPaths = state.removedPaths.some((p) => pathKey(p) === pathKey(gone.path))
    ? state.removedPaths
    : [...state.removedPaths, gone.path];
  return { ...state, projects: state.projects.filter((p) => p !== gone), removedCodexIds, removedPaths };
}

function renameProject(state, id, name) {
  if (typeof name !== 'string' || !name.trim()) return state;
  return { ...state, projects: state.projects.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) };
}

/** Move a project in front of another one (null: to the end). */
function moveProject(state, id, beforeId) {
  const moving = state.projects.find((p) => p.id === id);
  if (!moving || id === beforeId) return state;
  const rest = state.projects.filter((p) => p !== moving);
  const at = beforeId ? rest.findIndex((p) => p.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return { ...state, projects: rest };
}

class ProjectsStore {
  constructor(
    file,
    onChange = (_snapshot) => {
      /* no listener */
    },
  ) {
    this.file = file;
    this.onChange = onChange;
    this.state = null;
    /** @type {Error | null} protected data must never be replaced by normalized defaults */
    this.writeError = null;
  }
  read() {
    if (!this.state) {
      const { data, error } = readCheckedStore(this.file, 'the project list', validProjectRoot);
      this.writeError = error
        ? new Error('The saved project list could not be read. Restore it and restart MoPilot before editing projects.', { cause: error })
        : null;
      if (data && Object.hasOwn(data, 'schemaVersion') && !supportedSchema(data.schemaVersion)) {
        const newer = Number.isSafeInteger(data.schemaVersion) && data.schemaVersion > SCHEMA_VERSION;
        this.writeError = new Error(
          newer
            ? 'The project list was saved by a newer version of MoPilot. Update MoPilot before editing projects.'
            : 'The project list has an unsupported schema version. Restore it before editing projects.',
        );
      }
      this.state = normalize(data);
    }
    return this.state;
  }
  assertWritable() {
    this.read();
    if (this.writeError) throw this.writeError;
  }
  commit(next) {
    this.assertWritable();
    if (next === this.state) return;
    writeAtomic(this.file, JSON.stringify(next, null, 2));
    this.state = next;
    this.onChange(this.snapshot());
  }
  snapshot() {
    const s = this.read();
    return { projects: s.projects, codexImported: s.codexImportedAt != null, codexImportFailure: s.codexImportFailure };
  }
  list() {
    return this.snapshot();
  }
  add(opts) {
    const r = addProject(this.read(), opts || {});
    this.commit(r.state);
    return r.id;
  }
  /** Link only the admitted local identity; a late native result cannot recreate a removed project. */
  linkCodex(id, codexId) {
    this.assertWritable();
    if (!isProjectId(id) || !isProjectId(codexId)) return null;
    const state = this.read();
    const current = state.projects.find((p) => p.id === id);
    if (!current) {
      // Keep the late copy out of later one-way imports, without hiding another project's native identity.
      const owned = state.projects.some((p) => p.codexId === codexId || (p.source === 'codex' && p.id === codexId));
      if (!owned && !state.removedCodexIds.includes(codexId))
        this.commit({ ...state, removedCodexIds: [...state.removedCodexIds, codexId] });
      return null;
    }
    if (!current.codexId) this.commit({ ...state, projects: state.projects.map((p) => (p.id === id ? { ...p, codexId } : p)) });
    return this.read().projects.find((p) => p.id === id) ?? null;
  }
  remove(id) {
    this.commit(removeProject(this.read(), id));
  }
  rename(id, name) {
    this.commit(renameProject(this.read(), id, name));
  }
  move(id, beforeId) {
    this.commit(moveProject(this.read(), id, beforeId ?? null));
  }
  importCodex(codexProjects) {
    this.commit(mergeCodex(this.read(), codexProjects));
    return this.snapshot();
  }
  importFailed(message) {
    this.commit(failImport(this.read(), message));
    return this.snapshot();
  }
}

/**
 * IPC for the renderer; every change is pushed to all windows as projects:changed.
 * @param ipcMain
 * @param store ProjectsStore
 * @param {{ listCodexProjects?: () => Promise<any> }} [opts]
 */
function registerProjects(ipcMain, store, { listCodexProjects } = {}) {
  ipcMain.handle('projects:list', () => store.list());
  require('./conductorImport.cjs').register(ipcMain, store);
  ipcMain.handle('projects:canonicalPaths', (_e, paths) => canonicalPaths(paths));
  ipcMain.handle('projects:folderAvailability', (_e, paths) => folderAvailability(paths));
  ipcMain.handle('projects:add', (_e, opts) =>
    opts && typeof opts.path === 'string' && path.isAbsolute(opts.path) ? store.add(opts) : null,
  );
  ipcMain.handle('projects:linkCodex', (_e, id, codexId) => store.linkCodex(id, codexId));
  ipcMain.handle('projects:remove', (_e, id) => store.remove(id));
  ipcMain.handle('projects:rename', (_e, id, name) => store.rename(id, name));
  ipcMain.handle('projects:move', (_e, id, beforeId) => store.move(id, beforeId));
  ipcMain.handle('projects:importCodex', (_e, list) => store.importCodex(Array.isArray(list) ? list : []));
  ipcMain.handle('projects:importFailed', (_e, message) => store.importFailed(message));
  // the first import while Codex isn't running: a short-lived app-server is asked, then stopped
  /** @type {Promise<unknown> | null} */
  let importing = null;
  ipcMain.handle('projects:importCodexBackground', () => {
    if (!listCodexProjects || store.snapshot().codexImported) return store.snapshot();
    store.assertWritable();
    importing ??= listCodexProjects()
      .then(
        (list) => (list ? store.importCodex(list) : store.snapshot()),
        (e) => store.importFailed(e?.message ?? e),
      )
      .finally(() => (importing = null));
    return importing;
  });
}

module.exports = {
  ProjectsStore,
  phoneProjects,
  registerProjects,
  normalize,
  mergeCodex,
  failImport,
  addProject,
  removeProject,
  renameProject,
  moveProject,
  writeAtomic,
  SCHEMA_VERSION,
};
