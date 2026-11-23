// Action memory's one store (#3571, G4), for browser routines now and desktop ones next: each routine a user saved
// (its name, what it does, its steps with semantic anchors, its parameters and their recorded examples), in one file
// encrypted at rest (sealedFile.cjs), since the examples are what the user typed. A routine changes by id and names the
// revision it saw, so a replay's update that lost a race is dropped rather than written over a newer one.
const crypto = require('node:crypto');
const { SealedFile } = require('../../platform/sealedFile.cjs');
const { ToolError } = require('../contract/registry.cjs');

const MAX_ROUTINES = 100;
const MAX_STEPS = 200;
const KINDS = new Set(['browser', 'desktop']);

/** @typedef {{ name: string, example: string }} Param */
/** @typedef {{ id: string, kind: 'browser' | 'desktop', name: string, description: string, steps: any[], params: Param[], prompts: (string | null)[], rev: number, createdAt: number, updatedAt: number, runs: number, handoffs: number }} Routine */

function text(v, field, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > max) throw new ToolError(`A routine's ${field} is 1 to ${max} characters`, 'bad_args');
  return t;
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

class RoutineStore {
  /**
   * @param {{ file: string, keyFile: string, safeStorage: any, now?: () => number, newId?: () => string,
   *           sealed?: { read(): Buffer | null, write(b: Buffer): void, available(): boolean } }} o
   */
  constructor(o) {
    this.sealed = o.sealed ?? new SealedFile({ file: o.file, keyFile: o.keyFile, safeStorage: o.safeStorage, what: 'your routines' });
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => crypto.randomUUID());
    /** @type {Routine[] | null} read on first use */
    this.cache = null;
    /** @type {Set<(routines: Routine[]) => void>} */
    this.listeners = new Set();
  }

  /** @returns {Routine[]} */
  #all() {
    if (this.cache) return this.cache;
    const bytes = this.sealed.read();
    const value = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    /** @type {Routine[]} */
    const all = Array.isArray(value?.routines) ? value.routines.filter((r) => r && typeof r.id === 'string' && KINDS.has(r.kind)) : [];
    this.cache = all;
    return all;
  }

  #write(/** @type {Routine[]} */ next) {
    if (!this.sealed.available()) throw new ToolError("Routines can't be saved: the system keychain is unavailable", 'unavailable');
    this.sealed.write(Buffer.from(JSON.stringify({ version: 1, routines: next })));
    this.cache = next;
    for (const fn of this.listeners) fn(next);
  }

  /** Every routine, newest change first (of two changed at once, the one saved later). */
  list() {
    const all = this.#all();
    return all
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.updatedAt - a.r.updatedAt || b.i - a.i)
      .map((x) => x.r);
  }

  /** A routine by id, or by its name (any case). */
  get(/** @type {string} */ idOrName) {
    const all = this.#all();
    return all.find((r) => r.id === idOrName) ?? all.find((r) => sameName(r.name, String(idOrName ?? ''))) ?? null;
  }

  /**
   * Saves a new routine. A name already taken is refused (delete that one, or pick another name).
   * @param {{ kind: 'browser' | 'desktop', name: string, description?: string, steps: any[], params: Param[], prompts?: (string | null)[] }} r
   *   prompts: each part's user message, which a later message is matched against (routineMatch.cjs)
   */
  save(r) {
    const name = text(r.name, 'name', 80);
    const description = r.description == null || r.description === '' ? '' : text(r.description, 'description', 500);
    if (!KINDS.has(r.kind)) throw new ToolError(`Unknown routine kind ${r.kind}`, 'bad_args');
    if (!Array.isArray(r.steps) || !r.steps.length) throw new ToolError('A routine needs at least one step', 'bad_args');
    if (r.steps.length > MAX_STEPS) throw new ToolError(`A routine has at most ${MAX_STEPS} steps`, 'bad_args');
    const all = this.#all();
    if (all.some((x) => sameName(x.name, name))) throw new ToolError(`A routine named "${name}" already exists`, 'exists');
    if (all.length >= MAX_ROUTINES) throw new ToolError(`You can keep at most ${MAX_ROUTINES} routines`, 'limit');
    const at = this.now();
    /** @type {Routine} */
    const routine = {
      id: this.newId(),
      kind: r.kind,
      name,
      description,
      steps: r.steps,
      params: r.params ?? [],
      prompts: r.prompts ?? [],
      rev: 1,
      createdAt: at,
      updatedAt: at,
      runs: 0,
      handoffs: 0,
    };
    this.#write([...all, routine]);
    return routine;
  }

  /**
   * Changes a routine if it is still at `rev`: its steps and parameters (a verified hand-off), name or description
   * (an edit), or its run counts. Null when it is gone or changed since (nothing is written).
   * @param {string} id
   * @param {number} rev
   * @param {{ steps?: any[], params?: Param[], name?: string, description?: string, ran?: boolean, handedOff?: boolean }} patch
   */
  update(id, rev, patch) {
    const all = this.#all();
    const cur = all.find((r) => r.id === id);
    if (!cur || cur.rev !== rev) return null;
    const next = { ...cur };
    if (patch.name !== undefined) {
      next.name = text(patch.name, 'name', 80);
      if (all.some((x) => x.id !== id && sameName(x.name, next.name)))
        throw new ToolError(`A routine named "${next.name}" already exists`, 'exists');
    }
    if (patch.description !== undefined) next.description = patch.description === '' ? '' : text(patch.description, 'description', 500);
    if (patch.steps) {
      if (!patch.steps.length || patch.steps.length > MAX_STEPS) throw new ToolError(`A routine has 1 to ${MAX_STEPS} steps`, 'bad_args');
      next.steps = patch.steps;
    }
    if (patch.params) next.params = patch.params;
    if (patch.ran) next.runs = cur.runs + 1;
    if (patch.handedOff) next.handoffs = cur.handoffs + 1;
    // a run's count is not a change of what the routine does
    const changed = patch.name !== undefined || patch.description !== undefined || !!patch.steps || !!patch.params;
    if (changed) Object.assign(next, { rev: cur.rev + 1, updatedAt: this.now() });
    this.#write(all.map((r) => (r.id === id ? next : r)));
    return next;
  }

  /** Deletes a routine; false when there was none. */
  remove(/** @type {string} */ id) {
    const all = this.#all();
    if (!all.some((r) => r.id === id)) return false;
    this.#write(all.filter((r) => r.id !== id));
    return true;
  }

  /** Calls `fn(routines)` after each change; returns a function that stops it. */
  onChange(/** @type {(routines: Routine[]) => void} */ fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { RoutineStore, MAX_ROUTINES, MAX_STEPS };
