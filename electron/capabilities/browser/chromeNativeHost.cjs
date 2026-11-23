// The native messaging host of MoPilot's Chrome extension (#1632): its manifest in each browser, the launcher Chrome runs, and main's socket that hands a verified host the one-time claim code a pairing offered, so the code never appears on a command line.
//
// - Chrome starts the host named HOST_NAME for an extension whose origin the manifest's allowed_origins lists (a
//   packaged build lists only the Web Store's id; a developer build also the dev key's). The manifest goes only into
//   the Chrome folder MoPilot opens its pairing page in, and its path is a launcher script in MoPilot's user
//   data that runs sage-mcp --chrome-native-host with this run's socket (native/sage-mcp/Sources/sage-mcp/ChromeHost.swift).
// - Main answers a host only when, by the kernel's word, the connected process is that sage-mcp (the core: it is the
//   socket's peer, and the file it runs, not the argv[0] ps reports, is that file) and its parent is Google Chrome signed
//   by Google (codesign on the running process), and the origin it names is one of the extension's. Then it hands over the
//   claim code a pairing offered, still once and within its two minutes, or says none is open. A request the extension
//   makes by itself (`auto`: at startup or on its alarm) gets only an offer the user made with Settings' Pair; an offer
//   a chat's wait made needs the user's Pair on the page, as before.
// - What this stops: a process that reads command lines (the page's URL carries no code) and any process that isn't
//   sage-mcp started by Google Chrome. What it does not stop: a process of the same user that can write files can
//   point the manifest or the launcher at its own program, or start Chrome with its own profile and extension, and so
//   take a pending claim. The origin is the host's word, not Chrome's. Accepting an origin admits nothing more: the
//   claim is still traded over the extension's socket, and every connection proves the pairing secret.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const net = require('node:net');
const { proc } = require('../../platform/ports/proc.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { PrivateSocketListener } = require('../../platform/privateSocket.cjs');
const { core } = require('../../platform/core.cjs');
const { peerHolds } = require('../mcp/socket.cjs');
const { chromeUserData } = require('./chromeMigration.cjs');
const { originOf } = require('./chromeExtensionIds.cjs');
const { executableOf, startedByProcess, chromeParentLinux } = require('./chromeHostLinux.cjs');

/** The host's name in every browser's NativeMessagingHosts folder and in the extension's sendNativeMessage. */
const HOST_NAME = 'ai.mopilot.code.chrome';
/** What a host may send: one small request. */
const MAX_LINE = 64 * 1024;
const LINE_MS = 10_000;

/** The Apple Developer ID team that signs Google Chrome, which a host must be started by. */
const CHROME_TEAM = 'EQHXZ8M8AV';

/** A string as one sh word. @param {string} s */
const shellWord = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The launcher Chrome runs: sage-mcp as the host, on this run's socket, with the arguments Chrome passes (the origin).
 * `exec` keeps the browser as the host's parent, which main checks.
 * @param {{ binary: string, socket: string }} o
 */
function launcherScript({ binary, socket }) {
  return `#!/bin/sh\n# MoPilot's Chrome extension native messaging host (written by MoPilot at startup)\nexec ${shellWord(binary)} --chrome-native-host ${shellWord(socket)} "$@"\n`;
}

/**
 * The host manifest a browser reads: the launcher's path and exactly the extension's origins (Chrome takes them with a
 * trailing slash and no wildcard).
 * @param {{ launcher: string, ids: string[] }} o
 */
function hostManifest({ launcher, ids }) {
  return {
    name: HOST_NAME,
    description: "MoPilot's Chrome extension pairing",
    path: launcher,
    type: 'stdio',
    allowed_origins: ids.map((id) => `${originOf(id)}/`),
  };
}

/**
 * The NativeMessagingHosts folder to write: the Chrome folder MoPilot opens its pairing page in (the scratch one a
 * run was pointed at, MOPILOT_CHROME_RELAY_USER_DATA_DIR, else Google Chrome's own), when it exists. Never another
 * browser's: an extension there could take a claim offered for this Chrome. macOS, and Linux only for an E2E run
 * (`linuxE2E`, chromeHostLinux.cjs linuxHostEnabled) and only its scratch folder, never ~/.config/google-chrome: other
 * platforms register hosts elsewhere (the Windows registry) and pair through the page.
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string, exists?: (p: string) => boolean, linuxE2E?: boolean }} [o]
 * @returns {string[]}
 */
function hostFolders({ env = process.env, home, platform = process.platform, exists = fs.existsSync, linuxE2E = false } = {}) {
  if (platform === 'linux') {
    if (!linuxE2E || !env.MOPILOT_CHROME_RELAY_USER_DATA_DIR) return [];
  } else if (platform !== 'darwin') return [];
  const dir = env.MOPILOT_CHROME_RELAY_USER_DATA_DIR
    ? path.resolve(env.MOPILOT_CHROME_RELAY_USER_DATA_DIR)
    : chromeUserData({ home, platform });
  return exists(dir) ? [path.join(dir, 'NativeMessagingHosts')] : [];
}

/**
 * Writes the launcher (owner-only) and the manifest into each folder. A folder that can't be written is noted and
 * left out; the result says where the host is installed.
 * @param {{ launcher: string, script: string, manifest: object, folders: string[], fs?: typeof fs }} o
 * @returns {string[]} the manifests written
 */
function installHost({ launcher, script, manifest, folders, fs: f = fs }) {
  f.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  writeAtomic(launcher, script, f, 0o700);
  // a launcher left from an older run keeps its mode through writeAtomic: only its owner runs or changes it
  f.chmodSync(launcher, 0o700);
  const written = [];
  for (const folder of folders) {
    const file = path.join(folder, `${HOST_NAME}.json`);
    try {
      writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, f, 0o644);
      written.push(file);
    } catch (error) {
      noteIgnored("write MoPilot's Chrome native messaging host manifest", error);
    }
  }
  return written;
}

