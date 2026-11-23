// The scheduled-task run ledger (~/.mopilot/automation-runs): one file per task per scheduled time, created exclusively, so only one MoPilot runs it.
// Every MoPilot build and profile on the machine shares this folder (it sits in the home folder, not in
// userData). Claiming a scheduled time creates <task>/<time>.json with O_EXCL: the process that creates it
// starts the run, and every other one sees the file and leaves that time alone. The file then records what
// happened (started, skipped, failed) for the Scheduled page's run history.
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic, withAsyncCleanup } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { scheduleTime } = require('../../shared/schedule.mjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');

// Keep the newest records and the last scheduled occurrence, so manual runs cannot erase the scheduler watermark.
/** How many recent records a task keeps; older ones are removed after a claim. */
const KEEP = 200;
/** Only a written run state can supersede the previous run; a claimed file may still be empty. */
const RUN_STATUSES = new Set(['starting', 'started', 'failed', 'needs-approval']);

const folderOf = (taskId) => {
  const id = String(taskId);
  // URI encoding leaves dots and empty strings unchanged; neither may select a directory boundary.
  if (!id || /^\.\.?$/.test(id)) throw new Error(`"${id}" isn't a task id`);
  return encodeURIComponent(id);
};

/** Only canonical integer filenames can round-trip through fileOf without aliasing another record. */
function timeOf(name) {
  if (!/^(-?\d+)\.json$/.test(name)) return null;
  const time = scheduleTime(name.slice(0, -5), null);
  return time !== null && `${time}.json` === name ? time : null;
}

class RunLedger {
  /**
   * @param {object} o
   * @param {string} o.dir the ledger folder (~/.mopilot/automation-runs)
   * @param {object} [o.by] who claims: {pid, app, version, profile}
   * @param {() => number} [o.now]
   * @param {number} [o.keep]
   */
  constructor(o) {
    this.dir = o.dir;
    this.by = o.by ?? { pid: process.pid };
    this.now = o.now ?? Date.now;
    this.keep = o.keep ?? KEEP;
    /** the ledger's baseline, once read */
    this.started = 0;
  }

  fileOf(taskId, scheduledFor) {
    return path.join(this.dir, folderOf(taskId), `${scheduledFor}.json`);
  }

  /**
   * Claim one scheduled time of a task. Resolves to the new record, or null when another process (or an
   * earlier tick) already claimed it.
   * @param {string} taskId
   * @param {number} scheduledFor the RRULE time, in ms
   * @param {object} fields what the record starts with (status, reason, harness, ...)
   */
  async claim(taskId, scheduledFor, fields) {
    const file = this.fileOf(taskId, scheduledFor);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const record = { taskId: String(taskId), scheduledFor, claimedAt: this.now(), by: this.by, ...fields };
    let handle;
    try {
      handle = await fs.promises.open(file, 'wx');
    } catch (e) {
      if (e?.code === 'EEXIST') return null;
      throw e;
    }
    try {
      await withAsyncCleanup(
        () => handle.writeFile(JSON.stringify(record)),
        () => handle.close(),
      );
    } catch (error) {
      // Nothing ran: an incomplete claim must not reserve this occurrence or advance its watermark.
      return withAsyncCleanup(
        () => {
          throw error;
        },
        () => this.release(taskId, scheduledFor),
      );
    }
    try {
      await this.prune(taskId);
    } catch (error) {
      // The occurrence is already claimed: retention must not prevent its run from starting.
      noteIgnored('prune scheduled task run history', error);
    }
    return record;
  }

  /** Give a claimed time back (nothing ran): a later check, here or in another MoPilot, may claim it again. */
  async release(taskId, scheduledFor) {
    await fs.promises.rm(this.fileOf(taskId, scheduledFor), { force: true });
  }

