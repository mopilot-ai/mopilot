// MoMo's routines on disk (#2139): one encrypted file (routines.json under MoMo's folder, sealedFile.cjs) holding each routine (a recurring task the user approved: name, prompt, schedule, the sources it reads), the starter routines from setup already proposed (each once), and the runs MoMo started for routines, kept 30 days. A routine MoMo proposes waits for the user's approval and never runs before it; that approval (`update({ approved: true })`) is the user's alone: only Settings' routines IPC gives it, and no agent tool reaches this store (tests/momoRoutineStore.test.ts holds the repository to that).
const path = require('node:path');
const crypto = require('node:crypto');
const { RRule } = require('rrule');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { momoTaskId, localDay, ROUTINE, RoutineError } = require('../../shared/momoRoutine.mjs');
const { SOURCE_IDS } = require('./sources/hub.cjs');

const DAY = 86_400_000;
const KEEP_RUNS_MS = 30 * DAY;
const MAX_ROUTINES = 50;

/** @typedef {{ id: string, name: string, prompt: string, rrule: string, sources?: string[], status: 'ACTIVE' | 'PAUSED', approved: boolean, createdAt: number, updatedAt: number, scheduleFrom: number, rev?: number }} Routine `rev`: counts its changes, so an approval names the version the user saw */
/** @typedef {{ chatId: string, taskId: string, kind: string, due: number, startedAt: number, endedAt?: number, outcome?: string, by?: { pid: number, started: number }, discarded?: boolean }} Run */
/** @typedef {{ routines: Routine[], runs: Run[], starters: string[] }} Routines */

const records = (v) => (Array.isArray(v) ? v.filter(isJsonRecord) : []);

/** The file's value in any shape: lists of records, runs older than 30 days gone, and the runs of the daily edition an older build kept (the edition is gone). */
function shapeOf(v, now) {
  const r = isJsonRecord(v) ? v : {};
  return {
    routines: /** @type {Routine[]} */ (records(r.routines)),
    runs: /** @type {Run[]} */ (
      records(r.runs).filter((x) => x.kind === ROUTINE && now - (typeof x.startedAt === 'number' ? x.startedAt : 0) < KEEP_RUNS_MS)
    ),
    starters: Array.isArray(r.starters) ? r.starters.filter((x) => typeof x === 'string') : [],
  };
}

function text(v, field, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > max) throw new RoutineError(`A routine's ${field} is 1 to ${max} characters`, 'bad_args');
  return t;
}

/** A schedule a routine may have: an RRULE at most hourly (minutes and seconds would only hit the daily limit). */
function ruleOf(v) {
  const rule = text(v, 'schedule', 300);
  let o;
  try {
    o = RRule.parseString(rule.replace(/^RRULE:/, ''));
  } catch {
    throw new RoutineError(`Not a schedule: ${rule}`, 'bad_args');
  }
  if (o.freq === undefined) throw new RoutineError(`Not a schedule: ${rule}`, 'bad_args');
  // several minutes or seconds an hour (HOURLY;BYMINUTE=0,15,30) run more often than hourly too
  const many = (/** @type {unknown} */ v) => Array.isArray(v) && v.length > 1;
  if (o.freq === RRule.MINUTELY || o.freq === RRule.SECONDLY || many(o.byminute) || many(o.bysecond))
    throw new RoutineError('A routine runs at most hourly', 'bad_args');
  return rule;
}

/** The sources a routine reads (sources/hub.cjs), each once; none is fine. */
function sourcesOf(/** @type {unknown} */ v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => !SOURCE_IDS.includes(x)))
    throw new RoutineError(`A routine's sources are some of ${SOURCE_IDS.join(', ')}`, 'bad_args');
  return [...new Set(v)];
}

/** Routine runs started on the local day of `at`. */
function countOn(/** @type {Run[]} */ runs, /** @type {number} */ at) {
  const day = localDay(at);
  return runs.filter((r) => r.kind === ROUTINE && localDay(r.startedAt) === day).length;
}

