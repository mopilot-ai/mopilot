// Which build of the Rust core a Host machine takes, in the words both sides use: the app picks a tarball by what the machine's Node says about itself, the Host refuses one made for another machine, and scripts/build-core.mjs builds each (host/README.md, Updating).
/** The core's Host builds: `<platform>-<arch>`, with the C library on Linux, whose addons do not load across it. */
export const CORE_BUILDS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
]);
/** Where a Host version keeps its addon, relative to its root, and the addon's name there. */
export const HOST_CORE_DIR = 'host-core';
export const HOST_CORE_ADDON = 'mopilot_core.node';
/** What a Host version says of its addon: `{ build, sha256 }`, under the archive's checksum and so under the signed manifest. */
export const HOST_CORE_RECORD = 'build.json';

/**
 * The script that prints the build of the Node running it, one line. The Node asked is the one that will load the addon: `uname -m` cannot see a C library, and a 32-bit userland on a 64-bit kernel prints `aarch64` while its Node is `arm`. Double quotes only: it is passed in single ones.
 */
const PROBE =
  'process.report.excludeNetwork=true;' +
  'console.log([process.platform,process.arch,...(process.platform==="linux"?[process.report.getReport().header.glibcVersionRuntime?"gnu":"musl"]:[])].join("-"))';

/** The shell command that asks `node` (as a shell word) which build it needs. @param {string} node */
export const coreProbeCommand = (node) => `${node} -e '${PROBE}'`;

/** The last line of what a machine printed: a login shell can print before the answer. @param {string} said */
const lastLine = (said) => /** @type {string} */ (said.trim().split('\n').at(-1)).trim();

/** The build a probe's output names, or null for a machine with none. @param {string} said */
export function coreBuildOf(said) {
  const line = lastLine(said);
  return CORE_BUILDS.includes(line) ? line : null;
}

/** The build of the Node running this. @param {{ platform?: string, arch?: string, report?: any }} [o] */
export function coreBuildHere({ platform = process.platform, arch = process.arch, report = process.report } = {}) {
  report.excludeNetwork = true;
  const libc = report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
  return [platform, arch, ...(platform === 'linux' ? [libc] : [])].join('-');
}

/**
 * The question could not be asked (the connection dropped, no Node ran): not the same as a machine with no build. One line, so it survives `userError`, which keeps a first line.
 * @param {string} reason
 */
export const notAsked = (reason) =>
  `Could not ask this machine which Host build it needs: ${reason.trim().split('\n')[0] || 'the command failed'}`;

/** Why a machine gets no Host, said at install and update before anything of its Host is touched. One short sentence, so `userError` keeps all of it. @param {string} said what the probe printed */
export function noCoreBuild(said) {
  const named = lastLine(said);
  return `MoPilot has no Host build for this machine${named ? ` (${named})` : ''}; a Host already on it keeps running.`;
}
