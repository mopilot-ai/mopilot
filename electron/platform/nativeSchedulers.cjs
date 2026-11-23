// The native apps that also run scheduled tasks (the Codex app, Claude Desktop): is one open, what it already ran, and recording MoPilot's runs in its store.
// Neither app knows MoPilot's run ledger, so the scheduler (electron/platform/scheduler.cjs) leaves a task to its
// native app while that app is open, and when MoPilot runs it instead it writes the run into the app's own store
// first, so the app does not run the same time again when it opens. Each store is read for the fields this needs
// only; a store whose shape isn't recognized reads as {ok: false}, and the scheduler then leaves the task alone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { coreCall } = require('./core.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { writePrivate, readJson } = require('./fsutil.cjs');
const { fromCron, toCron, scheduleTime } = require('../../shared/schedule.mjs');
const { isTaskFolderId } = require('../../shared/scheduleTask.mjs');

/**
 * The files the user's processes run, one per line ('' when they can't be read): from the core on macOS, which names no
 * file on Linux, where no app here runs, and has no command lines on Windows, where PowerShell lists them.
 * @param {string} [platform]
 * @param {{ exec?: typeof childProcess.execFile, call?: typeof coreCall }} [o]
 */
async function processList(platform = process.platform, { exec = childProcess.execFile, call = coreCall } = {}) {
  if (platform !== 'win32') {
    let rows;
    try {
      rows = await call('proc.commands');
    } catch (error) {
      // the table can't be read now: no app reads as open, as when PowerShell fails
      noteIgnored('list the files processes run', error);
      return '';
    }
    // a folder's name can hold a line break, and what follows one is no process
    return Array.isArray(rows) ? rows.flatMap((r) => (r[3] ? [r[3].replace(/[\r\n]+/g, ' ')] : [])).join('\n') : '';
  }
  return new Promise((resolve) => {
    exec(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-Process | ForEach-Object { $_.Path }'],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout)),
    );
  });
}

/** Whether a line of `processList` is one of an app's main executables. */
const matches = (list, patterns) => list.split(/\r?\n/).some((line) => patterns.some((p) => p.test(line.trim())));

/** The executables each app runs as: its main process only, never helpers or the CLIs it bundles. */
const APP_PROCESS = {
  'codex-app': [/\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/(ChatGPT|Codex)$/, /\\OpenAI[^\\]*\\.*\\(ChatGPT|Codex)\.exe$/i],
  'claude-desktop': [/\/Claude\.app\/Contents\/MacOS\/Claude$/, /\\AnthropicClaude\\.*\\claude\.exe$/i],
};

/**
 * The Codex app: tasks are $CODEX_HOME/automations/<id>/automation.toml (shared with MoPilot); what it ran is in
 * $CODEX_HOME/sqlite/codex-dev.db, table automations (last_run_at, next_run_at, next_run_nominal_at).
 * @param {object} o
 * @param {() => string} o.codexHome
 * @param {() => Promise<string>} [o.processes]
 * @param {(file: string, readOnly: boolean) => any} [o.openDb] a node:sqlite DatabaseSync
 */
