// The Host's browser service (design/host/index.html, package 2.6): one headless Chromium for the Host, a browser context per chat, and CDP commands that reach only the tabs and sessions of the chat that sends them.
import fs from 'node:fs';
import path from 'node:path';
import { dirName, nameDownload, safeName } from './browserDownloads.mjs';
import { createWaiters } from './commandWaiters.mjs';
import { ALLOWED_DOMAINS, METHOD, MAX_EVENT, REFUSED, TARGET_ALLOWED, navigable } from './cdpRules.mjs';
import { startFailure } from './launchFailure.mjs';

export class BrowserHostError extends Error {
  /** @param {'invalid' | 'not_owned' | 'refused' | 'timeout' | 'browser_exited' | 'disposed' | 'no_chromium'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'BrowserHostError';
    this.code = code;
  }
}

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** @typedef {{ send: (message: object) => void, onMessage: (fn: (message: any) => void) => unknown, onClose: (fn: (why: string) => void) => unknown }} Pipe what the service needs of the browser's CDP pipe (cdpPipe.mjs) */

/** @typedef {import('./cdpRules.mjs').BrowserEvent} BrowserEvent what a chat hears about its tabs; `sessionId` is '' for a tab's own session */

/**
 * @param {object} o
 * @param {() => Promise<{ pipe: Pipe, exited: Promise<any>, stop: () => void }>} o.launch starts the browser (chromium.mjs)
 * @param {string} o.downloadsDir where chats' downloads land on this Host, one folder per chat
 * @param {number} [o.idleMs] how long a chat's tabs outlive its last command (the Mac may be away) before they are closed
 * @param {number} [o.graceMs] how long the browser runs with no chat before it is stopped
 * @param {number} [o.commandMs] how long a CDP command may take before it fails
 * @param {typeof setTimeout} [o.setTimer]
 * @param {typeof clearTimeout} [o.clearTimer]
 * @param {{ existsSync: (file: string) => boolean, renameSync: (from: string, to: string) => void }} [o.files] where a finished download gets its name
 */
export function createBrowserHost({
  launch,
  downloadsDir,
  idleMs = 30 * 60_000,
  graceMs = 60_000,
  commandMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  files = fs,
}) {
  let disposed = false;
  /** @type {Promise<Connection> | null} the browser being started, or running */
  let starting = null;
  /** @type {Connection | null} */
  let conn = null;
  /** @type {any} */
  let graceTimer = null;
  /** @type {Map<string, Owner>} */
  const owners = new Map();
  /** @type {Map<string, string>} browser context id -> chat id */
  const byContext = new Map();
  /** @type {Map<string, string>} target id -> chat id */
  const byTarget = new Map();
  /** @type {Map<string, { chatId: string, targetId: string }>} CDP session id -> the tab it belongs to */
  const bySession = new Map();
  /** @type {Map<string, { chatId: string, name: string, dir: string }>} download guid -> the chat it belongs to and where it is saved */
  const byDownload = new Map();

  /**
   * @typedef {{ pipe: Pipe, stop: () => void, nextId: number,
   *   pending: Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }> }} Connection
   * @typedef {{ chatId: string, conn: Connection, context: Promise<string>, targets: Set<string>, roots: Map<string, string>, attaching: Map<string, Promise<object>>,
   *   waiters: ReturnType<typeof createWaiters>, listeners: Set<(e: BrowserEvent) => void>, timer: any }} Owner
   */

  const live = () => {
    if (disposed) throw new BrowserHostError('disposed', 'The browser service was shut down.');
  };

  /** @param {Connection} c @param {string} method @param {object} [params] @param {string} [sessionId] */
  function call(c, method, params = {}, sessionId = '') {
    return new Promise((resolve, reject) => {
      const id = c.nextId++;
      const timer = setTimer(() => {
        c.pending.delete(id);
        reject(new BrowserHostError('timeout', `${method} did not answer.`));
      }, commandMs);
      timer.unref?.();
      c.pending.set(id, { resolve, reject, timer });
      try {
        c.pipe.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      } catch (e) {
        clearTimer(timer);
        c.pending.delete(id);
        reject(new BrowserHostError('browser_exited', /** @type {Error} */ (e).message));
      }
    });
  }

  /** How many page events were too large to pass on since this service started: a page can make one as large as the browser's pipe allows (64 MB), far over what one wire message carries. */
  let droppedEvents = 0;

  /** Delivers an event to a chat's listeners; a failing listener does not stop the others. A page event over `MAX_EVENT` is counted and replaced by a note of its size, never passed on (the connection must not carry what the other end would refuse). @param {string} chatId @param {BrowserEvent} event */
  function emit(chatId, event) {
    if (event.type === 'cdp' && JSON.stringify(event.params).length > MAX_EVENT) {
      droppedEvents++;
      event = { type: 'dropped', targetId: event.targetId, sessionId: event.sessionId, method: event.method };
    }
    for (const fn of [...(owners.get(chatId)?.listeners ?? [])]) {
      try {
        fn(event);
      } catch {
        // one listener's failure is its own
      }
    }
  }

  /** The browser ended or its pipe closed: everything waiting on it fails, every chat hears so, and the next open starts a new one. @param {Connection} c */
  function lost(c) {
    if (conn === c) {
      conn = null;
      starting = null;
    }
    for (const [, p] of c.pending) {
      clearTimer(p.timer);
      p.reject(new BrowserHostError('browser_exited', 'The browser stopped.'));
    }
    c.pending.clear();
    for (const owner of [...owners.values()]) if (owner.conn === c) forget(owner, { type: 'exit' });
  }

  /** Drops a chat and what it owned, and tells it why. @param {Owner} owner @param {BrowserEvent} event */
  function forget(owner, event) {
    clearTimer(owner.timer);
    emit(owner.chatId, event);
    owners.delete(owner.chatId);
    for (const [id, chatId] of byContext) if (chatId === owner.chatId) byContext.delete(id);
    for (const id of owner.targets) byTarget.delete(id);
    for (const [id, s] of bySession) if (s.chatId === owner.chatId) bySession.delete(id);
    for (const [guid, d] of byDownload) if (d.chatId === owner.chatId) byDownload.delete(guid);
    owner.listeners.clear();
    stopLater();
  }

  /** With no chat left the browser stops after the grace time. */
  function stopLater() {
    clearTimer(graceTimer);
    graceTimer = null;
    if (owners.size > 0 || !conn) return;
    const c = conn;
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (owners.size === 0 && conn === c) stopBrowser(c);
    }, graceMs);
    graceTimer.unref?.();
  }

  /** @param {Connection} c */
  function stopBrowser(c) {
    c.stop();
    lost(c);
  }

  /** A browser-level event: tab lifecycle and downloads. @param {any} msg */
  function onEvent(msg) {
    const p = msg.params ?? {};
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    if (!sessionId) return onBrowserEvent(msg.method, p);
    const s = bySession.get(sessionId);
    if (!s) return;
    if (msg.method === 'Target.attachedToTarget' && isId(p.sessionId)) bySession.set(p.sessionId, s);
    if (msg.method === 'Target.detachedFromTarget') {
      bySession.delete(p.sessionId);
      owners.get(s.chatId)?.waiters.letGoSession(p.sessionId, 'The frame went while this command ran.');
    }
    const root = owners.get(s.chatId)?.roots.get(s.targetId);
    emit(s.chatId, { type: 'cdp', targetId: s.targetId, sessionId: sessionId === root ? '' : sessionId, method: msg.method, params: p });
  }

  /** @param {string} method @param {any} p */
  function onBrowserEvent(method, p) {
    if (method === 'Target.targetCreated') {
      const info = p.targetInfo ?? {};
      const chatId = byContext.get(info.browserContextId);
      // a tab a page opened (window.open, target=_blank) belongs to the chat whose context it opened in; the tabs this service opens have no opener
      if (!chatId || info.type !== 'page' || !isId(info.targetId) || !isId(info.openerId) || byTarget.has(info.targetId)) return;
      const owner = /** @type {Owner} */ (owners.get(chatId));
      owner.targets.add(info.targetId);
      byTarget.set(info.targetId, chatId);
      emit(chatId, { type: 'opened', targetId: info.targetId, openerId: info.openerId, url: String(info.url ?? '') });
    } else if (method === 'Target.targetDestroyed') {
      const chatId = byTarget.get(p.targetId);
      const owner = chatId ? owners.get(chatId) : null;
      if (!chatId || !owner) return;
      dropTarget(owner, p.targetId);
      emit(chatId, { type: 'closed', targetId: p.targetId });
    } else if (method === 'Target.detachedFromTarget') {
      // Chromium let go of a tab's own session (the page crashed or navigated across processes): the chat hears that CDP went
      const s = bySession.get(p.sessionId);
      const owner = s ? owners.get(s.chatId) : null;
      if (!s || !owner || owner.roots.get(s.targetId) !== p.sessionId) return;
      owner.roots.delete(s.targetId);
      bySession.delete(p.sessionId);
      owner.waiters.letGo(s.targetId, 'The page went while this command ran.');
      emit(s.chatId, { type: 'cdp', targetId: s.targetId, sessionId: '', method, params: p });
    } else if (method === 'Browser.downloadWillBegin') {
      // a download's frame id is its tab's target id for the main frame
      const chatId = byTarget.get(p.frameId);
      if (!chatId || !isId(p.guid)) return;
      const name = safeName(p.suggestedFilename);
      byDownload.set(p.guid, { chatId, name, dir: path.join(downloadsDir, dirName(chatId)) });
      emit(chatId, { type: 'download', targetId: p.frameId, guid: p.guid, url: String(p.url ?? ''), filename: name, state: 'inProgress' });
    } else if (method === 'Browser.downloadProgress') {
      const d = byDownload.get(p.guid);
      if (!d || (p.state !== 'completed' && p.state !== 'canceled')) return;
      byDownload.delete(p.guid);
      // Chromium saved it under its guid: it gets its own name, and the chat is told where
      const saved = p.state === 'completed' ? nameDownload(d, p.guid, files) : '';
      emit(d.chatId, {
        type: 'download',
        targetId: '',
        guid: p.guid,
        filename: d.name,
        state: p.state === 'completed' && !saved ? 'interrupted' : p.state,
        path: saved,
      });
    }
  }

  /** @param {Owner} owner @param {string} targetId */
  function dropTarget(owner, targetId) {
    owner.targets.delete(targetId);
    byTarget.delete(targetId);
    owner.waiters.letGo(targetId, 'The tab closed while this command ran.');
    const root = owner.roots.get(targetId);
    owner.roots.delete(targetId);
    for (const [id, s] of bySession) if (s.targetId === targetId && s.chatId === owner.chatId) bySession.delete(id);
    if (root) bySession.delete(root);
  }

  /** The running browser, started if there is none. Two callers at once share one start. */
  function browser() {
    live();
    clearTimer(graceTimer);
    graceTimer = null;
    if (starting) return starting;
    const started = launch().then(async (l) => {
      /** @type {Connection} */
      const c = { pipe: l.pipe, stop: l.stop, nextId: 1, pending: new Map() };
      l.pipe.onMessage((msg) => {
        if (typeof msg?.id === 'number') {
          const p = c.pending.get(msg.id);
          if (!p) return;
          c.pending.delete(msg.id);
          clearTimer(p.timer);
          if (msg.error) p.reject(new BrowserHostError('invalid', String(msg.error.message ?? 'The browser refused the command.')));
          else p.resolve(msg.result ?? {});
        } else if (typeof msg?.method === 'string') onEvent(msg);
      });
      l.pipe.onClose(() => lost(c));
      void l.exited.then(() => lost(c));
      if (disposed) {
        stopBrowser(c);
        throw new BrowserHostError('disposed', 'The browser service was shut down.');
      }
      conn = c;
      await call(c, 'Target.setDiscoverTargets', { discover: true }).catch(async (e) => {
        stopBrowser(c);
        throw await startFailure(e, l.exited, { setTimer, clearTimer });
      });
      return c;
    });
    starting = started;
    started.catch(() => {
      if (starting === started) starting = null;
    });
    return started;
  }

  /** @param {string} chatId */
  function owned(chatId) {
    const owner = owners.get(chatId);
    if (!owner) throw new BrowserHostError('not_owned', 'This chat has no browser.');
    return owner;
  }

  /** Each command keeps the chat's tabs for another idleMs. @param {Owner} owner */
  function touch(owner) {
    clearTimer(owner.timer);
    owner.timer = setTimer(() => {
      // release never fails
      if (owners.get(owner.chatId) === owner) void release(owner.chatId);
    }, idleMs);
    owner.timer.unref?.();
  }

  /** The target is the chat's. @param {Owner} owner @param {unknown} targetId */
  function ownedTarget(owner, targetId) {
    if (!isId(targetId) || !owner.targets.has(/** @type {string} */ (targetId)))
      throw new BrowserHostError('not_owned', 'This tab does not belong to this chat.');
    return /** @type {string} */ (targetId);
  }

  /** Opens a tab for the chat in its own context (made on the chat's first), and returns its target id. @param {string} chatId */
  async function open(chatId) {
    if (!isId(chatId)) throw new BrowserHostError('invalid', 'A chat id is required.');
    const c = await browser();
    let owner = owners.get(chatId);
    if (!owner || owner.conn !== c) {
      const created = /** @type {Owner} */ ({
        chatId,
        conn: c,
        targets: new Set(),
        roots: new Map(),
        attaching: new Map(),
        waiters: createWaiters((why) => new BrowserHostError('not_owned', why)),
        listeners: new Set(),
        timer: null,
      });
      created.context = call(c, 'Target.createBrowserContext', { disposeOnDetach: false }).then(async (r) => {
        byContext.set(r.browserContextId, chatId);
        await call(c, 'Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          browserContextId: r.browserContextId,
          downloadPath: path.join(downloadsDir, dirName(chatId)),
          eventsEnabled: true,
        });
        return r.browserContextId;
      });
      owner = created;
      owners.set(chatId, owner);
      owner.context.catch(() => {
        if (owners.get(chatId) === created) forget(created, { type: 'closed', targetId: '' });
      });
    }
    const mine = owner;
    touch(mine);
    const browserContextId = await mine.context;
    const { targetId } = await call(c, 'Target.createTarget', { url: 'about:blank', browserContextId });
    if (owners.get(chatId) !== mine) {
      // released while the tab was being made: it goes with its context, or is closed now
      call(c, 'Target.closeTarget', { targetId }).catch(() => undefined);
      throw new BrowserHostError('not_owned', 'The chat was released while its tab opened.');
    }
    mine.targets.add(targetId);
    byTarget.set(targetId, chatId);
    return { targetId };
  }

  /** Attaches to the tab: its own CDP session, which `command` uses when no frame session is named. @param {string} chatId @param {unknown} targetId */
  async function attach(chatId, targetId) {
    const owner = owned(chatId);
    const id = ownedTarget(owner, targetId);
    touch(owner);
    if (owner.roots.has(id)) return {};
    // two attaches at once share one session
    let pending = owner.attaching.get(id);
    if (!pending) {
      pending = call(owner.conn, 'Target.attachToTarget', { targetId: id, flatten: true }).then(({ sessionId }) => {
        if (owners.get(chatId) !== owner || !owner.targets.has(id)) {
          call(owner.conn, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
          throw new BrowserHostError('not_owned', 'The tab went while it was being attached.');
        }
        owner.roots.set(id, sessionId);
        bySession.set(sessionId, { chatId, targetId: id });
        return {};
      });
      owner.attaching.set(id, pending);
      const done = () => void owner.attaching.delete(id);
      pending.then(done, done);
    }
    return pending;
  }

  /** Takes the tab's sessions out of the chat's hands at once and returns its own session, if it had one. @param {Owner} owner @param {string} id */
  function unroot(owner, id) {
    const root = owner.roots.get(id);
    owner.roots.delete(id);
    owner.waiters.letGo(id, 'The tab was let go while this command ran.');
    for (const [sid, s] of bySession) if (s.targetId === id && s.chatId === owner.chatId) bySession.delete(sid);
    return root;
  }

  /** Lets go of the tab's sessions (its frames' too); the tab stays and `attach` takes it up again. @param {string} chatId @param {unknown} targetId */
  async function detach(chatId, targetId) {
    const owner = owned(chatId);
    const root = unroot(owner, ownedTarget(owner, targetId));
    if (root) await call(owner.conn, 'Target.detachFromTarget', { sessionId: root }).catch(() => undefined);
    return {};
  }

  /**
   * Stop: every tab of the chat loses its sessions at once (a command the Mac still sends fails, not waits), then drops a drag in
   * progress, ends a load under way and detaches, so a page left half-driven is not. Never fails.
   * @param {string} chatId
   */
  async function abort(chatId) {
    const owner = owners.get(chatId);
    if (!owner) return {};
    const roots = [...owner.roots.keys()].map((id) => /** @type {string} */ (unroot(owner, id)));
    await Promise.all(
      roots.map(async (root) => {
        for (const method of ['Input.cancelDragging', 'Page.stopLoading']) await call(owner.conn, method, {}, root).catch(() => undefined);
        await call(owner.conn, 'Target.detachFromTarget', { sessionId: root }).catch(() => undefined);
      }),
    );
    return {};
  }

  /**
   * One CDP command on a tab of the chat (`sessionId` '' is the tab's own session), refused unless the tab and the session are the chat's.
   * @param {string} chatId @param {{ targetId?: unknown, sessionId?: unknown, method?: unknown, params?: unknown }} req
   */
  async function command(chatId, { targetId, sessionId = '', method, params = {} }) {
    const owner = owned(chatId);
    const id = ownedTarget(owner, targetId);
    if (
      typeof method !== 'string' ||
      !METHOD.test(method) ||
      typeof sessionId !== 'string' ||
      typeof params !== 'object' ||
      params === null ||
      Array.isArray(params)
    )
      throw new BrowserHostError('invalid', 'The command is malformed.');
    const domain = method.slice(0, method.indexOf('.'));
    if (REFUSED.has(method) || !ALLOWED_DOMAINS.has(domain) || (domain === 'Target' && !TARGET_ALLOWED.has(method)))
      throw new BrowserHostError('refused', `${method} is not allowed on a tab.`);
    if (method === 'Page.navigate' && !navigable(/** @type {any} */ (params).url))
      throw new BrowserHostError('refused', 'A tab can be sent to a web page only (http, https), not to a file or a page of the browser.');
    if (
      method === 'Target.getTargetInfo' &&
      /** @type {any} */ (params).targetId !== undefined &&
      /** @type {any} */ (params).targetId !== id
    )
      throw new BrowserHostError('refused', 'Target.getTargetInfo may name only the tab itself.');
    const root = owner.roots.get(id);
    if (!root) throw new BrowserHostError('not_owned', 'The tab is not attached.');
    if (sessionId) {
      const s = bySession.get(sessionId);
      if (!s || s.chatId !== chatId || s.targetId !== id)
        throw new BrowserHostError('not_owned', 'This frame does not belong to this tab.');
    }
    touch(owner);
    return owner.waiters.guard(id, sessionId || root, call(owner.conn, method, params, sessionId || root));
  }

  /** Closes one tab of the chat. @param {string} chatId @param {unknown} targetId */
  async function close(chatId, targetId) {
    const owner = owned(chatId);
    const id = ownedTarget(owner, targetId);
    touch(owner);
    await call(owner.conn, 'Target.closeTarget', { targetId: id });
    return {};
  }

  /** The chat ends: its context and tabs go with it. Never fails. @param {string} chatId */
  async function release(chatId) {
    const owner = owners.get(chatId);
    if (!owner) return {};
    const context = await owner.context.catch(() => null);
    forget(owner, { type: 'closed', targetId: '' });
    // the browser dies with its own error (browser_exited) for what waits; a released chat has none to give
    owner.waiters.letGoAll('The chat ended while this command ran.');
    if (context) await call(owner.conn, 'Target.disposeBrowserContext', { browserContextId: context }).catch(() => undefined);
    return {};
  }

  /** The chat's tabs, for a Mac that came back. @param {string} chatId */
  async function tabs(chatId) {
    const owner = owners.get(chatId);
    if (!owner) return [];
    touch(owner);
    return [...owner.targets].map((targetId) => ({ targetId }));
  }

  return {
    open,
    attach,
    detach,
    abort,
    command,
    close,
    release,
    tabs,
    /** How many page events were too large to pass on. */
    get droppedEvents() {
      return droppedEvents;
    },
    /** Hears what happens to the chat's tabs; the returned function stops it. @param {string} chatId @param {(e: BrowserEvent) => void} fn */
    subscribe(chatId, fn) {
      const owner = owned(chatId);
      owner.listeners.add(fn);
      return () => void owner.listeners.delete(fn);
    },
    /** Ends every chat's browser and stops the process. */
    dispose() {
      disposed = true;
      clearTimer(graceTimer);
      for (const owner of [...owners.values()]) forget(owner, { type: 'exit' });
      if (conn) stopBrowser(conn);
    },
  };
}