class RoutineStore {
  /**
   * @param {{ dir: string, safeStorage: import('../gateway/sealedFile.cjs').SafeStorage | null, now?: () => number,
   *   newId?: () => string, lockWaitMs?: number }} o
   */
  constructor({ dir, safeStorage, now = Date.now, newId = () => crypto.randomUUID(), lockWaitMs = 500 }) {
    this.now = now;
    this.newId = newId;
    this.json = new SealedJson({ file: path.join(dir, 'routines.json'), safeStorage, now, lockWaitMs, shape: shapeOf });
  }

  /** Reset MoMo: every routine and run record is deleted (registered with MoMo's reset by the integration). */
  erase() {
    return this.json.erase();
  }

  /** @returns {Routine[]} */
  list() {
    return this.json.read().routines;
  }

  /** @returns {Routine | null} */
  get(/** @type {string} */ id) {
    return this.list().find((r) => r.id === id) ?? null;
  }

  /**
   * A new routine: `approved` when the user made it, else it waits for the user's approval (one MoMo proposed). One
   * waiting under the same name takes another proposal's prompt, schedule and sources and is the answer to it, so a
   * retried or corrected proposal asks once and says what it now does. With `starter`, that starter
   * routine from setup is proposed once ever: null when it was before (even if the user removed it since).
   * @param {{ name?: unknown, prompt?: unknown, rrule?: unknown, sources?: unknown }} input
   * @param {{ approved: boolean, starter?: string }} o
   * @returns {Promise<Routine | null>}
   */
  async add(input, { approved, starter }) {
    const at = this.now();
    const routine = /** @type {Routine} */ ({
      id: momoTaskId(this.newId()),
      name: text(input?.name, 'name', 80),
      prompt: text(input?.prompt, 'prompt', 2000),
      rrule: ruleOf(input?.rrule),
      sources: sourcesOf(input?.sources),
      status: 'ACTIVE',
      approved,
      rev: 1,
      createdAt: at,
      updatedAt: at,
      scheduleFrom: at,
    });
    return this.json.change((s) => {
      if (starter !== undefined && s.starters.includes(starter)) return null;
      const name = routine.name.toLowerCase();
      const waiting = approved ? undefined : s.routines.find((r) => !r.approved && r.name.toLowerCase() === name);
      if (!waiting && s.routines.length >= MAX_ROUTINES) throw new RoutineError(`MoMo keeps at most ${MAX_ROUTINES} routines`, 'full');
      if (starter !== undefined) s.starters.push(starter);
      if (waiting) {
        Object.assign(waiting, {
          prompt: routine.prompt,
          rrule: routine.rrule,
          sources: routine.sources,
          updatedAt: at,
          rev: (waiting.rev ?? 0) + 1,
        });
        return waiting;
      }
      s.routines.push(routine);
      return routine;
    });
  }

  /**
   * Change a routine's name, prompt, schedule, sources, pause or approval; null when it is gone. A new schedule, a resume or an
   * approval counts from now, so the times before it are not runs it missed.
   * With `seen`, the change is made only to the version the user saw (its `rev`): one changed since throws `changed`.
   * @param {string} id @param {{ name?: unknown, prompt?: unknown, rrule?: unknown, sources?: unknown, status?: unknown, approved?: unknown }} patch
   * @param {{ seen?: number }} [o]
   * @returns {Promise<Routine | null>}
   */
  async update(id, patch, { seen } = {}) {
    const next = {
      ...(patch.name !== undefined ? { name: text(patch.name, 'name', 80) } : {}),
      ...(patch.prompt !== undefined ? { prompt: text(patch.prompt, 'prompt', 2000) } : {}),
      ...(patch.rrule !== undefined ? { rrule: ruleOf(patch.rrule) } : {}),
      ...(patch.sources !== undefined ? { sources: sourcesOf(patch.sources) } : {}),
    };
    if (patch.status !== undefined && patch.status !== 'ACTIVE' && patch.status !== 'PAUSED')
      throw new RoutineError('A routine is ACTIVE or PAUSED', 'bad_args');
    if (patch.approved !== undefined && patch.approved !== true) throw new RoutineError('An approval can only be given', 'bad_args');
    return this.json.change((s) => {
      const r = s.routines.find((x) => x.id === id);
      if (!r) return null;
      if (seen !== undefined && (r.rev ?? 0) !== seen)
        throw new RoutineError(`“${r.name}” changed since you saw it: read it again first.`, 'changed');
      const at = this.now();
      const restart =
        (next.rrule !== undefined && next.rrule !== r.rrule) ||
        (patch.status === 'ACTIVE' && r.status !== 'ACTIVE') ||
        (patch.approved === true && !r.approved);
      Object.assign(r, next, patch.status ? { status: patch.status } : {}, patch.approved ? { approved: true } : {}, { updatedAt: at });
      if (restart) r.scheduleFrom = at;
      r.rev = (r.rev ?? 0) + 1;
      return r;
    });
  }

