// `mopilot-host uninstall [--purge]`: stops and removes the service. Plain `uninstall` keeps what the Host holds (its chats, identity, pairings and relay enrollments) so installing again resumes; `--purge` also deletes it, the same set the app's Remove deletes on a machine (electron/host/uninstallHost.cjs PURGE).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runsAsDaemon, stopCommand, uninstallUnit } from './install.mjs';

/** What only a Host's own data folder holds: a folder with none of them and another name is not deleted (a `--data-dir` pointing at the wrong place must not take a person's files). */
const HOST_MARKERS = ['host.lock', 'host.sock', 'host.log', 'threads', 'sessions', 'harnesses.json', 'signed-in.json'];

/** @param {string} dir */
const isHostFolder = (dir) => path.basename(dir) === 'mopilot-host' || HOST_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));

/**
 * What `--purge` deletes: the config folder (identity, pairings, relay enrollments, secrets), the data folder, and the install tree the app put under the home folder when this command runs from it (never a checkout it runs from).
 * @param {{ home: string, dataDir: string, configDir: string, binPath: string }} o
 */
export function purgeTargets({ home, dataDir, configDir, binPath }) {
  const tree = path.join(home, '.mopilot-host');
  const fromTree = path.resolve(binPath).startsWith(`${tree}${path.sep}`);
  const own = isHostFolder(dataDir);
  // another Host's config lives inside its data folder (paths.mjs): it is deleted only with a folder that is plainly the Host's
  const inside = configDir.startsWith(`${dataDir}${path.sep}`);
  return {
    /** @type {string[]} */
    remove: [...(own || !inside ? [configDir] : []), ...(own ? [dataDir] : []), ...(fromTree ? [tree] : [])],
    /** @type {string[]} */
    skipped: own ? [] : [dataDir],
  };
}

/**
 * @param {{ argv: string[], unit: Parameters<typeof uninstallUnit>[0] & { binPath: string, dataDir: string }, configDir: string, platform?: NodeJS.Platform, daemonPlist: string, stopService: (command: { bin: string, args: string[] }) => void, out: (line: string) => void, err: (line: string) => void }} o
 * @returns {number} the exit code
 */
export function uninstallCommand({ argv, unit, configDir, platform, daemonPlist, stopService, out, err }) {
  // the daemon is root's to remove: this user can neither stop nor remove it, so nothing is half done
  if (runsAsDaemon({ platform: platform ?? process.platform, daemonPlist })) {
    err('This Host starts at boot as a system service. Turn off “Keep running after restart” in MoPilot first.');
    return 1;
  }
  // stopped before the unit goes: launchd unloads by the file, and a Host left running would outlive its uninstall
  stopService(stopCommand(unit));
  const { file, existed } = uninstallUnit(unit);
  out(existed ? `Removed ${file}` : `No unit at ${file}`);
  if (!argv.includes('--purge')) {
    out(
      `Kept ${unit.dataDir} and ${configDir}: the Host's chats, identity and pairings, so installing again resumes. To delete them too: mopilot-host uninstall --purge`,
    );
    return 0;
  }
  const { remove, skipped } = purgeTargets({
    home: unit.home ?? os.homedir(),
    dataDir: unit.dataDir,
    configDir,
    binPath: unit.binPath,
  });
  for (const dir of remove) {
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    out(`Deleted ${dir}`);
  }
  for (const dir of skipped) out(`Kept ${dir}: it does not look like a Host's folder.`);
  return 0;
}
