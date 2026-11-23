// Where a repository's environment config comes from: environment.toml, else Conductor's settings (local over shared), else legacy conductor.json.
const path = require('node:path');
const { parse, stringify } = require('smol-toml');
const { fs } = require('./ports/fs.cjs');
const { writeAtomic } = require('./fsutil.cjs');

/**
 * One resolver for a repository's setup script, cleanup script, actions and files to copy, so main (chat starts, restored
 * worktrees) and every window read the same answer. Exactly one file family supplies the scripts and actions:
 *
 *   1. `.codex/environments/environment.toml` (MoPilot's own, shared with Codex)
 *   2. `.conductor/settings.local.toml` over `.conductor/settings.toml` (Conductor; a key or run action the local file
 *      sets replaces the shared one)
 *   3. `conductor.json` (Conductor's legacy file, which Conductor itself ignores once a settings TOML exists)
 *
 * A family that is present owns the answer even when it can't be read: a broken environment.toml never falls through to
 * Conductor's scripts, and a broken settings TOML never falls through to a stale conductor.json. The files to copy are
 * resolved apart from the scripts (`.worktreeinclude`, else Conductor's `file_include_globs`, else `.env*` where a
 * Conductor config exists), so converting to environment.toml keeps them.
 *
 * Conductor's formats, from https://www.conductor.build/docs/reference/scripts, /docs/reference/conductor-json and
 * /docs/reference/files-to-copy. Unknown keys are ignored.
 */

/** @typedef {{ name: string, icon: 'tool' | 'run' | 'debug' | 'test' | null, command: string, platform?: string }} EnvAction */
/** @typedef {'environment' | 'conductor' | 'conductor-json' | null} EnvSource */
/**
 * @typedef {object} ResolvedEnvironment
 * @property {string} setup this platform's setup script, trimmed ('' for none)
 * @property {string} cleanup this platform's cleanup script, trimmed ('' for none)
 * @property {EnvAction[]} actions this platform's actions
 * @property {string[]} copy gitignore-style patterns of ignored files a new worktree should get (nothing copies them here)
 * @property {'worktreeinclude' | 'conductor' | 'default' | null} copySource where `copy` came from
 * @property {EnvSource} source the family that supplies the scripts and actions, null when the repository has none
 * @property {string[]} files the files of that family that were read, most specific first
 * @property {string | null} error why environment.toml, which is there, could not be read (its scripts are then empty)
 * @property {string | null} copyError why `.worktreeinclude`, which is there, could not be read (the next source of `copy` is used)
 * @property {{ file: string, reason: string }[]} unreadable Conductor config that was found but could not be used
 * @property {string} notice "Found Conductor config we couldn't read: ..." for `unreadable`, '' when there is none
 */

const ICONS = new Set(['tool', 'run', 'debug', 'test']);
const environmentFile = (repo) => path.join(repo, '.codex', 'environments', 'environment.toml');
const conductorLocalFile = (repo) => path.join(repo, '.conductor', 'settings.local.toml');
const conductorSharedFile = (repo) => path.join(repo, '.conductor', 'settings.toml');
const conductorJsonFile = (repo) => path.join(repo, 'conductor.json');
const worktreeIncludeFile = (repo) => path.join(repo, '.worktreeinclude');

const isTable = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// a failure may be any thrown value (not only an Error): it is still a failure, never an absent file
// with no message (an empty one included) the thrown value names itself, so a reason is never ''
const firstLine = (error) => String(error?.message || error).split('\n')[0] || 'unreadable';

/**
 * A file's text, null when it isn't there, or why it couldn't be read.
 * @returns {{ text: string } | { reason: string } | null}
 */
function readText(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    return { reason: firstLine(error) };
  }
}

/** The patterns of a gitignore-style list: one per line, without blank lines and comments. */
const patternsOf = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

// ---- environment.toml

/** This platform's script of a `[setup]` / `[cleanup]` table: its own entry, else the shared one. */
const platformScript = (table, platform) => String(table?.[platform]?.script ?? table?.script ?? '').trim();

/** @returns {EnvAction[]} this platform's actions, as the file lists them */
function environmentActions(list, platform) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => isTable(a) && (!a.platform || a.platform === platform))
    .map((a) => ({
      name: String(a.name ?? ''),
      icon: ICONS.has(a.icon) ? a.icon : null,
      command: String(a.command ?? ''),
      ...(a.platform ? { platform: String(a.platform) } : {}),
    }));
}

// ---- Conductor

/**
 * One argument as a shell word: POSIX quoting (Conductor runs its scripts in zsh, and bash in its cloud), and
 * PowerShell's on Windows, where MoPilot runs actions in powershell.exe (always quoted there: a bare `a,b` is an array).
 */
const shellWord = (arg, platform) =>
  platform === 'win32' ? `'${arg.replace(/'/g, "''")}'` : /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** `command` run in `cwd`, and only when the folder could be entered. */
