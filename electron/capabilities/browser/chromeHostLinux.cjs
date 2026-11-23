// Linux counterpart of the checks on a Chrome native messaging host (chromeNativeHost.cjs), for E2E runs only: the gate that turns it on, and a /proc check that the host's parent is Google Chrome.
//
// - Gate (linuxHostEnabled): an unpackaged app that is an E2E instance (SAGE_E2E_BACKGROUND=1), asked for the native host
//   (MOPILOT_CHROME_NATIVE_HOST=1) and pointed at a scratch Chrome folder (MOPILOT_CHROME_RELAY_USER_DATA_DIR). A packaged
//   build ignores every one of those variables here (the same rule as the flag overrides, app/flags.cjs), so no user
//   setting enables the Linux host in a release. Without the gate Linux installs no manifest and refuses every host.
// - Check (chromeParentLinux): macOS proves the host's parent is Google Chrome with codesign (a signature by Google's team
//   on the running code). Linux has no signature on a running process, so this proves less: the parent's /proc/<pid>/exe is
//   Google's package path, that file and every directory above it are root-owned and not writable by group or others (so
//   no process of the user's replaced it), the parent shares our mount namespace and runs the very file at that path here
//   (an unshare -Urm bind mount shows another file at the same path), and host and parent run as the user that runs
//   MoPilot. It does not prove the bytes are Google's (any root-installed file at that path passes), nor that the
//   running image was not altered (a same-user process can LD_PRELOAD or ptrace a Chrome it starts; macOS's hardened
//   runtime stops that). It is not a full defence: both trust the user's own session, and the same-user attacker is out of
//   scope on either platform (it can also start Chrome with its own profile).
const path = require('node:path');
const { fs: fsPort } = require('../../platform/ports/fs.cjs');
const { core, coreCall } = require('../../platform/core.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { ancestryOf } = require('../mcp/socket.cjs');

/** Where Google's .deb and .rpm put the browser process: the parent Chrome starts a native messaging host from. */
const CHROME_EXECUTABLES = Object.freeze(['/opt/google/chrome/chrome']);

/**
 * Whether the Linux host may be installed and answered: only an unpackaged E2E run pointed at a scratch Chrome folder.
 * @param {{ env?: Record<string, string | undefined>, packaged?: boolean, platform?: string }} [o]
 */
function linuxHostEnabled({ env = process.env, packaged = true, platform = process.platform } = {}) {
  return (
    platform === 'linux' &&
    !packaged &&
    env.SAGE_E2E_BACKGROUND === '1' &&
    env.MOPILOT_CHROME_NATIVE_HOST === '1' &&
    !!env.MOPILOT_CHROME_RELAY_USER_DATA_DIR
  );
}

/**
 * The file process `pid` runs, by the kernel (the core's caps.executable: `proc_pidpath`, `/proc/<pid>/exe`), or null when
 * it can't be read (gone, or not this user's: the route's error, noted). ps reports argv[0], which a process sets itself. A
 * deleted file reads as null on macOS and as "<path> (deleted)" on Linux, so it matches no path a caller compares it with.
 * @param {number} pid @param {ReturnType<typeof core> | null} [addon]
 */
async function executableOf(pid, addon = core()) {
  try {
    const file = await coreCall('caps.executable', addon, String(pid));
    return typeof file === 'string' ? file : null;
  } catch (error) {
    // every caller refuses a process whose file it can't name
    noteIgnored('read the file a process runs', error);
    return null;
  }
}

/**
 * The process that started `pid`, from the core's process table, or null (gone, started by init, or the core can't say).
 * @param {number} pid @param {ReturnType<typeof core> | null} [addon]
 */
async function startedByProcess(pid, addon = core()) {
  const parent = (await ancestryOf(pid, addon))?.[1];
  return Number.isInteger(parent) ? /** @type {number} */ (parent) : null;
}

/** The uid owning /proc/<pid> (the process's effective uid), or null. */
function uidOfProcess(pid, f) {
  try {
    return f.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }
}

/** Whether `file` and each directory above it belong to root and are closed to group and others' writes. */
function rootOwnedChain(file, f) {
  const closed = (/** @type {string} */ p) => {
    const st = f.lstatSync(p);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    const up = path.dirname(p);
    return up === p || closed(up);
  };
  try {
    return closed(file);
  } catch {
    return false;
  }
}

/** The mount namespace link of a process (`self` for this one), or null. */
function mountNamespace(who, f) {
  try {
    return String(f.readlinkSync(`/proc/${who}/ns/mnt`));
  } catch {
    return null;
  }
}

/** Whether `a` and `b` are one file (device and inode, followed through links). */
function sameFile(a, b, f) {
  try {
    const x = f.statSync(a);
    const y = f.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Whether the process that started host `pid` is Google Chrome, from /proc. Returns null when it is, or why not.
 * @param {{ pid: number, fs?: Pick<typeof fsPort, 'readlinkSync' | 'statSync' | 'lstatSync'>, uid?: number,
 *           executables?: readonly string[], addon?: ReturnType<typeof core> | null }} o
 *   uid: the user MoPilot runs as; executables: the paths Google's browser process may run
 */
async function chromeParentLinux({
  pid,
  fs: f = fsPort,
  uid = /** @type {() => number} */ (process.getuid)(),
  executables = CHROME_EXECUTABLES,
  addon = core(),
}) {
  const NOT = 'the host was not started by Google Chrome';
  const parent = await startedByProcess(pid, addon);
  if (parent === null || parent <= 1) return 'no browser started the host';
  // the browser and the host belong to the user running MoPilot, as a process the user started would
  if (uidOfProcess(pid, f) !== uid || uidOfProcess(parent, f) !== uid) return NOT;
  // a replaced binary reads "<path> (deleted)" and matches none
  const exe = await executableOf(parent, addon);
  if (!exe || !executables.includes(exe) || !rootOwnedChain(exe, f)) return NOT;
  // a mount namespace the user made (unshare -Urm) can show the real path over its own file: the parent must see the
  // same mounts as we do, and run the very file at that path here
  const ours = mountNamespace('self', f);
  if (ours === null || mountNamespace(parent, f) !== ours || !sameFile(`/proc/${parent}/exe`, exe, f)) return NOT;
  // the parent is still the one read first: a host reparented while we looked is not shown to be Chrome's
  return (await startedByProcess(pid, addon)) === parent ? null : NOT;
}

module.exports = { CHROME_EXECUTABLES, linuxHostEnabled, executableOf, startedByProcess, chromeParentLinux };
