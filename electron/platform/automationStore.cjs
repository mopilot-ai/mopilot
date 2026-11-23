// Where each scheduled task lives, by the harness that runs it: Codex tasks with the Codex app, the rest in ~/.mopilot/automations, Claude Code ones also in Claude Desktop.
// One list for the Scheduled page, the scheduler and the chat tools. Codex tasks stay in
// $CODEX_HOME/automations (the Codex app runs those files too). Claude Code and ACP tasks go to
// ~/.mopilot/automations, shared by every MoPilot build and profile; a Claude Code task is also registered in
// Claude Desktop's scheduled tasks while Desktop is closed (electron/platform/nativeSchedulers.cjs), so either
// app runs it. Each listed task carries where it lives and which native app also runs it; those keys are
// never written to a task's file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parse, stringify } = require('smol-toml');
const { isTaskFolderId, canRememberChat, canonicalTask, storeHomeOf, desktopRuns, machineOf } = require('../../shared/scheduleTask.mjs');
const { writeAtomic } = require('./fsutil.cjs');

/** Keys a listed task carries that describe it, not what the user set: never written to a file. */
const DERIVED = ['home', 'native_app', 'runs_in', 'cron', 'fired_by'];

/** What Claude Desktop knows of a MoPilot Claude task (claude_desktop in its file). */
const DESKTOP = {
  registered: 'registered',
  pending: 'pending',
  /** cron can't say the rule */
  schedule: 'unsupported-schedule',
  /** Desktop's store isn't recognized */
  store: 'unavailable',
  /** registered once, and no longer in Desktop's list */
  missing: 'missing',
};

