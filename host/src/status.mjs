// What `status` reports: version, harnesses, capabilities, and which isolation guarantees this Host delivers or has blocked.
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerNameOf } from '../../shared/host/computerName.mjs';

const require = createRequire(import.meta.url);
const { peerCheckReady } = require('../../electron/capabilities/mcp/sageMcpReady.cjs');
const { core, coreProblem, hostCoreRecord } = require('../../electron/platform/core.cjs');

export { coreProblem };

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** The build this Host runs, as the archive it came in recorded it ('' for a Host that was not unpacked from one); the app compares it with its own to see an older Host. */
const recorded = (/** @type {string} */ file) => {
  try {
    return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', file), 'utf8').trim();
  } catch {
    return '';
  }
};
const build = recorded('BUILD_ID');
/** The version of the app that built this Host's archive ('' for one that was not unpacked from one, or from before archives recorded it): a build id has no order, a version does. */
const appVersion = recorded('APP_VERSION');

/**
 * Whether this Host's Rust core answers: its build, as the version records it, how many routes the addon lists, and why it has none. A Host with a `problem` does not serve (cli.mjs), and the app's install says so.
 * @param {{ routes: () => string[] } | null} [addon] @param {{ build: string } | null} [record] @param {string | null} [problem]
 */
export function coreStatus(addon = core(), record = hostCoreRecord(), problem = coreProblem()) {
  return { loaded: Boolean(addon), build: record?.build ?? null, routes: addon ? addon.routes().length : 0, problem };
}

/** The surfaces this Host declares: known without asking any agent, so a hello never waits on a sign-in probe. @param {{ browser?: boolean, desktop?: boolean }} o */
export const hostCapabilities = ({ browser = false, desktop = false }) => ({ iab: browser, cu: false, desktop, bu: false, shell: false });

/**
 * @param {{ running: boolean, platform?: NodeJS.Platform, computerName?: string, runningVersion?: string, peerCheck?: boolean, harnesses?: { id: string, detected: boolean, signedIn: boolean }[], browser?: boolean, desktop?: boolean, updateKey?: boolean, pendingUpdate?: { version: string, build: string }, localNetwork?: import('./localNetwork.mjs').LocalNetwork, startup?: import('./startup.mjs').Startup, rustCore?: ReturnType<typeof coreStatus>, policy?: object, spend?: object, cloud?: { idleMinutes: number, stopping: boolean, hoursToday: number, reason?: string } | null, push?: { phones: number, skipped: number, lastSkippedAt: number | null } }} o
 * computerName: this computer's own name (its hostname, one label), which the app names the machine by once this Host answers; left out when the system gives none, and by an older Host, which the app then names by the address typed (#4930);
 * policy: the owner's rules as `host.status` reports them (./policy.mjs `status`);
 * push: how many phones this Host can push to and how many waiting cards found none since a push last went out (./pushNotifier.mjs `state`), so a Host that lost its relay link says so (#4721);
 * cloud: on a cloud machine, how long it may idle, whether it is stopping (and why) and the hours it has run today (idleStop.mjs); a Host elsewhere has none
 * startup: whether this Host starts before sign-in and whether FileVault is on; localNetwork: whether this Host may reach the local network (./localNetwork.mjs); pendingUpdate: `{ version, build }` of a staged update this Host has not yet restarted into (update.mjs updateFacts); updateKey: whether a key is trusted for updates (the update key file, or a paired app), without which `update` refuses every manifest; desktop: whether this Host can serve a desktop to a chat right now (desktopService.mjs: a helper in the logged-in session whose macOS grants are on, read, never assumed), which is what a chat's own desktop on this Host needs of it (`desktop`; `cu`, the user's own Mac, stays false for a Host: an app that does not know `desktop` must never run a Host chat's `desktop_*` tools on its own desktop); browser: whether this Host can run a browser for a chat (browserService.mjs), which is what the in-app browser surface (`iab`) needs of it; harnesses: each harness's installed and signed-in state (./harnessState.mjs); runningVersion: a staged version the Host restarted into; peerCheck: whether the Rust core can check who connects to the tool socket (sageMcpReady.cjs), without which every connection would be refused, so the Host serves no tools and says why
 */
export function hostStatus({
  running,
  platform = process.platform,
  computerName = computerNameOf(os.hostname()),
  runningVersion,
  peerCheck = peerCheckReady(),
  harnesses = [],
  browser = false,
  desktop = false,
  updateKey = false,
  pendingUpdate = undefined,
  localNetwork = 'unknown',
  startup = { atBoot: 'unknown', fileVault: 'unknown' },
  rustCore = coreStatus(),
  policy = undefined,
  cloud = null,
  spend = undefined,
  push = undefined,
}) {
  return {
    ...(policy ? { policy } : {}),
    ...(spend ? { spend } : {}),
    ...(push ? { push } : {}),
    ...(pendingUpdate ? { pendingUpdate } : {}),
    version: runningVersion ?? version,
    build,
    appVersion,
    running,
    platform,
    ...(computerNameOf(computerName) ? { computerName: computerNameOf(computerName) } : {}),
    harnesses,
    capabilities: hostCapabilities({ browser, desktop }),
    localNetwork,
    startup,
    core: rustCore,
    ...(cloud ? { cloud } : {}),
    isolation: isolationFor(peerCheck, updateKey),
  };
}

/**
 * Which isolation guarantees this machine gives, and which are not delivered. The peer check of the tool socket asks the
 * Rust core, which reads the kernel's answer.
 * @param {boolean} peerCheck
 * @param {boolean} updateKey
 */
function isolationFor(peerCheck, updateKey) {
  return {
    delivered: [
      'unix socket only: no TCP listener',
      'owner-only (0600) socket and secrets file',
      ...(updateKey
        ? [
            'updates are taken only from a manifest signed (Ed25519) by the paired app or this Host’s update key, made for this Host, not expired and newer than the last',
          ]
        : []),
      ...(peerCheck
        ? [
            'MoPilot tools for ACP, Claude Code and Codex chats (the app’s, relayed); sage-mcp peer check: process ancestry, then the kernel’s word on the socket’s peer, from the Rust core',
          ]
        : []),
    ],
    blocked: [
      ...(peerCheck ? [] : ['sage-mcp peer check: the Rust core cannot run it here, so every tool connection would be refused']),
      'OS keychain secrets: secrets are a 0600 file',
      ...(updateKey ? [] : ['updates are refused: this Host trusts no update key (pair the app, or `mopilot-host trust-update-key`)']),
    ],
  };
}
