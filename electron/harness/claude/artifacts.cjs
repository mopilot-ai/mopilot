// Whether Claude Code may publish artifacts and designs to claude.ai (its Artifact tool), the Settings switch for it and the variable it sets.
// The CLI turns the tool off for SDK hosts unless CLAUDE_CODE_ARTIFACT is truthy, and MoPilot is one: the switch sets
// it. It is off by default (G10, #3571): the tool's schema is ~11.8k tokens on every request of every Claude chat, so only
// a user who turned it on carries it. A value the user exported (CLAUDE_CODE_ARTIFACT=0) and their own settings.json win.
// @host-portable: loads in the Host process without Electron (host/boundary.json)
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { paths } = require('../../platform/ports/paths.cjs');
const { isEnabled } = require('../../platform/flags.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT';
/** The remote kill switch (electron/platform/flags.cjs): off, no session gets the tool whatever the user's switch says. */
const KILL_FLAG = 'native.claude.artifacts';
/** Present = the user turned the tool on; absent = off (the default). */
const onFile = () => path.join(paths.userData(), 'claude-artifacts-on');
/** Before G10, present = off and absent = on: it is still removed when the user turns the tool on. */
const offFile = () => path.join(paths.userData(), 'claude-artifacts-off');

/**
 * The environment a Claude Code session starts with, with the Artifact switch applied. Pure. On: the variable is set
 * only where the environment has none, so a user's own 0 or false is kept. Off: forced to 0.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} on
 */
function artifactEnv(env, on) {
  if (!on) return { ...env, [ARTIFACT_ENV]: '0' };
  if (env[ARTIFACT_ENV] != null) return env;
  return { ...env, [ARTIFACT_ENV]: '1' };
}

/**
 * The switch. Changing it restarts idle sessions so their next turn starts with it; a running turn keeps the
 * environment it started with.
 * @param {{ restartIdle: () => void, isEnabled?: (key: string) => boolean }} deps
 */
function createArtifacts(deps) {
  const flagOn = deps.isEnabled ?? isEnabled;
  let onCache; // undefined = not read yet

  /** The user's own switch (Settings), read once: on only when they turned it on. */
  function userOn() {
    if (onCache === undefined) onCache = fs.existsSync(onFile());
    return onCache;
  }

  /** Whether new sessions get the Artifact tool: the user's switch, unless the kill switch is off. */
  const artifactsOn = () => userOn() && flagOn(KILL_FLAG);

  /** What the Settings row shows. */
  const view = () => ({ on: userOn(), killed: !flagOn(KILL_FLAG) });

  function setArtifacts(on) {
    onCache = !!on;
    try {
      if (on) {
        fs.writeFileSync(onFile(), '1', { mode: 0o600 });
        fs.rmSync(offFile(), { force: true });
      } else fs.rmSync(onFile(), { force: true });
    } catch (error) {
      // the in-memory cache still holds the choice for this run
      noteIgnored('save the Claude Code artifacts choice', error);
    }
    deps.restartIdle();
    return view();
  }

  /**
   * claude:artifacts and claude:setArtifacts.
   * @param {{ handle: (channel: string, fn: (...a: any[]) => any) => void }} ipcMain
   * @param {<T>(v: T) => T} [changed] tells the windows their capabilities changed, returning what it is given
   */
  function registerIpc(ipcMain, changed = (v) => v) {
    ipcMain.handle('claude:artifacts', () => view());
    ipcMain.handle('claude:setArtifacts', (_e, on) => changed(setArtifacts(!!on)));
  }

  return { artifactsOn, userOn, view, setArtifacts, registerIpc };
}

module.exports = { artifactEnv, createArtifacts, ARTIFACT_ENV, KILL_FLAG };
