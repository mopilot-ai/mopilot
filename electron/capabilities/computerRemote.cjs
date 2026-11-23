// A Host's own desktop as the helper the computer-use tools drive (G8 #3903): the same wrappers as ComputerHelper (click, screenshot, targetInfo, ...), but every request goes to a remote Host's desktop over RemoteDesktop (electron/host/remoteDesktop.cjs), under a lease the chat takes on first use.
//
// What this is not: it never starts or talks to this Mac's helper, and nothing here can reach this Mac's desktop. A request the Host does not serve is refused as a tool error, never answered locally. The few requests that mean something only on a person's own Mac (hiding the other apps, the clipboard, the glow, macOS permission prompts) are answered for what a disposable guest needs: nothing to do, or a refusal that says so.
// Attendance stays with the user: `input.idle` is the user's own device (injected), never the guest's.
const crypto = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');
const { ComputerHelper } = require('./computer.cjs');
const { currentToken } = require('./contract/actionGuard.cjs');
const { ToolError } = require('./contract/registry.cjs');
const { DESKTOP_CALLS } = require('../../shared/host/desktop.mjs');

const SERVED = new Set(DESKTOP_CALLS);
/** Requests with nothing to do on a guest: the desktop is nobody's to hide from, the clipboard is not shared, the glow is drawn by the pane, the helper's floor is the Host's. */
const NOTHING_TO_DO = new Set([
  'glow.start',
  'glow.stop',
  'apps.hideOthers',
  'apps.restore',
  'pasteboard.save',
  'pasteboard.restore',
  'deny.set',
]);
/** Requests that mean a person at a Mac: a guest answers them with a refusal that says so. */
const NOT_ON_A_HOST =
  /^(permissions\.(request|openSettings)|speech\.|eventkit\.|calendar\.|reminders\.|record\.|activity\.|app\.script|app\.scriptable|shortcuts\.)/;

/** The chat's grant as the Host takes it: a sorted list of bundle ids, or '*'. @param {string[] | '*'} apps */
const grantKey = (apps) => (apps === '*' ? '*' : [...apps].sort().join(','));

class RemoteHelper extends ComputerHelper {
  /**
   * @param {object} o
   * @param {{ lease: (chatId: string, apps: string[] | '*') => Promise<any>, command: (chatId: string, method: string, params?: object, opts?: { callId?: string }) => Promise<any>, release: (chatId: string) => Promise<any>, abort: (chatId: string) => Promise<any>, state: (chatId: string) => Promise<any>, alive: () => boolean, generation?: () => number }} o.remote the Host's desktop (createRemoteDesktop)
   * @param {(chatId: string) => string[] | '*'} o.appsOf the apps the chat may control now (its grants); the Host holds the chat to them
   * @param {() => Promise<number>} o.idleSeconds how long the user has not touched their own device (never the guest's)
   * @param {(chatId: string) => void} [o.onLeased] the chat holds the Host's desktop now (the pane gets its tab)
   * @param {(chatId: string) => boolean} [o.paused] the user drives the desktop: the agent's calls wait for the hand back
   * @param {(chatId: string, method: string, params: any, run: () => Promise<any>) => Promise<any>} [o.around] runs a call inside what the pane shows of it (the agent's cursor: hostDesktopCursor.cjs)
   * @param {(chatId: string) => unknown} [o.ownerEpoch] authoritative ownership epoch, independent of the current Host id
   * @param {(chatId: string, remote: RemoteHelper['remote']) => boolean} [o.currentRemote] authoritative current owner and transport, read before delayed input
   * @param {(chatId: string, shot: any) => void} [o.onShot] a screenshot of the chat's display came back (its geometry is what the pane's cursor is placed by)
   */
  constructor({
    remote,
    appsOf,
    idleSeconds,
    onLeased = () => undefined,
    paused = () => false,
    around = (_c, _m, _p, run) => run(),
    onShot = () => undefined,
    currentRemote = () => true,
    ownerEpoch = () => undefined,
  }) {
    super({ platform: 'darwin' });
    this.remote = remote;
    this.currentRemote = currentRemote;
    this.ownerEpoch = ownerEpoch;
    this.generation = remote.generation?.();
    this.appsOf = appsOf;
    this.userIdle = idleSeconds;
    this.onLeased = onLeased;
    this.paused = paused;
    this.around = around;
    this.onShot = onShot;
    /** chat id -> the grant its lease was taken with @type {Map<string, string>} */
    this.leased = new Map();
  }

  /** The Host's desktop is a service, not a process of this Mac's: it is "running" while the Host answers. */
  get running() {
    return this.remote.alive();
  }

  get installed() {
    return true;
  }

  async start() {
    return (this.info = { remote: true });
  }

  /** Nothing of this Mac's to stop; the leases end with release. */
  stop() {
    // the Host's leases end with release: there is no socket or process of this Mac's here
  }

