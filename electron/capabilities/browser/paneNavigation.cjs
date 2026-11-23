// Sender/chat/page-scoped history copies and legacy guest navigation that retires older browser load waits.
const { randomUUID } = require('node:crypto');
const { noteIgnored } = require('../../ignored.cjs');
const { stopLoading, STOP_LOADING } = require('./loadInterruption.cjs');
const { readHistory, restoreHistory } = require('./historyCopy.cjs');
const { isWebUrl } = require('../../../shared/browser.mjs');
const COPY_MS = 30_000;
const unavailable = () => new Error('This browser tab is no longer available. Try Duplicate again.');

class PaneNavigation {
  constructor({ page, create, chatOf, ownerOf, timeoutMs = COPY_MS }) {
    this.page = page;
    this.create = create;
    this.chatOf = chatOf;
    this.ownerOf = ownerOf;
    this.timeoutMs = timeoutMs;
    this.bindings = new Map();
    this.owners = new WeakMap();
    this.copies = new Map();
  }

  /** Registration is immutable for this live page. Native agent/view ownership wins over renderer claims. */
  bind(sender, paneId, id, chat) {
    if (typeof paneId !== 'string' || !paneId || (chat !== null && (typeof chat !== 'string' || !chat))) throw unavailable();
    const wc = this.page(sender, id);
    const stableChat = chat === null ? null : this.chatOf(chat);
    const owner = this.ownerOf(wc);
    if (owner !== undefined && owner !== stableChat) throw unavailable();
    const claim = this.owners.get(wc);
    if (claim && claim.chat !== stableChat) throw unavailable();
    let bindings = this.bindings.get(sender);
    if (!bindings) this.bindings.set(sender, (bindings = new Map()));
    const existing = bindings.get(paneId);
    if (existing) {
      if (existing.sender !== sender || existing.wc !== wc || existing.chat !== stableChat) throw unavailable();
      return true;
    }
    this.owners.set(wc, { chat: stableChat });
    const binding = { sender, wc, chat: stableChat, paneId };
    bindings.set(paneId, binding);
    const retire = () => {
      bindings.delete(paneId);
      if (!bindings.size) this.bindings.delete(sender);
      wc.removeListener('destroyed', retire);
      sender.removeListener('destroyed', retire);
      sender.removeListener('did-navigate', retire);
      for (const copy of this.copies.values()) if (copy.source === binding || copy.target === binding) this.cancel(sender, copy.token);
    };
    wc.once('destroyed', retire);
    sender.once('destroyed', retire);
    sender.on('did-navigate', retire);
    return true;
  }

  get(sender, paneId) {
    const binding = this.bindings.get(sender)?.get(paneId);
    if (!binding || binding.sender !== sender || this.page(sender, binding.wc.id) !== binding.wc) throw unavailable();
    const owner = this.ownerOf(binding.wc);
    if (owner !== undefined && owner !== binding.chat) throw unavailable();
    return binding;
  }

  capture(sender, paneId, targetPaneId) {
    const source = this.get(sender, paneId);
    if (typeof targetPaneId !== 'string' || !targetPaneId || this.bindings.get(sender).has(targetPaneId)) throw unavailable();
    const history = readHistory(source.wc);
    if (!history) throw new Error('This tab has no usable navigation history yet. Wait for the page, then try Duplicate again.');
    const { entries, index } = history;
    const token = randomUUID();
    let resolveCancel;
    const cancelled = new Promise((resolve) => {
      resolveCancel = resolve;
    });
    /** @type {any} */
    const copy = {
      token,
      source,
      targetPaneId,
      target: null,
      completed: false,
      entries,
      index,
      cancelled,
      resolveCancel,
      consumed: false,
      timer: null,
    };
    const target = this.create(sender, targetPaneId, source.wc, source.chat);
    try {
      this.get(sender, paneId);
      this.bind(sender, targetPaneId, target.id, source.chat);
      copy.target = this.get(sender, targetPaneId);
    } catch (error) {
      target.close();
      throw error;
    }
    copy.timer = setTimeout(() => this.cancel(sender, token), this.timeoutMs);
    copy.timer.unref?.();
    this.copies.set(token, copy);
    return { token, url: entries[index].url, title: entries[index].title, chat: source.chat };
  }

  cancel(sender, token) {
    const copy = this.copies.get(token);
    if (!copy || copy.source.sender !== sender) return false;
    this.copies.delete(token);
    clearTimeout(copy.timer);
    copy.resolveCancel();
    if (!copy.completed && !copy.target.wc.isDestroyed()) {
      try {
        copy.target.wc.close();
      } catch (error) {
        noteIgnored('close an unfinished Duplicate tab', error);
        return false;
      }
    }
    return true;
  }

  async restore(sender, token, paneId) {
    const copy = this.copies.get(token);
    if (!copy || copy.source.sender !== sender || copy.consumed || copy.targetPaneId !== paneId) throw unavailable();
    const source = this.get(sender, copy.source.paneId);
    const target = this.get(sender, paneId);
    if (
      source !== copy.source ||
      target !== copy.target ||
      target.chat !== source.chat ||
      target.wc.session !== source.wc.session ||
      target.wc === source.wc ||
      !['', 'about:blank'].includes(target.wc.getURL())
    )
      throw unavailable();
    copy.consumed = true;
    try {
      // settled once the history is the copy's; its page then loads, stops or fails as any tab's does
      await Promise.race([restoreHistory(target.wc, copy), copy.cancelled]);
      if (this.copies.get(token) !== copy) throw unavailable();
      this.get(sender, source.paneId);
      this.get(sender, paneId);
      copy.completed = true;
      return true;
    } finally {
      this.cancel(sender, token);
    }
  }
}

/** The navigation IPC only accepts pages already admitted by the browser's existing target policy. */
function registerPaneNavigation(ipcMain, deps) {
  const navigation = new PaneNavigation(deps);
  ipcMain.handle('browser:bindPane', (e, paneId, id, chat) => navigation.bind(e.sender, paneId, id, chat));
  ipcMain.handle('browser:captureHistory', (e, paneId, targetPaneId) => navigation.capture(e.sender, paneId, targetPaneId));
  ipcMain.handle('browser:restoreHistory', (e, token, paneId) => navigation.restore(e.sender, token, paneId));
  ipcMain.handle('browser:discardHistory', (e, token) => navigation.cancel(e.sender, token));
  ipcMain.handle('browser:stopLoading', (e, id) => stopLoading(deps.page(e.sender, id)));
  ipcMain.handle('browser:navigateGuest', (e, id, action, url) => {
    const wc = deps.page(e.sender, id);
    if (!['loadURL', 'goBack', 'goForward', 'reload', 'reloadIgnoringCache'].includes(action))
      throw new Error('This browser navigation is not available.');
    if (action === 'loadURL' && url !== 'about:blank' && !isWebUrl(url)) throw new Error('This browser supports http and https pages.');
    wc.emit(STOP_LOADING);
    if (action === 'goBack' || action === 'goForward') return wc.navigationHistory[action]();
    return action === 'loadURL' ? wc.loadURL(url) : wc[action]();
  });
  return navigation;
}
module.exports = { PaneNavigation, registerPaneNavigation, COPY_MS };