const run = (cmd, args, exec) =>
  new Promise((resolve) => {
    exec(cmd, args, { timeout: 5000 }, (error, stdout) => resolve({ ok: !error, out: String(stdout || '').trim() }));
  });
/**
 * Whether the process at the other end of `socket` may be handed a claim: it runs `binary` (sage-mcp), holds the
 * socket, was started by Google Chrome signed by Google, and names one of `ids`. Returns null when it may, or why not.
 * On Linux (E2E runs only, `linuxE2E`) /proc answers instead of codesign, with less proof (chromeHostLinux.cjs).
 * @param {{ socket: any, pid: unknown, origin: unknown, binary: string, ids: string[], execFile?: typeof proc.execFile, holds?: typeof peerHolds,
 *           platform?: string, linuxE2E?: boolean, linuxFs?: Parameters<typeof chromeParentLinux>[0]['fs'], linuxUid?: number,
 *           addon?: ReturnType<typeof core> | null }} o
 */
async function verifyHostPeer({
  socket,
  pid,
  origin,
  binary,
  ids,
  execFile: exec = proc.execFile,
  holds = peerHolds,
  platform = process.platform,
  linuxE2E = false,
  linuxFs,
  linuxUid,
  addon = core(),
}) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return 'no pid';
  if (!ids.some((id) => origin === `${originOf(id)}/`)) return 'not an extension of MoPilot';
  if (platform === 'linux') return verifyHostPeerLinux({ socket, pid, binary, holds, linuxE2E, fs: linuxFs, uid: linuxUid, addon });
  const exe = await executableOf(pid, addon);
  if (exe === null || exe !== binary) return `process ${pid} is not MoPilot's host`;
  const held = await holds({ socket, pid, addon });
  if (held) return held;
  const parent = await startedByProcess(pid, addon);
  if (parent === null || parent <= 1) return 'no browser started the host';
  // the running process's code, not its name, decides: codesign checks what the kernel loaded for that pid. The files
  // under the app are not asked: a Chrome that updated itself on disk while it runs (its framework now has another
  // version) fails the resource check ("embedded framework contains modified or invalid version") until it restarts,
  // though the process in memory is still Google's signed code, and every pairing would be refused meanwhile.
  const signed = await run(
    '/usr/bin/codesign',
    ['--verify', '--ignore-resources', `-R=anchor apple generic and certificate leaf[subject.OU] = "${CHROME_TEAM}"`, String(parent)],
    exec,
  );
  return signed.ok ? null : 'the host was not started by Google Chrome';
}

/**
 * Linux's checks, in the macOS order: the host's file, the socket it holds, then who started it (E2E runs only).
 * @param {{ socket: any, pid: number, binary: string, holds: typeof peerHolds, linuxE2E: boolean, fs?: any, uid?: number, addon: ReturnType<typeof core> | null }} o
 */
