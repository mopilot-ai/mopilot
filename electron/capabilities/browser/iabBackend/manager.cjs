// Native-thread browser backend socket creation, shutdown and main-service wiring.
const crypto = require('node:crypto');
const { fs: nodeFs } = require('../../../platform/ports/fs.cjs');
const nodeNet = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../../../ignored.cjs');
const { SOCKET_DIR } = require('./protocol.cjs');
const { Peer } = require('./wire.cjs');
const { IabBackend } = require('./backend.cjs');
const { pluginBrowserEnv, verifyDescendant } = require('./environment.cjs');

/**
 * The backends of the loaded native Codex threads and their subagents: one socket each, opened when a
 * thread is loaded on the native path (or spawned by one) and closed when it is unloaded, the app-server
 * exits or the app quits.
 */
class IabBackends {
  /**
   * @param {{ tabs: () => any, grants: () => any, chatOf: (threadId: string) => string,
   *           harnessPid: () => number | null | undefined, enabled: () => boolean,
   *           pluginEnv: () => { backends: string[], flavor: string | null, version: string | null },
   *           onStop?: ((fn: (chatId: string) => void) => () => void) | null,
   *           turns?: () => InstanceType<typeof import('../../contract/turnTokens.cjs').TurnTokens> | null,
   *           dir?: string, fs?: typeof nodeFs, net?: typeof nodeNet, verify?: typeof verifyDescendant,
   *           cdpMs?: number, Backend?: typeof IabBackend, kind?: string, listed?: (backends: string[]) => boolean,
   *           accepts?: (load: { surfaces?: { chrome: boolean, chromeRoute?: string } }) => boolean }} o
   *   Backend, kind: the backend class each thread gets and its type ('iab' by default; chromeBackend.cjs serves the
   *     user's Chrome as an 'extension' backend the same way); listed: whether the plugin env lists such a backend
   *     (by default, when it names the kind)
   */
  constructor(o) {
    this.o = o;
    this.Backend = o.Backend ?? IabBackend;
    this.kind = o.kind ?? 'iab';
    this.dir = o.dir ?? SOCKET_DIR;
    this.fs = o.fs ?? nodeFs;
    this.net = o.net ?? nodeNet;
    this.verify = o.verify ?? verifyDescendant;
    /** thread id -> { backend, server, path, sockets } */
    this.servers = new Map();
  }

  /** Whether a native thread loaded now gets a backend the plugin will use. */
  available() {
    try {
      const backends = this.o.pluginEnv().backends;
      return this.o.enabled() === true && !!this.o.tabs() && (this.o.listed ? this.o.listed(backends) : backends.includes(this.kind));
    } catch {
      return false;
    }
  }

  /** Whether the thread has a backend now. */
  has(threadId) {
    return this.servers.has(threadId);
  }

  /** A backend accepted for this thread is still opening its socket. */
  loading(threadId) {
    const entry = this.servers.get(threadId);
    return entry?.starting === true && entry.backend.on();
  }

  /** A loaded backend is listening and still enabled; command/site permission checks remain authoritative. */
  serves(threadId) {
    const entry = this.servers.get(threadId);
    return !!entry && !entry.starting && entry.backend.on();
  }