const inFolder = (cwd, command, platform) =>
  platform === 'win32'
    ? `Set-Location -LiteralPath ${shellWord(cwd, platform)}; if ($?) { ${command} }`
    : `cd -- ${shellWord(cwd, platform)} && ${command}`;

/**
 * What one Conductor settings document sets, keeping only the keys it sets and only values of the documented type; a
 * known key of another type is reported (never taken for unset in silence).
 * @param {any} doc the parsed TOML or JSON
 * @param {(reason: string) => void} problem
 * @returns {{ setup?: string, archive?: string, run?: string | Record<string, Record<string, unknown>>, globs?: string[] }}
 */
function conductorView(doc, problem) {
  /** @type {ReturnType<typeof conductorView>} */
  const view = {};
  if (!isTable(doc)) {
    problem('it is not a table of settings');
    return view;
  }
  const scripts = doc.scripts;
  if (scripts !== undefined && !isTable(scripts)) problem('`scripts` is not a table');
  else if (scripts) {
    for (const key of /** @type {const} */ (['setup', 'archive'])) {
      if (typeof scripts[key] === 'string') view[key] = scripts[key];
      else if (scripts[key] !== undefined) problem(`\`scripts.${key}\` is not a string`);
    }
    const run = scripts.run;
    if (typeof run === 'string') view.run = run;
    else if (isTable(run)) {
      view.run = {};
      for (const [id, action] of Object.entries(run)) {
        if (isTable(action)) {
          // a command of another type is reported and left out, so it neither runs nor hides the shared file's
          const { command, ...rest } = action;
          if (command !== undefined && typeof command !== 'string') problem(`\`scripts.run.${id}.command\` is not a string`);
          const kept = typeof command === 'string' ? { ...rest, command } : rest;
          // defined, not assigned: an id such as `__proto__` is an action like any other
          Object.defineProperty(view.run, id, { value: kept, enumerable: true, configurable: true, writable: true });
        } else problem(`\`scripts.run.${id}\` is not a table`);
      }
    } else if (run !== undefined) problem('`scripts.run` is neither a command nor a table of actions');
  }
  const globs = doc.file_include_globs;
  if (typeof globs === 'string') view.globs = patternsOf(globs);
  else if (Array.isArray(globs) && globs.every((g) => typeof g === 'string')) view.globs = patternsOf(globs.join('\n'));
  else if (globs !== undefined) problem('`file_include_globs` is not a list of patterns');
  return view;
}

/** `over`'s settings on top of `base`'s: a key it sets wins, and run actions are matched by id. */
function layered(base, over) {
  const out = { ...base, ...over };
  if (isTable(base.run) && isTable(over.run)) {
    out.run = Object.fromEntries([
      ...Object.entries(base.run),
      ...Object.entries(over.run).map(([id, action]) => [id, { ...(Object.hasOwn(base.run, id) ? base.run[id] : {}), ...action }]),
    ]);
  }
  return out;
}

/** Whether a run action is offered on a local machine (`available_in` unset, "local", or a list with it). */
const availableHere = (v) => v === undefined || v === 'local' || (Array.isArray(v) && v.includes('local'));

/**
 * Conductor's run scripts as actions with the run icon: the legacy single command, or each `[scripts.run.<id>]` that is
 * shown locally and has a command, the default one first (the first action is the one a shortcut runs).
 * @returns {EnvAction[]}
 */
function conductorActions(run, platform) {
  if (typeof run === 'string') return run.trim() ? [{ name: 'Run', icon: 'run', command: run.trim() }] : [];
  const actions = [];
  for (const [id, a] of Object.entries(run ?? {})) {
    if (a.hide === true || !availableHere(a.available_in) || typeof a.command !== 'string' || !a.command.trim()) continue;
    const args = Array.isArray(a.args) ? a.args.filter((x) => typeof x === 'string').map((x) => shellWord(x, platform)) : [];
    const cwd = isTable(a.options) && typeof a.options.cwd === 'string' && a.options.cwd ? a.options.cwd : null;
    const command = [a.command.trim(), ...args].join(' ');
    const action = {
      name: id,
      icon: /** @type {const} */ ('run'),
      command: cwd ? inFolder(cwd, command, platform) : command,
      // quoted words and the folder change are this platform's shell syntax: say so, so a converted file keeps it
      ...(cwd || args.length ? { platform } : {}),
    };
    if (a.default === true) actions.unshift(action);
    else actions.push(action);
  }
  return actions;
}

/**
 * Conductor's settings for `repo`: its TOML files layered, else its legacy JSON, null when it has neither.
 * @returns {{ source: 'conductor' | 'conductor-json', files: string[], view: ReturnType<typeof conductorView>,
 *   unreadable: { file: string, reason: string }[] } | null}
 */
