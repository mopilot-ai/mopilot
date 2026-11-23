// Installs or updates Codex Computer Use (Sky) in the Codex home from the copy the Codex runtime bundles.
//
// The vendor plugin (unified-computer-use) starts the service from $CODEX_HOME/computer-use/Codex Computer
// Use.app (its SKY_CUA_SERVICE_PATH, else that canonical path). The ChatGPT app keeps that copy in step with
// the one in its cua_node runtime by copying it with `ditto --noqtn` at startup; MoPilot does the same
// here, so the user never has to open another app. Only when the copy is missing or older than the bundled
// one, and only into the Codex home MoPilot's app-server uses.
const { noteIgnored } = require('../ignored.cjs');
const { fs: nodeFs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');
const { compareVersions } = require('../../shared/skyComputerUse.mjs');

/**
 * What to do about Sky: install it where it is missing, update the canonical copy when the bundled one is
 * newer, else nothing. A Sky found somewhere else (the plugin's own path) is the plugin's choice and stays.
 * @param {{ present: boolean, path: string | null, version: string | null, bundled: string | null,
 *           source?: string | null, canonical?: string | null }} sky the probe's Sky facts
 * @returns {{ action: 'install' | 'update', source: string, target: string, version: string } | null}
 */
function skyInstallPlan(sky) {
  const source = sky?.source;
  const target = sky?.canonical;
  const version = sky?.bundled;
  if (!source || !target || !version) return null;
  /** @param {'install' | 'update'} action */
  const plan = (action) => ({ action, source, target, version });
  if (!sky.present) return plan('install');
  if (sky.path === target && compareVersions(sky.version, version) === -1) return plan('update');
  return null;
}

/** Adds the owner's write bit to every folder under `dir`, so a bundle with read-only folders can be removed. */
async function makeWritable(fsp, dir) {
  const st = await fsp.lstat(dir).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!st?.isDirectory()) return;
  await fsp.chmod(dir, st.mode | 0o200);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => makeWritable(fsp, path.join(dir, e.name))));
}

/** Removes a path that may hold a bundle with read-only folders. */
async function removeTree(fsp, p) {
  await makeWritable(fsp, p);
  await fsp.rm(p, { recursive: true, force: true });
}

/** Runs a program; resolves with its output, rejects with its error. */
const run = (file, args) =>
  new Promise((resolve, reject) => proc.execFile(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/**
 * Copies the bundled Sky into place with `ditto --noqtn` (as the ChatGPT app does): into a sibling folder
 * first, then swapped in, so a failed copy leaves the installed one as it was.
 * @param {{ source: string, target: string }} plan
 * @param {typeof import('node:fs').promises} [fsp]
 */
async function installSky({ source, target }, fsp = nodeFs.promises) {
  const staging = `${target}.mopilot-${process.pid}`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await removeTree(fsp, staging);
  try {
    await run('/usr/bin/ditto', ['--noqtn', source, staging]);
    await removeTree(fsp, target);
    await fsp.rename(staging, target);
  } catch (e) {
    await removeTree(fsp, staging).catch((error) => {
      // the copy's error is the one to report; a staging copy left behind is removed before the next install
      noteIgnored('remove the partial Sky Computer Use copy', error);
    });
    throw e;
  }
}

module.exports = { skyInstallPlan, installSky };