async function verifyHostPeerLinux({ socket, pid, binary, holds, linuxE2E, fs: f = fs, uid, addon }) {
  if (!linuxE2E) return 'the Chrome native host is not available on Linux';
  const real = (/** @type {string} */ p) => {
    try {
      return f.realpathSync(p);
    } catch {
      return p;
    }
  };
  const exe = await executableOf(pid, addon);
  if (exe === null || (exe !== binary && exe !== real(binary))) return `process ${pid} is not MoPilot's host`;
  const held = await holds({ socket, pid, addon });
  if (held) return held;
  return chromeParentLinux({ pid, fs: f, uid, addon });
}

/**
 * Main's end of the host: one request per connection, answered with the pending claim code or none.
 */
class ChromeNativeHostServer {
  /**
   * @param {{ claim: (o: { auto: boolean }) => string | { pending: true } | null, open?: (what: unknown) => boolean | Promise<boolean>, ids: () => string[], binary: string, verify?: typeof verifyHostPeer,
   *           lineMs?: number, onRefused?: (reason: string) => void, linuxE2E?: boolean }} o
   *   claim: the claim code a pairing offered and that is still good (ChromeExtensionChannel.hostClaim; auto: the
   *   extension asked by itself); ids: the extension ids the manifest allows; binary: sage-mcp's path; onRefused: a
   *   host failed the checks (the pairing page then carries the code again); linuxE2E: the Linux gate is open
   */
  constructor(o) {
    this.o = o;
    this.listener = new PrivateSocketListener({
      prefix: 'mpchr-',
      createServer: () => net.createServer((socket) => this.#accept(socket)),
    });
  }

  /** Serves; resolves with the socket's path. */
  start() {
    return this.listener.listen();
  }

  stop() {
    this.listener.close();
  }

  #accept(socket) {
    let buf = '';
    let read = false;
    const answer = (m) => {
      socket.end(`${JSON.stringify(m)}\n`);
    };
    const timer = setTimeout(() => socket.destroy(), this.o.lineMs ?? LINE_MS);
    timer.unref?.();
    socket.on('error', (error) => noteIgnored("read from MoPilot's Chrome native host", error));
    socket.on('close', () => clearTimeout(timer));
    socket.on('data', (chunk) => {
      if (read) return;
      // only the new chunk is searched for the newline: the line read so far has none
      const text = chunk.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl < 0) {
        buf += text;
        if (buf.length > MAX_LINE) socket.destroy();
        return;
      }
      const line = buf + text.slice(0, nl);
      read = true;
      // the checks run their own commands with their own limits; the line limit was for reading it
      clearTimeout(timer);
      void this.#answer(socket, line).then(answer, (error) => {
        noteIgnored("answer MoPilot's Chrome native host", error);
        answer({ type: 'error', reason: 'MoPilot could not check the host' });
      });
    });
  }

  /** @returns {Promise<Record<string, unknown>>} */
  async #answer(socket, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return { type: 'error', reason: 'unreadable request' };
    }
    // a claim (pairing), or "open" (the extension's page asks MoPilot to open something it names, chromeAskNotice.cjs)
    const kind = m?.type === 'hello' ? m.request?.type : null;
    if (kind !== 'claim' && kind !== 'open') return { type: 'error', reason: 'unknown request' };
    const verify = this.o.verify ?? verifyHostPeer;
    const refused = await verify({
      socket,
      pid: m.pid,
      origin: m.origin,
      binary: this.o.binary,
      ids: this.o.ids(),
      linuxE2E: this.o.linuxE2E === true,
    });
    if (refused) {
      this.o.onRefused?.(refused);
      return { type: 'refused', reason: refused };
    }
    // the checks spoke of a connection that has gone (its descriptor may be another's by now): nothing is spent on it
    if (socket.destroyed) return { type: 'none', reason: 'The host went away' };
    if (kind === 'open')
      return (await this.o.open?.(m.request.what)) ? { type: 'opened' } : { type: 'none', reason: "MoPilot can't open that" };
    // read after the checks: an offer made or used meanwhile is the one that counts
    const code = this.o.claim({ auto: m.request.auto === true });
    if (typeof code === 'string') return { type: 'claim', code };
    // the user is being asked in MoPilot (chromeAsk.cjs): the extension asks again
    if (code?.pending) return { type: 'none', pending: true, reason: 'Waiting for the user to allow it in MoPilot' };
    return { type: 'none', reason: 'MoPilot is not offering a pairing now' };
  }
}

module.exports = {
  HOST_NAME,
  CHROME_TEAM,
  launcherScript,
  hostManifest,
  hostFolders,
  installHost,
  verifyHostPeer,
  ChromeNativeHostServer,
};
