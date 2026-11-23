// Web permissions in the built-in browser's partitions (the shared profile and chats' own), harness-neutral:
// what a page may use of the camera, microphone, location, notifications, clipboard and devices.
//
// - Deny by default. Screen capture (getDisplayMedia) and device choosers (HID, serial, USB) are denied;
//   so are fullscreen, pointer lock and anything not named here, as the app's own session does.
// - The clipboard follows the app's own session (lifecycle.cjs): pages may write it, and read it unless an
//   agent drives the page.
// - Camera, microphone, location and notifications: a page an agent drives is denied, and the agent's next
//   browser result says so. A page the user drives asks on an approval card in the tab's chat
//   (browserPermission: Allow once, Always allow for this site, Deny); a user's own pane tab counts as
//   the chat whose pane shows it (views.cjs chatOf). Only a tab of no chat gets a native dialog. "Always" is remembered per origin and permission; permission checks return what is remembered.
// - Settings → Browser lists the sites allowed for good and removes one (savedWebPermissions): through
//   the running policy for that file, or the file itself before the browser has started.
// - A frame's link to an app (zoommtg:, mailto:), which Electron asks as the openExternal permission, is denied and
//   reported (`external`): the pane offers the user "Open in app" (windows.cjs), never an automatic open.
const { noteIgnored } = require('../../ignored.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { readCheckedStore } = require('../../platform/checkedStore.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { originOf } = require('./origins.cjs');

/** What a user-driven page can be allowed, as the card names it. */
const ASKABLE = ['camera', 'microphone', 'geolocation', 'notifications'];
const LABELS = { camera: 'camera', microphone: 'microphone', geolocation: 'location', notifications: 'notifications' };
/** file -> the running policy saving to it, so Settings edits what the browser checks */
const running = new Map();

/** What a permission request asks for, as ASKABLE names ('media' is the camera and/or microphone). */
function wanted(permission, details) {
  if (permission === 'media') {
    const types = details?.mediaTypes || [];
    return [...(types.includes('video') ? ['camera'] : []), ...(types.includes('audio') ? ['microphone'] : [])];
  }
  return ASKABLE.includes(permission) ? [permission] : [];
}

/** The URL of a page that may be gone. */
function urlOf(wc) {
  try {
    return wc && !wc.isDestroyed() ? wc.getURL() : '';
  } catch {
    return '';
  }
}

class WebPermissions {
  /**
   * @param {{ file?: string | null, register?: boolean,
   *           driver: (wc: any) => { chatId: string, tabId: string, agent: boolean } | null,
   *           ask: (req: { chatId: string | null, origin: string, permissions: string[], wc: any }) => Promise<{ decision: string, scope?: string } | null>,
   *           note: (chatId: string, text: string) => void, external?: (wc: any, url: string) => void }} o
   *   driver: the chat whose tab a page is and whether an agent drives it now (BrowserTabs.driver); null for a page of no chat
   *   ask: the approval card (or a native dialog for a page of no chat); null when it went unanswered
   *   note: a state change for the chat's next browser result (BrowserTabs.change)
   *   register: false for a view of the file that Settings edits, not the running policy
   *   external: a page's frame asked to open a link in another app (BrowserWindows.external)
   */
  constructor(o) {
    this.o = o;
    /** origin -> permissions allowed for good */
    this.always = new Map();
    this.writeError = null;
    /** sessions the handlers are installed on */
    this.installed = new WeakSet();
    /** `${chatId} ${origin} ${permissions}` -> the question being asked */
    this.asking = new Map();
    this.load();
    if (o.file && o.register !== false) running.set(o.file, this);
  }

  load() {
    if (!this.o.file) return;
    const { data, error } = readCheckedStore(
      this.o.file,
      'the saved web permissions',
      (raw) =>
        isJsonRecord(raw) &&
        !Object.hasOwn(raw, 'version') &&
        (!Object.hasOwn(raw, 'origins') ||
          (isJsonRecord(raw.origins) &&
            Object.entries(raw.origins).every(
              ([origin, perms]) => originOf(origin) === origin && Array.isArray(perms) && perms.every((p) => ASKABLE.includes(p)),
            ))),
    );
    this.writeError = error;
    this.saved = isJsonRecord(data) ? data : {};
    this.always.clear();
    for (const [origin, perms] of Object.entries(isJsonRecord(data?.origins) ? data.origins : {})) {
      const ok = Array.isArray(perms) ? perms.filter((p) => ASKABLE.includes(p)) : [];
      if (ok.length && originOf(origin) === origin) this.always.set(origin, new Set(ok));
    }
  }

  save() {
    if (!this.o.file) return;
    if (this.writeError)
      throw new Error("Couldn't read the saved web permissions, so they weren't changed. Restore the file and try again.");
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      const origins = Object.fromEntries([...this.always].map(([origin, perms]) => [origin, [...perms]]));
      writePrivate(this.o.file, JSON.stringify({ ...this.saved, origins }, null, 2));
    } catch (error) {
      noteIgnored('save the sites allowed web permissions for good', error);
      throw new Error("Couldn't save the web permission. Please try again.");
    }
  }

  /** The sites allowed something for good, by origin, with what each may use (in ASKABLE order). */
  list() {
    return [...this.always]
      .map(([origin, perms]) => ({ origin, permissions: ASKABLE.filter((p) => perms.has(p)) }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  /** Forgets what `origin` was allowed for good (pages ask again); returns the sites left. */
  forget(origin) {
    if (this.writeError) this.load();
    const previous = this.always.get(origin);
    if (this.always.delete(origin)) {
      try {
        this.save();
      } catch (error) {
        this.always.set(origin, previous);
        throw error;
      }
    }
    return this.list();
  }

  /** Whether `origin` may use `permission` for good. */
  allowed(origin, permission) {
    return !!this.always.get(origin)?.has(permission);
  }

  /** Puts this policy on a browser session (once per session). */
  install(ses) {
    if (!ses || this.installed.has(ses)) return;
    this.installed.add(ses);
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      this.request(wc, permission, details).then(callback, (error) => {
        // a question that could not be asked is not a yes: the page is denied, and why is kept
        noteIgnored(`decide a page's ${permission} permission request (denied)`, error);
        callback(false);
      });
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => this.check(wc, permission, requestingOrigin, details));
    ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
    ses.setDevicePermissionHandler(() => false);
  }

  /** Whether an agent drives the page now. */
  agentDriven(wc) {
    try {
      return !!this.o.driver(wc)?.agent;
    } catch {
      return false;
    }
  }

  /** A page asks for a permission: resolves whether it gets it. */
  async request(wc, permission, details) {
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'clipboard-read') return !this.agentDriven(wc);
    if (permission === 'openExternal') {
      this.o.external?.(wc, String(details?.externalURL ?? ''));
      return false;
    }
    const perms = wanted(permission, details);
    const origin = originOf(details?.requestingUrl || urlOf(wc));
    if (!perms.length || !origin) return false;
    /** @type {{ chatId: string, tabId: string, agent: boolean } | null} */
    let who = null;
    try {
      who = this.o.driver(wc);
    } catch (error) {
      // handled as a page of no chat
      noteIgnored('find the chat driving a page that asked for a permission', error);
    }
    if (who?.agent) {
      this.o.note(
        who.chatId,
        `permission_denied ${who.tabId}: ${origin} asked for the ${perms.map((p) => LABELS[p]).join(' and ')}, which pages an agent drives can't use. If the task needs it, ask the user to take over the tab.`,
      );
      return false;
    }
    if (perms.every((p) => this.allowed(origin, p))) return true;
    const chatId = who?.chatId ?? null;
    // the page the request came from (a frame in it may be another site), to tell whether it moved on meanwhile
    const page = originOf(urlOf(wc));
    const key = `${chatId} ${origin} ${perms.join(',')}`;
    let pending = this.asking.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.o.ask({ chatId, origin, permissions: perms, wc }))
        .catch((error) => {
          // no answer: the page is denied, which is the safe default
          noteIgnored('ask the user about a site permission', error);
          return null;
        })
        .finally(() => this.asking.delete(key));
      this.asking.set(key, pending);
    }
    const answer = await pending;
    if (answer?.decision !== 'allow') return false;
    if (answer.scope === 'always') {
      if (this.writeError) this.load();
      const previous = this.always.get(origin);
      const set = new Set(previous);
      for (const p of perms) set.add(p);
      this.always.set(origin, set);
      try {
        this.save();
      } catch (error) {
        if (previous) this.always.set(origin, previous);
        else this.always.delete(origin);
        throw error;
      }
    }
    // the page as it is now, not as it was when the card went up: closed, on another site, or the agent driving it
    // again (the user handed the tab back while the card was open) gets nothing from this answer
    if (wc?.isDestroyed?.() || originOf(urlOf(wc)) !== page || this.agentDriven(wc)) return false;
    return true;
  }

  /** A page checks a permission (navigator.permissions, enumerateDevices...): what is remembered. */
  check(wc, permission, requestingOrigin, details) {
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'clipboard-read') return !this.agentDriven(wc);
    const p = permission === 'media' ? { video: 'camera', audio: 'microphone' }[details?.mediaType] : permission;
    const origin = originOf(requestingOrigin || details?.requestingUrl || urlOf(wc));
    if (!p || !ASKABLE.includes(p) || !origin || this.agentDriven(wc)) return false;
    return this.allowed(origin, p);
  }
}