  /**
   * When this ledger started, made on the first call: times before it may already have run under a MoPilot that
   * kept no ledger, so they are not caught up.
   */
  async baseline(now) {
    if (this.started) return this.started;
    const file = path.join(this.dir, '.baseline');
    await fs.promises.mkdir(this.dir, { recursive: true });
    try {
      await fs.promises.writeFile(file, String(now), { flag: 'wx' });
      this.started = now;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // another MoPilot made it first, or an earlier start of this one; one that doesn't read is "now"
      this.started = scheduleTime(await fs.promises.readFile(file, 'utf8'), now) || now;
    }
    return this.started;
  }

  /** Merge fields into a claimed record (the run's chat, or why it failed). */
  async update(taskId, scheduledFor, patch) {
    const file = this.fileOf(taskId, scheduledFor);
    const prev = await readRecord(file, true);
    writeAtomic(file, JSON.stringify({ ...prev, ...patch }));
  }

  /** The scheduled times a task has records for, newest first. */
  async times(taskId) {
    let names = [];
    try {
      names = await fs.promises.readdir(path.join(this.dir, folderOf(taskId)));
    } catch {
      return [];
    }
    return names
      .map(timeOf)
      .filter((time) => time !== null)
      .sort((a, b) => Math.abs(b) - Math.abs(a));
  }

  /** The newest scheduled time this ledger handled for a task, or 0. */
  async latest(taskId) {
    return (await this.times(taskId)).find((time) => time >= 0) ?? 0;
  }

  /** A task's records, newest first; a record still being written reads as just its time. */
  async list(taskId, limit = 20) {
    const out = [];
    for (const t of (await this.times(taskId)).slice(0, limit)) {
      out.push({
        taskId: String(taskId),
        scheduledFor: Math.abs(t),
        ...(t < 0 ? { manual: true } : {}),
        ...(await readRecord(this.fileOf(taskId, t))),
      });
    }
    return out;
  }

  /**
   * The task's newest record that is not a skip (a run that started, is starting or failed), or null. Each
   * skip while a run goes on adds a record, so a run longer than a few times is not among the newest.
   */
  async lastRun(taskId) {
    return (await this.lastRunEntry(taskId))?.record ?? null;
  }

  /** lastRun with its file's key. */
  async lastRunEntry(taskId) {
    for (const key of await this.times(taskId)) {
      const record = await readRecord(this.fileOf(taskId, key));
      if (typeof record.status === 'string' && RUN_STATUSES.has(record.status)) return { key, record };
    }
    return null;
  }

  /** Record an attended run without advancing the scheduler's last handled time. */
  async recordManual(taskId, chatId, harness) {
    let time = this.now();
    // Negative file keys keep a manual run distinct from an RRULE occurrence at the same millisecond.
    while (!(await this.claim(taskId, -time, { scheduledFor: time, status: 'started', chatId, harness, manual: true }))) time++;
  }

  /** Remove every record of a task (the task was deleted). */
  async forget(taskId) {
    await fs.promises.rm(path.join(this.dir, folderOf(taskId)), { recursive: true, force: true });
  }

  async prune(taskId) {
    const times = await this.times(taskId);
    if (times.length <= this.keep) return;
    const scheduled = times.find((time) => time >= 0);
    // the scheduler checks whether the last run is still going, however many skips came after it
    const last = (await this.lastRunEntry(taskId))?.key;
    for (const t of times.slice(this.keep)) {
      if (t !== scheduled && t !== last) await fs.promises.rm(this.fileOf(taskId, t), { force: true });
    }
  }
}

/** History reads tolerate in-progress files; mutations must not replace existing unreadable data. */
async function readRecord(file, strict = false) {
  try {
    const parsed = parseJsonRecord(await fs.promises.readFile(file, 'utf8'));
    if (!parsed.ok && strict) throw new Error('Unreadable scheduled run record');
    return parsed.ok ? parsed.record : {};
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return {};
  }
}

module.exports = { RunLedger, KEEP };
