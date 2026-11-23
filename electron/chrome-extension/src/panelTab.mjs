// The tab a side panel belongs to, and the chat it shows there (#2325): as Claude in Chrome's and ChatGPT's, each tab has its own panel (sidepanel.html?tabId=N), and the chat picked in it is kept per tab until the tab closes.
//
// The background opens a tab's panel (openPanel, on the toolbar button, its shortcut and the context menu's Ask) with
// that tab's id in the panel's address, so the panel reads its own tab rather than whichever is in front. The chat a
// tab's panel shows is kept in chrome.storage.session (bindingKey): set when a chat is started or picked there, read
// when that tab's panel opens again, cleared when the panel goes to a new chat or the tab closes (forgetTab). A panel
// opened without a tab id (an older way of opening it) follows the tab in front, as before.

/** The panel's page. */
import { bindingKey, composerKey, PANEL_PATH } from './panelState.mjs';
export { bindingKey, draftKey, PANEL_PATH } from './panelState.mjs';

/** The tab id in a panel's address (`?tabId=N`), or null. */
export function ownerOf(/** @type {string} */ search) {
  const raw = new URLSearchParams(search).get('tabId');
  const id = raw == null || raw === '' ? Number.NaN : Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * Opens the tab's own panel, in the call that answers the user's click (Chrome opens a side panel only in answer to a
 * gesture, so neither call is awaited first).
 * @param {any} chrome @param {any} tab @param {(what: string, error: unknown) => void} log
 */
export function openPanel(chrome, tab, log) {
  const tabId = tab?.id;
  if (!Number.isSafeInteger(tabId) || tabId < 0) return;
  const failed = (/** @type {unknown} */ error) => log('open the side panel', error);
  try {
    Promise.resolve(chrome.sidePanel.setOptions({ tabId, path: `${PANEL_PATH}?tabId=${tabId}`, enabled: true })).catch(failed);
    Promise.resolve(chrome.sidePanel.open({ tabId })).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * No panel on a tab the user has not opened one on: the extension-wide panel is off, so each tab shows only its own.
 * @param {any} chrome @param {(what: string, error: unknown) => void} log
 */
export function perTabPanels(chrome, log) {
  const failed = (/** @type {unknown} */ error) => log('keep the side panel per tab', error);
  try {
    Promise.resolve(chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false })).catch(failed);
    Promise.resolve(chrome.sidePanel?.setOptions({ enabled: false })).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** One panel's tab: which it is, the chat kept for it, and whether a tab event is about it. */
export class PanelTab {
  /** @param {{ chrome: any, search: string, log: (what: string, error: unknown) => void, timers?: any, history?: any }} o */
  constructor(o) {
    this.chrome = o.chrome;
    this.timers = o.timers ?? globalThis;
    this.history = o.history;
    this.draftTimer = null;
    this.pendingDraft = null;
    this.choice = undefined;
    this.log = o.log;
    /** the tab this panel belongs to; null: the panel follows the tab in front */
    this.id = ownerOf(o.search);
    this.revision = 0;
    this.retired = false;
    this.draftReady = false;
    this.draftRevision = 0;
    this.lastDraft = null;
  }

  /** The panel's tab as Chrome has it now; null when it is gone. */
  async read() {
    if (this.id == null) {
      const [t] = await this.chrome.tabs.query({ active: true, currentWindow: true });
      return t ?? null;
    }
    return this.chrome.tabs.get(this.id).then(
      (/** @type {any} */ t) => t ?? null,
      () => null,
    );
  }

  /** Whether a tab's update (its page, title or icon) is this panel's tab's. */
  follows(/** @type {number} */ tabId, /** @type {any} */ t) {
    return this.id == null ? !!t?.active : tabId === this.id;
  }

  /** Whether the tab in front changing matters: only to a panel that follows the tab in front. */
  get followsFront() {
    return this.id == null;
  }

  /** The chat kept for this tab, if any. */
  async bound() {
    if (this.id == null) return null;
    const key = bindingKey(this.id);
    const repair = await this.chrome.runtime.sendMessage({ type: 'panelRepair', tabId: this.id });
    if (repair?.error) throw new Error(repair.error);
    const kept = await this.chrome.storage.session.get(key);
    const c = kept?.[key];
    if (c == null) return null;
    if (c?.id === null) {
      this.choice = null;
      return { id: null, title: 'New chat' };
    }
    if (typeof c.id !== 'string' || !c.id) throw new Error("This tab's saved chat couldn't be read. Choose a chat or start a new one.");
    this.choice = { id: c.id, title: String(c.title || 'New chat') };
    return this.choice;
  }

  /** Restore only while no explicit user choice has retired this read; inherited group owners stay inherited. */
  async restore(/** @type {Function} */ ask, /** @type {() => boolean} */ isOpen, /** @type {Function} */ open) {
    if (isOpen() || this.id == null || this.retired) return;
    const revision = this.revision;
    const kept = (await this.bound()) ?? (await ask({ type: 'tabChat', tabId: this.id }))?.chat;
    if (kept?.id && !isOpen() && !this.retired && this.revision === revision)
      open(String(kept.id), String(kept.title || 'New chat'), { persist: false });
  }

  /** A closing or replaced tab retires every late restore and binding write from its old panel. */
  retire(/** @type {number} */ id) {
    if (this.id === id) {
      this.retired = true;
      this.revision++;
    }
  }

  /** The chat this tab's panel shows now (null: a new chat). */
  bind(/** @type {{ id: string, title: string } | null} */ chat, explicit = true) {
    this.revision++;
    this.choice = explicit || chat ? chat : undefined;
    if (this.id == null || this.retired) return;
    void this.write({ type: 'panelBind', tabId: this.id, chat, explicit });
  }

  write(/** @type {object} */ message) {
    return Promise.resolve()
      .then(() => this.chrome.runtime.sendMessage(message))
      .then((r) => {
        if (r?.error) throw new Error(r.error);
        return true;
      })
      .catch((error) => {
        this.log('keep this tab’s chat', error);
        return false;
      });
  }

  async draft() {
    if (this.id == null) return '';
    const key = composerKey(this.id);
    const repair = await this.chrome.runtime.sendMessage({ type: 'panelRepair', tabId: this.id });
    if (repair?.error) throw new Error(repair.error);
    const saved = await this.chrome.storage.session.get(key);
    this.draftReady = true;
    return typeof saved?.[key] === 'string' ? saved[key] : '';
  }

  async takeDraft(/** @type {any} */ box, /** @type {Function} */ ask, /** @type {Function} */ sync) {
    if (!this.draftReady) await this.restoreDraft(box);
    const id = this.id ?? (await this.read())?.id;
    if (!Number.isSafeInteger(id)) return null;
    const text = String((await ask({ type: 'takeDraft', tabId: id }))?.text ?? '');
    if (text) {
      box.value = box.value ? `${box.value}\n\n${text}` : text;
      this.changed();
      box.focus();
    }
    sync();
    return id;
  }

  /** Every human composer writer shares this revision, including context-menu selection and dictation. */
  changed() {
    this.draftRevision++;
    this.draftReady = true;
  }

  async restoreDraft(/** @type {any} */ box) {
    const revision = this.draftRevision;
    const saved = await this.draft();
    if (!this.retired && revision === this.draftRevision && !box.value) box.value = saved;
  }

  keepDraft(/** @type {string} */ text) {
    if (!this.draftReady || this.id == null || this.retired || this.lastDraft === text) return;
    this.pendingDraft = text;
    this.timers.clearTimeout(this.draftTimer);
    this.draftTimer = this.timers.setTimeout(() => this.flushDraft(), 250);
  }

  flushDraft() {
    this.timers.clearTimeout(this.draftTimer);
    const text = this.pendingDraft;
    this.pendingDraft = null;
    if (text == null || this.retired) return;
    this.lastDraft = text;
    void this.write({ type: 'panelDraft', tabId: this.id, text }).then((ok) => {
      if (!ok && this.lastDraft === text) this.lastDraft = null;
    });
  }

  /** The same live document follows the replacement without clearing its unsent composer or chat. */
  follow(/** @type {number} */ added) {
    this.id = added;
    this.retired = false;
    this.revision++;
    this.lastDraft = null;
    this.history?.replaceState(null, '', `${PANEL_PATH}?tabId=${added}`);
    if (this.choice !== undefined) this.bind(this.choice);
  }
}

/** The tab the panel offers as context: a web page's title, address and icon; null for any other page. */
export function tabOf(/** @type {any} */ tab) {
  const url = String(tab?.url ?? '');
  if (!/^https?:\/\//.test(url)) return null;
  return { id: tab.id, url, title: String(tab.title || url), icon: /^https?:\/\//.test(String(tab.favIconUrl)) ? tab.favIconUrl : '' };
}