function codexApp(o) {
  const processes = o.processes ?? (() => processList());
  const openDb = o.openDb ?? ((file, readOnly) => new (require('node:sqlite').DatabaseSync)(file, { readOnly }));
  const file = () => path.join(o.codexHome(), 'sqlite', 'codex-dev.db');
  const COLUMNS = ['id', 'status', 'last_run_at', 'next_run_at', 'next_run_nominal_at'];
  /** Run `fn` with the database open, closing it after; a missing or unexpected schema throws. */
  function withDb(readOnly, fn) {
    const db = openDb(file(), readOnly);
    try {
      const cols = new Set(
        db
          .prepare('PRAGMA table_info(automations)')
          .all()
          .map((c) => c.name),
      );
      if (!COLUMNS.every((c) => cols.has(c))) throw new Error('unrecognized automations table');
      return fn(db);
    } finally {
      db.close();
    }
  }
  return {
    id: 'codex-app',
    label: 'the Codex app',
    installed: () => fs.existsSync(file()),
    running: async () => matches(await processes(), APP_PROCESS['codex-app']),
    /** {ok, tasks: Map<id, {active, through}>}: `through` is the last scheduled time the app counts as handled. */
    read() {
      if (!this.installed()) return { ok: true, tasks: new Map() };
      try {
        return withDb(true, (db) => {
          const tasks = new Map();
          for (const r of db.prepare(`SELECT ${COLUMNS.join(', ')} FROM automations`).all()) {
            const nominal = scheduleTime(r.next_run_nominal_at, null);
            const last = scheduleTime(r.last_run_at, null);
            if (nominal === null || last === null) throw new Error('Invalid scheduled-task watermark');
            // the app's next nominal time is the first it hasn't handled; with none, its last run
            tasks.set(String(r.id), { active: r.status === 'ACTIVE', through: nominal ? nominal - 1 : last });
          }
          return { ok: true, tasks };
        });
      } catch {
        return { ok: false, tasks: new Map() };
      }
    },
    /** The runs the app made of a task, newest first: {scheduledFor (when it started), chatId (its thread)}. */
    runs(id, limit = 20) {
      if (!this.installed()) return [];
      try {
        const db = openDb(file(), true);
        try {
          return db
            .prepare('SELECT thread_id, created_at FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(String(id), limit)
            .map((r) => ({
              taskId: String(id),
              scheduledFor: Number(r.created_at),
              status: 'started',
              chatId: String(r.thread_id),
              by: 'codex-app',
            }));
        } finally {
          db.close();
        }
      } catch {
        return [];
      }
    },
    /** Record that MoPilot ran `scheduledFor` (the app is closed): the app's next time becomes `next`. */
    markHandled(id, scheduledFor, next, now) {
      try {
        return withDb(false, (db) => {
          db.exec('PRAGMA busy_timeout = 5000');
          const r = db
            .prepare('UPDATE automations SET last_run_at = ?, next_run_at = ?, next_run_nominal_at = ? WHERE id = ?')
            .run(now, next, next, String(id));
          return Number(r.changes) > 0;
        });
      } catch {
        return false;
      }
    },
  };
}

/** Claude Desktop's data folder on this platform. */
function claudeAppData(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}

/** A SKILL.md: its frontmatter fields and the prompt after it. */
function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return { meta, prompt: (m ? text.slice(m[0].length) : text).trim() };
}

/** One line of YAML frontmatter, quoted when it needs to be. */
const yamlLine = (s) => {
  const t = String(s)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return /^[\w .,()-]*$/.test(t) && t ? t : JSON.stringify(t);
};

/**
 * Claude Desktop's local scheduled tasks: the prompt is ~/.claude/scheduled-tasks/<id>/SKILL.md; the schedule,
 * folder and what ran are in the signed-in account's claude-code-sessions/<account>/<org>/scheduled-tasks.json.
 * @param {object} o
 * @param {() => string} [o.appData] Claude Desktop's data folder
 * @param {() => string} [o.tasksDir] the folder of SKILL.md tasks ($CLAUDE_CONFIG_DIR or ~/.claude, + scheduled-tasks)
 * @param {() => Promise<string>} [o.processes]
 */