/**
 * The native dialog for a page of no chat (a pane tab the user opened outside a chat): Deny, Allow once or
 * Always allow for this site, on the window that shows the page, or standing alone when none does.
 * @param {{ showMessageBox: Function }} dialog
 * @param {(wc: any) => any} windowOf the app window showing the page (a view's window, or a <webview>'s host), or null
 */
function dialogAsk(dialog, windowOf) {
  return async ({ origin, permissions, wc }) => {
    let win = null;
    try {
      win = windowOf(wc) ?? null;
    } catch (error) {
      // no window: the dialog stands alone
      noteIgnored('find the window of a page that asked for a permission', error);
    }
    const options = {
      type: 'question',
      message: `${origin} wants to use your ${permissions.map((p) => LABELS[p]).join(' and ')}`,
      buttons: ['Deny', 'Allow once', 'Always allow for this site'],
      defaultId: 0,
      cancelId: 0,
    };
    const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    return [{ decision: 'deny' }, { decision: 'allow', scope: 'once' }, { decision: 'allow', scope: 'always' }][response] || null;
  };
}

/**
 * What Settings edits for `file`: the running policy, or (before the browser started) one that only
 * reads and writes the file, which the policy loads when it starts.
 * @param {string} file
 */
function savedWebPermissions(file) {
  // a file-only view never installs, asks or checks, so it needs no driver, card or note
  return running.get(file) ?? new WebPermissions(/** @type {any} */ ({ file, register: false }));
}

module.exports = { WebPermissions, savedWebPermissions, dialogAsk, wanted, ASKABLE };