function conductorConfig(repo) {
  const unreadable = [];
  /** @returns {{ file: string, view: ReturnType<typeof conductorView> } | null | undefined} null: absent; undefined: unreadable */
  const load = (file, decode) => {
    const read = readText(file);
    if (!read) return null;
    const problem = (reason) => unreadable.push({ file, reason });
    if ('reason' in read) return void problem(read.reason);
    let doc;
    try {
      doc = decode(read.text);
    } catch (error) {
      return void problem(firstLine(error));
    }
    return { file, view: conductorView(doc, problem) };
  };
  const local = load(conductorLocalFile(repo), parse);
  const shared = load(conductorSharedFile(repo), parse);
  if (local !== null || shared !== null) {
    const used = [local, shared].filter((x) => !!x);
    return {
      source: 'conductor',
      files: used.map((x) => x.file),
      view: layered(shared?.view ?? {}, local?.view ?? {}),
      unreadable,
    };
  }
  const legacy = load(conductorJsonFile(repo), JSON.parse);
  if (legacy === null) return null;
  return {
    source: 'conductor-json',
    files: legacy ? [legacy.file] : [],
    view: legacy?.view ?? {},
    unreadable,
  };
}

// ---- the resolver

/**
 * The environment config of `repo` for `platform`. Never throws: what couldn't be read is in `error` and `unreadable`.
 * @param {string} repo
 * @param {string} [platform]
 * @returns {ResolvedEnvironment}
 */
function resolveEnvironment(repo, platform = process.platform) {
  const out = resolved(repo, platform);
  if (out.unreadable.length)
    out.notice = `Found Conductor config we couldn't read: ${out.unreadable.map((u) => `${u.file} (${u.reason})`).join('; ')}`;
  return out;
}

/** @returns {ResolvedEnvironment} without its notice */
function resolved(repo, platform) {
  const conductor = conductorConfig(repo);
  /** @type {ResolvedEnvironment} */
  const out = {
    setup: '',
    cleanup: '',
    actions: [],
    copy: [],
    copySource: null,
    copyError: null,
    source: null,
    files: [],
    error: null,
    unreadable: conductor?.unreadable ?? [],
    notice: '',
  };

  const include = readText(worktreeIncludeFile(repo));
  if (include && 'text' in include)
    Object.assign(out, {
      copy: patternsOf(include.text),
      copySource: 'worktreeinclude',
    });
  else if (conductor?.view.globs) Object.assign(out, { copy: conductor.view.globs, copySource: 'conductor' });
  else if (conductor) Object.assign(out, { copy: ['.env*'], copySource: 'default' });
  // not Conductor's file and not a script source: whoever copies the files reports it
  if (include && 'reason' in include) out.copyError = `${worktreeIncludeFile(repo)} couldn't be read (${include.reason})`;

  const own = readText(environmentFile(repo));
  if (own) {
    out.source = 'environment';
    out.files = [environmentFile(repo)];
    // Conductor's files supply only the files to copy here: without that, their problems are not this repository's
    if (out.copySource !== 'conductor' && out.copySource !== 'default') out.unreadable = [];
    if ('reason' in own) out.error = own.reason;
    else {
      try {
        const t = /** @type {any} */ (parse(own.text));
        out.setup = platformScript(t.setup, platform);
        out.cleanup = platformScript(t.cleanup, platform);
        out.actions = environmentActions(t.actions, platform);
      } catch (error) {
        out.error = `${environmentFile(repo)} isn't valid TOML (${firstLine(error)}). Fix it in a text editor`;
      }
    }
    return out;
  }
  if (conductor) {
    out.source = conductor.source;
    out.files = conductor.files;
    out.setup = (conductor.view.setup ?? '').trim();
    out.cleanup = (conductor.view.archive ?? '').trim();
    out.actions = conductorActions(conductor.view.run, platform);
  }
  return out;
}

/**
 * Write `repo`'s environment.toml from the Conductor config it resolves to now. Refused when the repository already has
 * an environment.toml (never overwritten), has no Conductor config, or has Conductor config that couldn't be read
 * (the new file would take over with part of it missing).
 * @returns {{ ok: true, file: string } | { ok: false, error: string }}
 */
function convertToEnvironment(repo, platform = process.platform) {
  const from = resolveEnvironment(repo, platform);
  const file = environmentFile(repo);
  if (from.source === 'environment') return { ok: false, error: `${file} already exists` };
  if (!from.source)
    return {
      ok: false,
      error: 'This project has no Conductor config to convert',
    };
  if (from.notice) return { ok: false, error: from.notice };
  const doc = {
    version: 1,
    name: path.basename(repo),
    setup: { script: from.setup },
    ...(from.cleanup ? { cleanup: { script: from.cleanup } } : {}),
    ...(from.actions.length ? { actions: from.actions } : {}),
  };
  try {
    // the resolve above found no environment.toml (the only way here), so this publishes a new file whole
    writeAtomic(file, `${stringify(doc)}\n`, fs);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: firstLine(error) };
  }
}

module.exports = { resolveEnvironment, convertToEnvironment };