  /** Remove a routine; whether it was there. */
  remove(/** @type {string} */ id) {
    return this.json.change((s) => {
      const before = s.routines.length;
      s.routines = s.routines.filter((r) => r.id !== id);
      return s.routines.length !== before;
    });
  }

  /**
   * A run MoMo started, by its chat. With `limit`, a routine's run is recorded only while that day has fewer routine
   * runs than it, counted under the lock (two MoPilots can't both take the last one): null when the day is full.
   */
  beginRun(/** @type {Omit<Run, 'startedAt'>} */ run, /** @type {{ limit?: number }} */ { limit } = {}) {
    return this.json.change((s) => {
      if (limit !== undefined && run.kind === ROUTINE && countOn(s.runs, this.now()) >= limit) return null;
      const entry = { ...run, startedAt: this.now() };
      s.runs.push(entry);
      return entry;
    });
  }

  /** The run in `chatId` ended (`outcome`: completed, stopped, failed, interrupted); the run, or null when none is open. */
  endRun(/** @type {string} */ chatId, /** @type {string} */ outcome) {
    return this.json.change((s) => {
      const run = s.runs.find((r) => r.chatId === chatId && r.endedAt === undefined);
      if (!run) return null;
      Object.assign(run, { endedAt: this.now(), outcome });
      return run;
    });
  }

  /** The open run in `chatId`, or null. @returns {Run | null} */
  openRun(/** @type {string} */ chatId) {
    return this.json.read().runs.find((r) => r.chatId === chatId && r.endedAt === undefined) ?? null;
  }

  /** Every run still open (MoPilot may have quit during one). @returns {Run[]} */
  openRuns() {
    return this.json.read().runs.filter((r) => r.endedAt === undefined);
  }

  /** Ended runs started before `at` whose chat is still kept. @returns {Run[]} */
  endedBefore(/** @type {number} */ at) {
    return this.json.read().runs.filter((r) => r.endedAt !== undefined && r.startedAt < at && !r.discarded);
  }

  /** The run's chat was deleted. */
  markDiscarded(/** @type {string} */ chatId) {
    return this.json.change((s) => {
      for (const r of s.runs) if (r.chatId === chatId) r.discarded = true;
    });
  }

  /** Routine runs (not other kinds) started at or after `at` whose chat is still kept (MoMo's activity list). @returns {Run[]} */
  routineRunsSince(/** @type {number} */ at) {
    return this.json.read().runs.filter((r) => r.kind === ROUTINE && r.startedAt >= at && !r.discarded);
  }

  /** One routine's runs, newest first (View history): the 30 days MoMo keeps. @returns {Run[]} */
  runsOf(/** @type {string} */ taskId) {
    return this.json
      .read()
      .runs.filter((r) => r.kind === ROUTINE && r.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Routine runs started on the local day of `at`. */
  runsOn(/** @type {number} */ at) {
    return countOn(this.json.read().runs, at);
  }
}

module.exports = { RoutineStore, MAX_ROUTINES };