/** Read one folder-owned task; queued refreshes recheck its directory without listing unrelated tasks. */
async function readTask(dir, id, onError, strictId, entry) {
  try {
    if (!(entry ?? (await fs.promises.lstat(path.join(dir, id)))).isDirectory()) return null;
    const a = /** @type {any} */ (parse(await fs.promises.readFile(path.join(dir, id, 'automation.toml'), 'utf8')));
    // The folder owns the task: stale file metadata cannot redirect writes, deletion or migration.
    return { ...a, id };
  } catch (error) {
    if (id === strictId && error?.code !== 'ENOENT') throw error;
    onError(`Couldn't load scheduled task "${id}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The tasks in a folder of <id>/automation.toml files; one that doesn't parse is reported and skipped. */
async function readFolder(dir, onError, strictId) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (strictId !== undefined && error?.code !== 'ENOENT') throw error;
    return [];
  }
  const out = [];
  for (const e of names) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const task = await readTask(dir, e.name, onError, strictId, e);
    if (task) out.push(task);
  }
  return out;
}

/** A task written to <dir>/<id>/automation.toml, without the keys a listing adds. */
async function writeTask(dir, a) {
  const clean = Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && v !== null && !DERIVED.includes(k)));
  const folder = path.join(dir, String(a.id));
  // a half-written task would be read (here, by another MoPilot, by the Codex app) as a broken one
  writeAtomic(path.join(folder, 'automation.toml'), stringify(clean));
}

/** Whether Claude Desktop runs the task too: a Claude Code task on this Mac, never one on a remote machine. */
const isClaude = desktopRuns;
/** A task in the Codex app's folder that is the Codex app's own: Codex (or no harness) on this Mac; migrate() moves out the rest. */
const codexOwned = (a) => (a.harness === undefined || a.harness === 'codex') && !machineOf(a);
/** The folder a task's file lives in: the Codex app's for a Codex task on this Mac, else MoPilot's. */
const dirOf = (store, a) => (storeHomeOf(a) === 'codex' ? store.o.codexDir() : store.o.mopilotDir());

/** The readable start of a new task's id: its name as a slug ("task" with none). The E2E specs find tasks by it. */
function taskIdPrefix(name) {
  return (
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'task'
  );
}

/** A new task id: a readable name prefix and a UUID, unique across concurrent stores, harnesses and profiles. */
function uniqueId(name, taken, makeId = crypto.randomUUID) {
  const base = taskIdPrefix(name);
  let id = `${base}-${makeId()}`;
  while (taken.has(id)) id = `${base}-${makeId()}`;
  return id;
}

class AutomationStore {
  /**
   * @param {object} o
   * @param {() => string} o.codexDir $CODEX_HOME/automations
   * @param {() => string} o.mopilotDir ~/.mopilot/automations
   * @param o.codexApp nativeSchedulers codexApp()
   * @param o.desktop nativeSchedulers claudeDesktop()
   * @param {(line: string) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.o = o;
    this.log =
      o.log ??
      (() => {
        /* no logger */
      });
    this.now = o.now ?? Date.now;
    this.operations = new Map();
  }

  /** Serialize mutations of one task so recovery cannot overwrite a newer edit or recreate a deletion. */
  async mutate(id, action) {
    const previous = this.operations.get(id) || Promise.resolve();
    const next = previous.then(action, action);
    this.operations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.operations.get(id) === next) this.operations.delete(id);
    }
  }

  pendingFile() {
    return path.join(this.o.mopilotDir(), '.desktop-pending.json');
  }
  /** Claude Desktop removals waiting for Desktop to close: ids. */
  readPending(strict = false) {
    try {
      const p = JSON.parse(fs.readFileSync(this.pendingFile(), 'utf8'));
      if (!Array.isArray(p?.remove)) throw new Error('Unreadable Desktop removal intents');
      return p.remove.map(String);
    } catch (error) {
      if (strict && error?.code !== 'ENOENT') throw error;
      return [];
    }
  }
  async writePending(ids) {
    writeAtomic(this.pendingFile(), JSON.stringify({ remove: [...new Set(ids)] }));
  }

  /** Acknowledge only successful removals; intents added while a native check waited remain pending. */
  async finishRemovals(ids) {
    await this.writePending(this.readPending(true).filter((id) => !ids.has(id)));
  }

  /**
   * Every task, newest first. `errors` lists the files that didn't load.
   * @returns {Promise<{tasks: any[], errors: string[]}>}
   */
  async list(strictId) {
    const errors = [];
    const onError = (m) => errors.push(m);
    const codex = (await readFolder(this.o.codexDir(), onError, strictId)).map((a) => ({ ...a, home: 'codex', native_app: 'codex-app' }));
    const mine = await readFolder(this.o.mopilotDir(), onError, strictId);
    const local = [...mine, ...codex].find((a) => String(a.id) === strictId);
    const nativeOwnsFields = !local || (isClaude(local) && !local.transfer_from && local.claude_desktop !== DESKTOP.pending);
    const nativeId = nativeOwnsFields ? strictId : undefined;
    const allowUnavailable = !!local && local.claude_desktop !== DESKTOP.registered && local.claude_desktop !== DESKTOP.missing;
    const desktop = new Map(this.o.desktop.list(onError, nativeId, allowUnavailable).map((t) => [t.id, t]));
    const removing = new Set(this.readPending(nativeId !== undefined));
    const tasks = [...codex];
    for (const a of mine) {
      const d = isClaude(a) ? desktop.get(String(a.id)) : undefined;
      desktop.delete(String(a.id));
      if (!isClaude(a)) {
        tasks.push({ ...a, home: 'mopilot', native_app: null });
        continue;
      }
      if (d && !a.transfer_from && a.claude_desktop !== DESKTOP.pending) {
        // Desktop is where its schedule and prompt are edited too: its fields win, MoPilot keeps the rest
        const { id: _id, version: _v, kind: _k, created_at: _c, ...fromDesktop } = d;
        tasks.push({ ...a, ...fromDesktop, claude_desktop: DESKTOP.registered, home: 'mopilot', native_app: 'claude-desktop' });
        continue;
      }
      if (d) {
        // A pending edit still has an old native runner: do not run its local copy alongside Desktop.
        tasks.push({ ...a, home: 'mopilot', native_app: 'claude-desktop' });
        continue;
      }
      const state = !d && a.claude_desktop === DESKTOP.registered ? DESKTOP.missing : a.claude_desktop;
      tasks.push({ ...a, ...(state ? { claude_desktop: state } : {}), home: 'mopilot', native_app: null });
    }
    // tasks made in Claude Desktop itself
    for (const d of desktop.values()) if (!removing.has(d.id)) tasks.push({ ...d, home: 'claude-desktop', native_app: 'claude-desktop' });
    const transfers = new Map(tasks.filter((a) => a.transfer_from).map((a) => [String(a.id), a]));
    const canonical = tasks.filter((a) => !transfers.has(String(a.id)) || transfers.get(String(a.id)) === a);
    return {
      tasks: canonical
        .map((a) => ({ ...a, status: a.transfer_from ? a.transfer_status : a.status, runs_in: runsIn(a) }))
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
      errors,
    };
  }

  /** One canonical task with this id, or null; unrelated storage owners cannot be addressed by id alone. */
  async get(id, strict = false) {
    return canonicalTask((await this.list(strict ? String(id) : undefined)).tasks, id);
  }

  /**
   * Save a task where its harness keeps it, moving it when its harness changed. Resolves to the task as listed.
   * @param a the task (automation.toml fields)
   */
  async save(a) {
    if (!a || typeof a !== 'object') throw new Error('A scheduled task is needed');
    const id = a.id ? String(a.id) : uniqueId(a.name, new Set((await this.list()).tasks.map((task) => String(task.id))));
    return this.mutate(id, () => this.saveTask({ ...a, id }));
  }

  /** Apply only named fields against canonical state after admission to this task's mutation queue. */
  async update(id, changes) {
    const sid = String(id);
    if (!isTaskFolderId(sid)) throw new Error(`"${sid}" isn't a task id`);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('A scheduled task patch is needed');
    return this.mutate(sid, async () => {
      const current = await this.get(sid, true);
      if (!current) return null;
      return this.saveTask({ ...current, ...changes, id: sid }, current);
    });
  }

  async saveTask(a, current) {
    if (!a || typeof a !== 'object') throw new Error('A scheduled task is needed');
    if (a.id && !isTaskFolderId(String(a.id))) throw new Error(`"${a.id}" isn't a task id`);
    const id = String(a.id);
    const prev = current ?? (await this.get(id));
    const now = this.now();
    const task = { ...a, id, created_at: a.created_at ?? prev?.created_at ?? now, updated_at: now };
    // Transfer metadata belongs to the current store, never a stale editor or tool payload.
    delete task.transfer_from;
    delete task.transfer_claude;
    delete task.transfer_status;
    // a new schedule, or one resumed, counts from now: the times before it are not runs it missed
    if (!prev || prev.rrule !== task.rrule || (prev.status !== 'ACTIVE' && task.status === 'ACTIVE')) task.schedule_from = now;
    // a heartbeat's chat is on the machine it started on: a task that moves starts a new one where it runs now
    if (prev && machineOf(prev) !== machineOf(task)) delete task.target_thread_id;
    // a run on a machine uses the folder picked there: no worktree of this Mac (the dialog and the chat tools alike)
    if (machineOf(task)) task.execution_environment = 'local';
    const dir = dirOf(this, task);
    const home = storeHomeOf(task);
    if (prev && (prev.transfer_from || prev.home !== home || (isClaude(prev) && !isClaude(task)))) {
      task.transfer_from = prev.home !== home ? prev.home : prev.transfer_from || prev.home;
      task.transfer_claude = !!prev.transfer_claude || isClaude(prev);
      task.transfer_status = task.status;
      task.status = 'PAUSED';
      delete task.claude_desktop;
      await writeTask(dir, task);
      await this.finishTransfer(dir, task);
    } else {
      if (isClaude(task)) task.claude_desktop = DESKTOP.pending;
      else delete task.claude_desktop;
      await writeTask(dir, task);
      if (isClaude(task)) {
        task.claude_desktop = await this.toDesktop(task);
        await writeTask(dir, task);
      }
    }
    // as listed: where it lives and which apps run it
    return this.get(id, current !== undefined);
  }

  /** A destination stays paused until every old runner is retired; the file carries its retry intent. */
  async finishTransfer(dir, task) {
    const id = String(task.id);
    if (task.transfer_from === 'codex') await fs.promises.rm(path.join(this.o.codexDir(), id), { recursive: true, force: true });
    else if (dir === this.o.codexDir()) await fs.promises.rm(path.join(this.o.mopilotDir(), id), { recursive: true, force: true });
    if (task.transfer_claude && !isClaude(task)) {
      await this.fromDesktop(id);
      if (this.readPending(true).includes(id)) return;
    }
    const ready = { ...task, status: task.transfer_status };
    delete ready.transfer_from;
    delete ready.transfer_claude;
    delete ready.transfer_status;
    if (isClaude(ready)) ready.claude_desktop = await this.toDesktop(ready);
    await writeTask(dir, ready);
  }

  /** Remember a startup result against the current file, with no async gap between its check and write. */
  async rememberChat(started, chatId) {
    return this.mutate(String(started.id), () => this.rememberTask(started, chatId));
  }

  async rememberTask(started, chatId) {
    const id = String(started.id);
    if (!isTaskFolderId(id)) throw new Error(`"${id}" isn't a task id`);
    const dir = dirOf(this, started);
    let current;
    try {
      current = parse(fs.readFileSync(path.join(dir, id, 'automation.toml'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!canRememberChat(started, current)) return false;
    // writeTask writes atomically before yielding; no native registration is needed for this local metadata.
    await writeTask(dir, { ...current, id, target_thread_id: chatId, updated_at: this.now() });
    return true;
  }

  /** A task left MoPilot's folder (it is a Codex task now): its file goes, and Desktop's copy. */
  async leaveMopilot(id, prev) {
    if (!prev || prev.home === 'codex') return;
    await fs.promises.rm(path.join(this.o.mopilotDir(), id), { recursive: true, force: true });
    if (isClaude(prev)) await this.fromDesktop(id);
  }

  /** Register a Claude task in Claude Desktop now, or later when Desktop is open: what claude_desktop becomes. */
  async toDesktop(task) {
    if (!this.o.desktop.installed()) return undefined;
    if (await this.o.desktop.running()) return DESKTOP.pending;
    const removing = this.readPending(true).includes(String(task.id));
    const r = this.o.desktop.upsert(task);
    if (r.ok && removing) await this.finishRemovals(new Set([String(task.id)]));
    return r.ok ? DESKTOP.registered : DESKTOP[r.reason];
  }

  /** Take a task out of Claude Desktop now, or when Desktop next closes. */
  async fromDesktop(id) {
    if (!this.o.desktop.installed()) return;
    await this.writePending([...this.readPending(true), id]);
    if (!(await this.o.desktop.running()) && this.readPending(true).includes(id) && this.o.desktop.remove(id))
      await this.finishRemovals(new Set([id]));
  }

  /** Delete a task from wherever it lives. */
  async remove(id) {
    return this.mutate(String(id), () => this.removeTask(id));
  }

  async removeTask(id) {
    const sid = String(id);
    if (!isTaskFolderId(sid)) throw new Error(`"${sid}" isn't a task id`);
    const matches = (await this.list(sid)).tasks.filter((a) => String(a.id) === sid);
    if (matches.length > 1) throw new Error(`Scheduled task "${sid}" is ambiguous across task stores. Nothing was deleted.`);
    if (!matches.length) return;
    for (const home of new Set(matches.flatMap((a) => [a.home, a.transfer_from]))) {
      if (home === 'codex') await fs.promises.rm(path.join(this.o.codexDir(), sid), { recursive: true, force: true });
      else if (home === 'mopilot') await fs.promises.rm(path.join(this.o.mopilotDir(), sid), { recursive: true, force: true });
    }
    if (matches.some((a) => a.native_app === 'claude-desktop' || a.claude_desktop || a.transfer_claude)) await this.fromDesktop(sid);
  }

  /**
   * Catch Claude Desktop up while it is closed: registrations and removals that waited for it. The scheduler
   * calls this before each check.
   */
  async sync() {
    for (const dir of [this.o.codexDir(), this.o.mopilotDir()]) {
      for (const a of await readFolder(dir, () => {
        /* listing reports unreadable tasks */
      })) {
        if (a.transfer_from)
          await this.mutate(String(a.id), async () => {
            const current = await readTask(dir, a.id, this.log);
            if (current?.transfer_from) await this.finishTransfer(dir, current);
          });
      }
    }
    if (!this.o.desktop.installed() || (await this.o.desktop.running())) return;
    const removing = new Set(this.readPending(true));
    for (const id of removing)
      await this.mutate(id, async () => {
        if (this.readPending(true).includes(id) && this.o.desktop.remove(id)) await this.finishRemovals(new Set([id]));
      });
    for (const a of await readFolder(this.o.mopilotDir(), () => {
      /* a task that doesn't load is the list's to report */
    })) {
      if (!isClaude(a) || a.claude_desktop !== DESKTOP.pending) continue;
      await this.mutate(String(a.id), async () => {
        const current = await readTask(this.o.mopilotDir(), a.id, this.log);
        if (!current || !isClaude(current) || current.claude_desktop !== DESKTOP.pending) return;
        const r = this.o.desktop.upsert(current);
        await writeTask(this.o.mopilotDir(), { ...current, claude_desktop: r.ok ? DESKTOP.registered : DESKTOP[r.reason] });
      });
    }
  }

  /**
   * Move the tasks an earlier MoPilot wrote to $CODEX_HOME/automations for another harness into MoPilot's folder,
   * so the Codex app doesn't run them with Codex. Resolves to the ids moved.
   */
  async migrate() {
    const moved = [];
    for (const a of await readFolder(this.o.codexDir(), () => {
      /* a task that doesn't load is the list's to report */
    })) {
      if (codexOwned(a)) continue;
      const id = String(a.id);
      await this.mutate(id, async () => {
        const current = await readTask(this.o.codexDir(), id, this.log);
        if (!current || codexOwned(current)) return;
        await writeTask(this.o.mopilotDir(), current);
        await fs.promises.rm(path.join(this.o.codexDir(), id), { recursive: true, force: true });
        moved.push(id);
        this.log(`scheduled task ${id} (${current.harness}) moved out of the Codex app's folder`);
      });
    }
    return moved;
  }
}

/**
 * Where a task can run, for the Scheduled page: 'mopilot', 'codex-app', 'claude-desktop', and why Claude Desktop
 * doesn't have it when it doesn't.
 */
function runsIn(a) {
  if (a.transfer_from) return { apps: ['mopilot'], transfer: 'pending' };
  if (a.home === 'codex') return { apps: ['mopilot', 'codex-app'] };
  // a schedule MoPilot can't read (a Desktop cron with no RRULE) runs in Desktop only
  if (a.native_app === 'claude-desktop') return { apps: a.rrule ? ['mopilot', 'claude-desktop'] : ['claude-desktop'] };
  return { apps: ['mopilot'], ...(a.claude_desktop ? { desktop: a.claude_desktop } : {}) };
}

module.exports = { AutomationStore, readFolder, writeTask, runsIn, uniqueId, taskIdPrefix, DESKTOP, DERIVED };