function claudeDesktop(o = {}) {
  const appData = o.appData ?? (() => claudeAppData());
  const tasksDir = o.tasksDir ?? (() => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'scheduled-tasks'));
  const processes = o.processes ?? (() => processList());

  /** The signed-in account's scheduled-tasks.json, or null when it can't be told apart. */
  function storeFile() {
    const account = readJson(path.join(appData(), 'config.json'))?.lastKnownAccountUuid;
    if (typeof account !== 'string' || !account) return null;
    const dir = path.join(appData(), 'claude-code-sessions', account);
    let orgs = [];
    try {
      orgs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return null;
    }
    const withStore = orgs
      .map((e) => path.join(dir, e.name, 'scheduled-tasks.json'))
      .filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (withStore.length) return withStore[0];
    return orgs.length === 1 ? path.join(dir, orgs[0].name, 'scheduled-tasks.json') : null;
  }
  const valid = (d) =>
    !!d &&
    typeof d === 'object' &&
    Array.isArray(d.scheduledTasks) &&
    d.scheduledTasks.every(
      (t) =>
        t &&
        isTaskFolderId(t.id) &&
        typeof t.cronExpression === 'string' &&
        (t.lastScheduledFor == null ||
          (typeof t.lastScheduledFor === 'string' && scheduleTime(Date.parse(t.lastScheduledFor), null) !== null)),
    );
  /**
   * {ok, file, data}: the store as it is, or an empty one when the account has none yet. `file` is set when ok.
   * @returns {{ok: boolean, file: string, data: any}}
   */
  function load() {
    const file = storeFile();
    if (!file) return { ok: false, file: '', data: null };
    if (!fs.existsSync(file)) return { ok: true, file, data: { scheduledTasks: [] } };
    const data = readJson(file);
    return valid(data) ? { ok: true, file, data } : { ok: false, file, data: null };
  }
  const skillFile = (id) => {
    if (!isTaskFolderId(id)) throw new Error(`"${id}" isn't a task id`);
    return path.join(tasksDir(), id, 'SKILL.md');
  };

  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    installed: () => fs.existsSync(path.join(appData(), 'claude-code-sessions')),
    running: async () => matches(await processes(), APP_PROCESS['claude-desktop']),
    read() {
      if (!this.installed()) return { ok: true, tasks: new Map() };
      const s = load();
      const tasks = new Map();
      for (const t of s.data?.scheduledTasks ?? []) {
        tasks.set(t.id, { active: t.enabled !== false, through: Date.parse(t.lastScheduledFor ?? '') || 0 });
      }
      return { ok: s.ok, tasks };
    },
    /**
     * Desktop's tasks as MoPilot tasks (a schedule cron can't say this app's way reads with no rule). A task whose
     * SKILL.md can't be read still lists, with no prompt, and `onError` says why.
     * @param {(message: string) => void} onError
     * @param {string} [strictId] reject unreadable state or this task's prompt before an edit
     * @param {boolean} [allowUnavailable] an unregistered local task remains editable without a recognized native store
     */
    list(onError, strictId, allowUnavailable = false) {
      if (!this.installed()) return [];
      const state = load();
      if (strictId !== undefined && !allowUnavailable && !state.ok) throw new Error('Claude Desktop scheduled-task state is unreadable');
      const out = [];
      for (const t of state.data?.scheduledTasks ?? []) {
        let skill = { meta: {}, prompt: '' };
        try {
          skill = parseSkill(fs.readFileSync(t.filePath || skillFile(t.id), 'utf8'));
        } catch (e) {
          if (t.id === strictId) throw e;
          // a file read fails with an Error
          onError(`Couldn't read the prompt of Claude Desktop task "${t.id}": ${/** @type {Error} */ (e).message}`);
        }
        out.push({
          version: 1,
          id: t.id,
          kind: 'cron',
          name: t.displayName || skill.meta.name || t.id,
          prompt: skill.prompt,
          status: t.enabled === false ? 'PAUSED' : 'ACTIVE',
          rrule: fromCron(t.cronExpression) ?? '',
          cron: t.cronExpression,
          harness: 'claude',
          execution_environment: t.useWorktree ? 'worktree' : 'local',
          ...(t.cwd ? { cwds: [t.cwd] } : {}),
          created_at: Number(t.createdAt) || undefined,
        });
      }
      return out;
    },
    /** Record that MoPilot ran `scheduledFor` (Desktop is closed). */
    markHandled(id, scheduledFor, _next, now) {
      const s = load();
      const t = s.data?.scheduledTasks.find((x) => x.id === id);
      if (!s.ok || !t) return false;
      t.lastRunAt = new Date(now).toISOString();
      t.lastScheduledFor = new Date(scheduledFor).toISOString();
      writePrivate(s.file, JSON.stringify(s.data, null, 2));
      return true;
    },
    /**
     * Add or update a task in Desktop (Desktop is closed). Resolves to {ok} or {ok: false, reason}: 'schedule'
     * (cron can't say the rule), 'store' (the store isn't recognized).
     */
    upsert(a) {
      const cron = toCron(String(a.rrule ?? ''));
      if (!cron) return { ok: false, reason: 'schedule' };
      const s = load();
      if (!s.ok) return { ok: false, reason: 'store' };
      const id = String(a.id);
      const file = skillFile(id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${yamlLine(id)}\ndescription: ${yamlLine(a.name || id)}\n---\n\n${String(a.prompt ?? '')}\n`);
      const prev = s.data.scheduledTasks.find((x) => x.id === id);
      const entry = {
        ...prev,
        id,
        displayName: String(a.name || id),
        cronExpression: cron,
        enabled: a.status === 'ACTIVE',
        filePath: file,
        createdAt: prev?.createdAt ?? (Number(a.created_at) || Date.now()),
        ...(a.cwds?.[0] ? { cwd: a.cwds[0] } : {}),
        useWorktree: a.execution_environment === 'worktree',
      };
      s.data.scheduledTasks = [...s.data.scheduledTasks.filter((x) => x.id !== id), entry];
      fs.mkdirSync(path.dirname(s.file), { recursive: true });
      writePrivate(s.file, JSON.stringify(s.data, null, 2));
      return { ok: true };
    },
    /** Remove a task from Desktop (Desktop is closed); its SKILL.md folder too. */
    remove(id) {
      const file = skillFile(id);
      const s = load();
      if (!s.ok) return false;
      if (s.data.scheduledTasks.some((x) => x.id === id)) {
        s.data.scheduledTasks = s.data.scheduledTasks.filter((x) => x.id !== id);
        writePrivate(s.file, JSON.stringify(s.data, null, 2));
      }
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      return true;
    },
  };
}

module.exports = { codexApp, claudeDesktop, claudeAppData, processList, parseSkill, APP_PROCESS };