  /** A new connection to the same Host: calls go over it, and the leases of the old one are gone, so each chat takes its lease again. @param {typeof this.remote} remote */
  setRemote(remote) {
    this.remote = remote;
    this.generation = remote.generation?.();
    this.leased.clear();
  }

  /** Captures the connection's authority before an await, including a reconnect inside the same wrapper. @param {string} chat */
  #connection(chat) {
    const remote = this.remote;
    const epoch = this.ownerEpoch(chat);
    const generation = remote.generation?.();
    if (this.generation !== generation) {
      this.leased.clear();
      this.generation = generation;
    }
    return () => {
      if (
        this.remote !== remote ||
        remote.generation?.() !== generation ||
        this.ownerEpoch(chat) !== epoch ||
        !this.currentRemote(chat, remote)
      )
        throw new ToolError(
          'The desktop connection or chat owner changed before the action ran. Take a fresh screenshot before continuing.',
          'aborted',
        );
    };
  }

  /** The chat ended (deleted, archived): the Host gives its desktop up at once, instead of when its idle bound runs out. @param {string} chatId */
  async forgetChat(chatId) {
    if (this.leased.delete(chatId)) await this.remote.release(chatId);
  }

  /** Stop: the Host fails what waits and lets go of the desktop. @param {string} chatId */
  async abortChat(chatId) {
    this.leased.delete(chatId);
    await this.remote.abort(chatId);
  }

  /** Takes the lease the chat's grants call for, once: a changed grant takes it again (the Host starts it from nothing). @param {string} chat */
  async #lease(chat) {
    // the user drives the desktop: the agent's calls wait for the hand back, and say so
    if (this.paused(chat)) throw new ToolError('You are driving this desktop. Hand it back to let the agent continue.', 'user_took_over');
    const current = this.#connection(chat);
    current();
    const apps = this.appsOf(chat);
    const key = grantKey(apps);
    if (this.leased.get(chat) === key) return;
    await this.remote.lease(chat, apps);
    current();
    this.leased.set(chat, key);
    this.onLeased(chat);
  }

  /**
   * @param {string} method @param {object} [params] @param {{ timeoutMs?: number }} [opts]
   */
  async call(method, params = {}, opts = {}) {
    const chat = currentToken()?.chat ?? null;
    if (method === 'input.idle') return { seconds: await this.userIdle() };
    if (method === 'input.escape') return { sender: null };
    if (NOTHING_TO_DO.has(method)) return {};
    if (NOT_ON_A_HOST.test(method))
      throw new ToolError(`${method} is not something a Host's desktop does: it is for a person at a Mac.`, 'unsupported_on_host');
    if (method === 'turn.revoke' || method === 'control.release') {
      // the chat's turn ended or it let go: its lease ends on the Host (a cleanup with no chat lets go of every chat it holds)
      const named = method === 'turn.revoke' ? /** @type {any} */ (params).chat : null;
      const chats = named ? [named] : chat ? [chat] : [...this.leased.keys()];
      for (const c of chats) {
        this.leased.delete(c);
        await this.remote.release(c);
      }
      return {};
    }
    if (!chat && method === 'input.release') {
      // a cleanup with no chat: held keys and buttons are let go on every desktop this helper holds, as far as the Host answers
      for (const c of this.leased.keys())
        await this.remote.command(c, method, params).catch((error) => noteIgnored('let go of held input on a Host desktop', error));
      return {};
    }
    if (!chat) throw new ToolError('A Host desktop request needs the chat it is for.', 'no_chat');
    if (method === 'permissions.status') {
      const s = await this.remote.state(chat);
      return { accessibility: s.available === true, screenRecording: s.available === true, inputMonitoring: s.available === true };
    }
    if (method === 'control.acquire' || method === 'control.resume') {
      await this.#lease(chat);
      return { controlling: true, paused: null };
    }
    if (!SERVED.has(method)) throw new ToolError(`${method} is not something a Host's desktop serves.`, 'unsupported_on_host');
    const current = this.#connection(chat);
    current();
    await this.#lease(chat);
    current();
    // one id for the action: a retry after the Host let go of the lease must not run it twice
    const callId = crypto.randomUUID();
    const lost = (/** @type {any} */ e) => ['no_lease', 'stale_lease'].includes(e?.code);
    const attempt = async () => {
      current();
      try {
        return await this.remote.command(chat, method, params, { callId });
      } catch (e) {
        // the Host let go of the lease (idle, a new owner, a restart): the next call takes it again
        if (lost(e)) this.leased.delete(chat);
        throw e;
      }
    };
    const go = async () => {
      try {
        return await attempt();
      } catch (e) {
        if (!lost(e)) throw e;
        current();
        await this.#lease(chat);
        return attempt();
      }
    };
    const result = await this.around(chat, method, params, go);
    if (method === 'screenshot') this.onShot(chat, result);
    return result;
  }
}

module.exports = { RemoteHelper, grantKey };
