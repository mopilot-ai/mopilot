// IPC for harness install and update runs (electron/harness/harnessRuns.cjs): what this machine has for the install
// lines, the runs under way in every window, the terminal each one runs in, and harness updates (harnessUpdates.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageOutput } = require('../../harness/packageOutput.cjs');
const { HarnessRuns } = require('../../harness/harnessRuns.cjs');
const { installTools } = require('../../harness/installTools.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { spawnQuiet } = require('../../harness/quietRun.cjs');
const { ensureRetirementMonitor } = require('../../platform/processIdentity.cjs');
const { registerUpdates } = require('./harnessUpdates.cjs');
const RUNS = new WeakMap();
const { forgetTool, toolCandidates } = require('../../platform/userTools.cjs');
const { forgetUserDirs } = require('../../platform/userDirs.cjs');
const { resolveBasic } = require('../../harness/detect.cjs');

/**
 * What main looks at again once a harness's run ends, per family, so it is found with no window open: a basic
 * harness by its admission check, Codex by starting its app-server again when it isn't running. Claude Code has no
 * main-side state to refresh; each window detects it again when it hears the run ended.
 * @type {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, (deps: { live: any, server: any }, basic: string | null) => unknown>}
 */
const AFTER_EXIT = {
  // only an app-server that isn't up (it had no binary to start): a running one may be mid-turn
  codex: ({ server }) => {
    if (server.status === 'running') return;
    server.stop();
    server.start();
  },
  claude: () => undefined,
  acp: ({ live }, basic) => live.acpAdmission.refresh({ force: true, only: basic }),
};

/** @param {{ live: any, server: any }} deps */
const afterExit = (deps) => async (/** @type {string} */ kind) => {
  const k = parseKind(kind);
  if (!k) return;
  // an install may have made the folder it put the binary in (~/.local/bin): the folders are looked at again
  forgetTool();
  await AFTER_EXIT[k.family](deps, k.basic);
};

/**
 * A binary that can be run, as path, size and change time (an install that rewrites or chmods it reads as new); null for
 * one missing, not a file, or not executable yet (a download under way).
 * @param {string} p
 * @returns {string | null}
 */
function binSig(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    const st = fs.statSync(p);
    return st.isFile() ? `${p}:${st.size}:${st.ctimeMs}` : null;
  } catch {
    return null;
  }
}

/** A first-class harness's binary: the login shell's PATH, the user-tool folders (made or not), and its own install's. */
const firstClassBin = (/** @type {string} */ name, /** @type {string} */ own) => (/** @type {(p: string) => string | null} */ sig) => {
  for (const p of toolCandidates([name], [path.join(os.homedir(), own)])) {
    const s = sig(p);
    if (s) return s;
  }
  return null;
};

/**
 * A family's binary that can be run, per family: Codex and Claude Code by their names, a basic harness by its own path
 * from Settings, else its search.
 * @type {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, (sig: (p: string) => string | null, basic: string, deps: { shellEnv: any, readState?: () => any }) => string | null>}
 */
const FIND = {
  codex: firstClassBin('codex', '.codex/bin/codex'),
  claude: firstClassBin('claude', '.claude/local/claude'),
  acp: (sig, basic, { shellEnv, readState }) => {
    const p = resolveBasic(basic, {
      manual: readState?.().prefs?.acpBins?.[basic],
      which: (b) => shellEnv.which(b),
      exists: (x) => !!sig(x),
    });
    return p ? sig(p) : null;
  },
};

/**
 * `kind`'s binary on this machine now, as binSig says it (null: none that runs): what an open install row asks every
 * few seconds (an install in the user's own terminal), far cheaper than looking for the harness again, which starts
 * Codex or checks a basic harness. Only the folder list is looked at again; the versions main keeps stay.
 * @param {string} kind
 * @param {{ shellEnv: any, readState?: () => any }} deps
 */
function found(kind, deps, sig = binSig) {
  const k = parseKind(kind);
  if (!k) return null;
  forgetUserDirs();
  return FIND[k.family](sig, k.basic ?? '', deps);
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps
 */
function register(ipcMain, deps, o = {}) {
  const { live, server, shellEnv, broadcastAll } = deps;
  const quiet = (argv, q, handlers) => {
    if (!o.spawnQuiet) ensureRetirementMonitor();
    return (o.spawnQuiet ?? spawnQuiet)(argv, { ...q, env: { ...shellEnv.childEnv(), ...q.env } }, handlers);
  };
  const runs = new HarnessRuns({
    pty: o.pty ?? packageOutput(quiet),
    home: () => os.homedir(),
    broadcast: broadcastAll,
    afterExit: afterExit({ live, server }),
    // an update nobody watches (Update all) runs in the login shell's environment, with its own on top
    spawnQuiet: quiet,
  });
  RUNS.set(ipcMain, runs);
  if (deps.app) RUNS.set(deps.app, runs);
  ipcMain.handle('harnessRuns:tools', () => installTools({ which: (n) => shellEnv.which(n), env: shellEnv.childEnv() }));
  ipcMain.handle('harnessRuns:list', () => runs.list());
  ipcMain.handle('harnessRuns:find', (_e, kind) => (o.found ?? found)(String(kind), deps));
  ipcMain.handle('harnessRuns:start', (_e, kind, index, size) => runs.start(String(kind), index, size ?? {}));
  ipcMain.handle('harnessRuns:attach', (_e, id) => runs.attach(id));
  ipcMain.on('harnessRuns:write', (_e, id, data) => runs.write(id, data));
  ipcMain.on('harnessRuns:resize', (_e, id, cols, rows) => runs.resize(id, cols, rows));
  ipcMain.handle('harnessRuns:stop', (_e, id) => runs.stopAndWait(id));
  ipcMain.handle('harnessRuns:dismiss', (_e, id) => runs.dismiss(id));
  // updates go through these same runs (one per harness, one per package manager)
  runs.updates = (o.registerUpdates ?? registerUpdates)(ipcMain, deps, runs, o.updates);
  return runs;
}

module.exports = { register, afterExit, found, binSig, runsFor: (ipcMain) => RUNS.get(ipcMain) };