  /**
   * A thread was loaded on the native path (or a native thread spawned subagent thread `threadId`, with
   * `parent`): its backend starts listening. Resolves with the socket path, or null.
   * @param {string} threadId
   * @param {{ parent?: string | null, surfaces?: { chrome: boolean, chromeRoute?: string } }} [o]
   */
  async loaded(threadId, { parent = null, surfaces } = {}) {
    if (this.o.accepts?.({ surfaces }) === false) return null;
    if (typeof threadId !== 'string' || !threadId || this.servers.has(threadId) || !this.available()) return null;
    const env = this.o.pluginEnv();
    const backend = new this.Backend({
      threadId,
      parent,
      chatOf: this.o.chatOf,
      tabs: this.o.tabs,
      grants: this.o.grants,
      // the switch is read again on every call: turning the in-app browser off stops a loaded thread's plugin too
      enabled: () => this.o.enabled() === true && !!this.o.tabs(),
      flavor: env.flavor,
      version: env.version,
      cdpMs: this.o.cdpMs,
      turns: this.o.turns,
    });
    if (!this.fs.existsSync(this.dir)) {
      // a shared drop box like the vendor's: anyone may add a socket, only its owner may remove it
      this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o1777 });
      this.fs.chmodSync(this.dir, 0o1777);
    }
    const file = path.join(this.dir, `${crypto.randomUUID()}.sock`);
    const sockets = new Set();
    const server = this.net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const gate = this.verify({ socket, root: this.o.harnessPid() }).then((why) => why === null);
      const peer = new Peer(socket, (m, p) => backend.handle(m, p), gate);
      gate.then((ok) => ok && !peer.closed && backend.peers.add(peer));
      socket.on('close', () => backend.peers.delete(peer));
    });
    const entry = { backend, server, path: file, sockets, starting: true };
    this.servers.set(threadId, entry);
    // the plugin waits on its downloads (onDownloadChange): the host tells the backend about its tabs'
    backend.offDownloads = this.o.tabs()?.onDownload?.((change) => backend.downloaded(change)) ?? null;
    // and on the pages' own dialogs (alert, confirm, prompt), which it answers as CDP's, and on links they blocked
    backend.offPageEvents = this.o.tabs()?.onPageEvent?.((change) => backend.pageEvent(change)) ?? null;
    // a Stop on its chat stops the commands it has under way
    backend.offStop = this.o.onStop?.((chatId) => chatId === backend.ctx.chatId && backend.stopped()) ?? null;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(file, () => resolve(null));
      });
      this.fs.chmodSync(file, 0o600);
    } catch {
      entry.starting = false;
      this.#close(threadId, entry);
      return null;
    }
    entry.starting = false;
    // unloaded while it was starting
    if (this.servers.get(threadId) !== entry) {
      this.#close(threadId, entry);
      return null;
    }
    return file;
  }

  /** The thread was unloaded (or left the native path): its backend goes. */
  unloaded(threadId) {
    const entry = this.servers.get(threadId);
    if (entry) this.#close(threadId, entry);
  }

  /** The app-server exited, or the app quits: every backend goes. */
  exited() {
    for (const [id, entry] of [...this.servers]) this.#close(id, entry);
  }

  #close(threadId, entry) {
    if (this.servers.get(threadId) === entry) this.servers.delete(threadId);
    // still starting: loaded() sees it was dropped and closes it once it listens
    if (entry.starting) return;
    entry.backend.offDownloads?.();
    entry.backend.offDownloads = null;
    entry.backend.offPageEvents?.();
    entry.backend.offPageEvents = null;
    entry.backend.offStop?.();
    entry.backend.offStop = null;
    for (const tab of [...entry.backend.held.keys()]) entry.backend.drop(tab);
    for (const s of entry.sockets) s.destroy();
    try {
      entry.server.close();
    } catch (error) {
      // not listening yet
      noteIgnored('close the socket server of a browser plugin backend', error);
    }
    try {
      this.fs.rmSync(entry.path, { force: true });
    } catch (error) {
      noteIgnored('remove the socket file of a browser plugin backend', error);
    }
  }
}

/**
 * The backends main runs, on its late-bound services: the browser host and grants, the chat a thread
 * belongs to, the Codex app-server's pid, and the plugin env of the CODEX_HOME Codex runs with.
 * `browserEnabled`: hostTools.cjs inAppBrowserEnabled (the in-app browser's remote switches).
 * @param {{ live: any, server: { proc?: { pid?: number } | null }, isFlagEnabled: (key: string) => boolean,
 *           shellEnv: { childEnv: () => Record<string, string | undefined> },
 *           browserEnabled: (isFlagEnabled: (key: string) => boolean) => true | string, home?: string }} o
 */
function mainIabBackends({ live, server, isFlagEnabled, shellEnv, browserEnabled, home = os.homedir() }) {
  return new IabBackends({
    tabs: () => live.browserTabs ?? null,
    grants: () => live.browserGrants,
    chatOf: (id) => live.controller?.chatOf(id) ?? id,
    harnessPid: () => server.proc?.pid,
    enabled: () => isFlagEnabled('native.codex.inAppBrowser') && browserEnabled(isFlagEnabled) === true,
    // Stop reaches the Registry's calls (abortChat); the plugin's commands hear it too
    onStop: (fn) => live.capabilities?.onAbort(fn) ?? null,
    // each command carries its chat's (chat, turn) token, and acts no more once that turn ended or was stopped
    turns: () => live.capabilities?.turns ?? null,
    pluginEnv: () => pluginBrowserEnv({ codexHome: shellEnv.childEnv().CODEX_HOME || path.join(home, '.codex') }),
  });
}

module.exports = { IabBackends, mainIabBackends };
