// IPC for harness updates (electron/harness/harnessUpdates.cjs): each installed harness's version and update, read
// from what detection already found (Codex's binaries, Claude Code's CLI, ACP admission), checked once a day in main.
// Registered by electron/app/ipc/harnessRuns.cjs, which owns the runs an update goes through.
const { fs } = require('../../platform/ports/fs.cjs');
const { proc: childProcess } = require('../../platform/ports/proc.cjs');
const { HarnessUpdates, lastLines } = require('../../harness/harnessUpdates.cjs');
const { howInstalled, hostIo } = require('../../harness/installMethod.cjs');
const { createLatest, parseVersion } = require('../../harness/latestVersion.cjs');
const { versionStatus } = require('../../harness/versions.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { spawnArgs } = require('../../platform/winbin.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * What moves to a harness's new binary after an update, per family, once no chat is mid-turn on it: Codex's one
 * app-server. Claude Code starts its CLI per session and a basic harness its agent per chat, so their next ones run
 * the new binary with nothing to restart.
 * @type {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, (deps: { server: any }) => unknown>}
 */
const RESTART = {
  codex: ({ server }) => {
    server.stop();
    server.start();
  },
  claude: () => undefined,
  acp: () => undefined,
};

/** How long the run after an update may take: a busy machine's first start of a CLI just written. */
const HEALTH_TIMEOUT_MS = 30_000;

/**
 * The installed harnesses and the binary chats run, from what each one's detection already found.
 * @param {{ codexBinaries: () => Promise<{ candidates: { path: string, version: string | null }[], current: string }>,
 *   claude: { findBinary: (o?: string) => Promise<string | null>, versionOf: (bin: string) => Promise<string | null> },
 *   live: any, readState: () => any }} d
 */
const installedOf = (d) => async () => {
  const [codex, claude] = await Promise.all([
    d.codexBinaries().catch((error) => {
      noteIgnored('list the Codex binaries for updates', error);
      return null;
    }),
    d.claude
      .findBinary(d.readState().prefs?.claudeBin ?? undefined)
      .then(async (bin) => (bin ? { kind: 'claude', bin, version: await d.claude.versionOf(bin) } : null))
      .catch((error) => {
        noteIgnored('find Claude Code for updates', error);
        return null;
      }),
  ]);
  const out = [];
  const current = codex?.candidates.find((c) => c.path === codex.current);
  if (current) out.push({ kind: 'codex', bin: current.path, version: current.version });
  if (claude) out.push(claude);
  for (const h of d.live.acpAdmission?.list() ?? [])
    if (h.state !== 'missing' && h.bin) out.push({ kind: `acp:${h.id}`, bin: h.bin, version: h.version ?? null });
  return out;
};

/**
 * The chats mid-turn whose current harness is `kind` (an update would change the binary under them).
 * @param {any} live
 */
const busyChatsOf = (live) => (/** @type {string} */ kind) => {
  const want = parseKind(kind);
  const out = [];
  for (const id of live.sessions?.all() ?? []) {
    const s = live.sessions.get(id);
    if (s?.turn !== 'running' && s?.turn !== 'awaitingUser') continue;
    let ref;
    try {
      ref = parseKind(live.controller.ref(id).kind);
    } catch (error) {
      // a chat whose segment can't be read is not one this update can name
      noteIgnored('read a chat’s harness for an update', error);
      continue;
    }
    if (ref?.family === want?.family && ref?.basic === want?.basic)
      out.push({ id, title: String(live.chats?.records.get(id)?.meta?.title ?? 'Untitled chat') });
  }
  return out;
};

/** `bin --version` after an update: the version it says, or why it doesn't run. A run that can't start, times out or
 * can't find its interpreter (127) says nothing about the update and is not called broken. */
function health(bin, env, { execFile = childProcess.execFile, childEnv } = /** @type {any} */ ({})) {
  return new Promise((resolve) => {
    const [file, args, options] = spawnArgs(bin, ['--version'], {
      env: { ...childEnv(), ...(env ?? {}), NO_COLOR: '1', CLINE_NO_AUTO_UPDATE: '1' },
      timeout: HEALTH_TIMEOUT_MS,
      windowsHide: true,
    });
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      const version = parseVersion(out);
      const code = typeof error?.code === 'number' ? error.code : 0;
      const broken = error && !version && code > 0 && code !== 127 && !error.killed ? lastLines(out, 2) || `exit status ${code}` : null;
      resolve({ version, broken });
    });
    child.stdin?.end();
  });
}

/** An npm install's version, from the package.json in its global folder (no process). */
function packageVersion(file, read = fs.readFileSync) {
  try {
    const v = JSON.parse(read(file, 'utf8')).version;
    return typeof v === 'string' ? parseVersion(v) : null;
  } catch (error) {
    noteIgnored('read an installed package’s version', error, ['ENOENT']);
    return null;
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {any} deps the IPC deps (electron/main.cjs)
 * @param {InstanceType<typeof import('../../harness/harnessRuns.cjs').HarnessRuns>} runs
 * @param {{ fetch?: (url: string, o: any) => Promise<any>, execFile?: any }} [o]
 */
function registerUpdates(ipcMain, deps, runs, o = {}) {
  const { live, shellEnv, broadcastAll, net } = deps;
  const run = o.execFile ?? childProcess.execFile;
  const latest = createLatest({
    // through Electron's net: the app's proxy settings apply
    fetchJson: async (url, timeoutMs) => {
      const r = await (o.fetch ?? ((u, x) => net.fetch(u, x)))(url, {
        headers: { accept: 'application/json', 'user-agent': 'MoPilot' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`the registry answered ${r.status}`);
      return r.json();
    },
    brewInfo: (brew, name, cask, timeoutMs) =>
      new Promise((resolve, reject) => {
        run(
          brew,
          ['info', '--json=v2', ...(cask ? ['--cask'] : []), name],
          { env: { ...shellEnv.childEnv(), HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' }, timeout: timeoutMs },
          (/** @type {any} */ error, /** @type {string} */ stdout) => {
            if (error) return reject(error);
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              reject(e);
            }
          },
        );
      }),
  });
  const updates = new HarnessUpdates({
    runs,
    installed: installedOf(deps),
    method: (kind, bin) => howInstalled(kind, bin, hostIo(shellEnv)),
    latest,
    versionStatus,
    // the version of the binary itself: its package, or its version folder; else what detection said
    readVersion: async (m) => (m.packageJson ? packageVersion(m.packageJson) : m.pathVersion),
    health: (bin, env) => health(bin, env, { execFile: run, childEnv: () => shellEnv.childEnv() }),
    busyChats: busyChatsOf(live),
    restart: (kind) => {
      const k = parseKind(kind);
      if (k) RESTART[k.family](deps);
    },
    broadcast: broadcastAll,
  });
  ipcMain.handle('harnessUpdates:state', () => updates.state());
  ipcMain.handle('harnessUpdates:check', (_e, force) => updates.check({ force: !!force }));
  ipcMain.handle('harnessUpdates:update', (_e, kind, when) =>
    updates.update(String(kind), { when: when === 'now' || when === 'idle' ? when : undefined }),
  );
  ipcMain.handle('harnessUpdates:cancelWait', (_e, kind) => updates.cancelWait(String(kind)));
  ipcMain.handle('harnessUpdates:updateAll', () => updates.updateAll());
  ipcMain.handle('harnessUpdates:cancelAll', () => updates.cancelAll());
  updates.schedule();
  return updates;
}

module.exports = { registerUpdates, installedOf, busyChatsOf, health, packageVersion, registeredBy: 'harnessRuns' };
