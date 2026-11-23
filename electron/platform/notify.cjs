// notify(kind, chatId): every system notification goes through here. It reads the Notifications
// setting (prefs.notifyOnComplete), keeps one notification per chat, lets "needs you" outrank
// "done", and merges same-kind notifications from different chats within 60 seconds.

const { noteIgnored } = require('../ignored.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const { createQuietHold } = require('./quietHold.cjs');

/** OS notification failures must not interrupt the task or state change being reported. */
function notificationIO(action) {
  try {
    return action();
  } catch (error) {
    noteIgnored('show or close an OS notification', error);
    return null;
  }
}

/** The kinds a window may send, each with its switch in Settings › General › Notifications. */
const KINDS = ['turn', 'approval', 'scheduled', 'goal', 'auth', 'computer'];
// 'momo' is MoMo's own (electron/momo/notices.cjs), switched in Settings › MoMo: main makes it, never a window. A pull
// request has no kind: only a session's question interrupts the user, and the PR inbox shows the rest (#3661)
const ALL_KINDS = [...KINDS, 'momo'];
const MODES = ['unfocused', 'always', 'needed', 'never'];
const MERGE_MS = 60_000;
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { momoMergedTitle } = require('../../shared/momoNotices.mjs');
// a "needs you" notification keeps a later "done" one for the same chat from replacing it for this long
const HOLD_MS = 10 * 60_000;

/** Approval, authorization, a goal that stopped short and MoMo needing an answer need the user; the rest report something done. */
function needsYou(kind, status) {
  if (kind === 'approval' || kind === 'auth') return true;
  if (kind === 'momo') return status === 'needs';
  return kind === 'goal' && status !== 'complete';
}

/**
 * Whether the setting lets this notification through. `seen` means the user is looking at the
 * chat in a focused window. "Never" lets nothing through.
 */
function allowed(mode, needs, seen) {
  switch (MODES.includes(mode) ? mode : 'unfocused') {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'needed':
      return needs && !seen;
    default:
      return !seen;
  }
}

function mergedTitle(kind, needs, n, group = null) {
  if (kind === 'momo') return momoMergedTitle(n);
  if (needs) return `${n} chats need you`;
  if (kind === 'scheduled') return group === 'failed' ? `${n} scheduled tasks didn't start` : `${n} scheduled tasks started`;
  if (kind === 'goal') return `${n} goals complete`;
  if (kind === 'computer') return group === 'done' ? `${n} chats are done using apps` : `${n} chats are using apps`;
  return `${n} chats finished`;
}

class Notifier {
  /**
   * @param {object} o
   * @param {(n: {id: string, groupId: string, title: string, body: string, chatId: string}) => {close(): void} | null} o.show
   * @param {() => string} o.getMode the current Notifications setting
   * @param {() => Record<string, boolean>} [o.getKinds] per-kind switches (prefs.notifyKinds); a kind set to false never notifies
   * @param {() => boolean} [o.isFocused] whether any app window has focus
   * @param {() => number} [o.now]
   * @param {(n: { title: string, body: string }) => void} [o.showNotice] how a notice the person asked for is shown
   * @param {(b: { kind: string, chatId: string, needs: boolean, chatTitle: string, cardId?: string, channelId?: string }) => void} [o.onBanner] called when an OS banner is about to be shown (`cardId`: the card a "needs you" banner is for, when its caller named one; `channelId`: the channel a MoMo banner's chat is the journal of)
   * @param {(chatId: string) => boolean} [o.isLinkedChild] whether the chat is a session another chat started and still reports to; its "done" says nothing (the parent's wake-up turn reports for the family), its "needs you" still does
   * @param {{ hold(chatId: string, needs: boolean, kind?: string): boolean, retract(chatId: string): void, check(): Promise<void> } | null} [o.quietHold] keeps back the banners of the quiet hours (quietHold.cjs); MoMo's keep their own
   */
  constructor({
    show,
    getMode,
    getKinds = () => ({}),
    isFocused = () => false,
    now = Date.now,
    showNotice = () => undefined,
    onBanner = () => undefined,
    isLinkedChild = () => false,
    quietHold = null,
  }) {
    this.isLinkedChild = isLinkedChild;
    this.onBanner = onBanner;
    /** @type {(chatId: string) => void} a chat's need is answered or opened: a push still waiting for the person to leave the Mac is dropped (notifyPush.cjs) */
    this.onSettled = () => undefined;
    /** @type {() => number | null} ms since the Mac's last input (the OS idle time); null when unknown */
    this.idleMs = () => null;
    this.quietHold = quietHold;
    /** @type {(held: { chatId: string, at: number, count: number }) => Promise<boolean> | boolean} says the chats held through quiet hours need the person (the push bridge's catchUp); false: not yet, try again */
    this.onCatchUp = () => false;
    this.getKinds = getKinds;
    this.show = show;
    this.showNotice = showNotice;
    this.getMode = getMode;
    this.isFocused = isFocused;
    this.now = now;
    this.byChat = new Map(); // chatId -> entry
    this.groups = new Map(); // merge key -> current group; entries retain their group after it expires
    /** while a chat controls the whole screen: kind/chat -> the latest notify() arguments, shown when it lets go */
    this.deferred = null;
    /** @type {(kind: string, chatId: string, opts?: { cardId?: unknown }) => boolean} notices kept back (MoMo's chats, electron/momo/quietNotices.cjs); `opts` is what notify() was given */
    this.quiet = () => false;
  }

  /** The quiet hours, or the clock, may have changed (new settings, the Mac woke): what waited through quiet hours is said now if they ended. */
  quietChanged() {
    return this.quietHold?.check();
  }

  /** Keep back the notices `quiet(kind, chatId)` names, from every caller (the chats whose own place shows them). */
  setQuiet(/** @type {(kind: string, chatId: string, opts?: { cardId?: unknown }) => boolean} */ quiet) {
    this.quiet = quiet;
  }

  /**
   * While a chat controls the whole screen (on), notifications wait: a banner would sit over what the agent clicks,
   * and the helper refuses a click on a banner. Approvals don't wait (the person must answer them). Off shows what
   * waited (the latest per kind and chat).
   */
  hold(on) {
    if (on) {
      this.deferred ??= new Map();
      return;
    }
    const waited = this.deferred;
    this.deferred = null;
    for (const [kind, chatId, opts] of waited?.values() ?? []) this.notify(kind, chatId, opts);
  }

  /**
   * A notice the person asked for (a menu action saying it started), outside the per-chat rules: none while
   * Notifications is Never, and none while a chat controls the whole screen, where a banner would sit over what it
   * clicks. Dropped then, not held: it says what is happening now.
   * @param {{ title: string, body: string }} n
   */
  notice(n) {
    if (this.getMode() === 'never' || this.deferred) return;
    this.showNotice(n);
  }

  settled(chatId) {
    try {
      this.onSettled(chatId);
    } catch (error) {
      noteIgnored('drop a push waiting for the person to leave the Mac', error);
    }
  }

  childOf(chatId) {
    try {
      return !!this.isLinkedChild(chatId);
    } catch (error) {
      noteIgnored('look up whether a chat is a linked session', error);
      return false;
    }
  }

  /** Returns what was shown ({title, body, chats}), or null when nothing was. */
  notify(kind, chatId, opts = {}) {
    if (!ALL_KINDS.includes(kind) || typeof chatId !== 'string' || !chatId) return null;
    if (this.quiet(kind, chatId, opts)) return null;
    if (this.getKinds()?.[kind] === false) return null;
    const needs = needsYou(kind, opts.status);
    // a chat that needs the person (an approval) is never held back while another clicks, as Claude Desktop's aren't
    if (this.deferred && !needs) {
      // MoMo's is dropped, never shown later: whether MoMo is on, its switch and quiet hours were decided now (MoMo's chat keeps the item)
      if (kind === 'momo') return null;
      const k = identityKey(kind, chatId);
      this.deferred.delete(k);
      this.deferred.set(k, [kind, chatId, opts]);
      return null;
    }
    const seen = !!opts.viewing && this.isFocused();
    if (!allowed(this.getMode(), needs, seen)) return null;
    // a linked child finishing is the parent's news (its wake-up turn notifies once for the family), as Claude's background agents don't push on their own
    if (!needs && (kind === 'turn' || kind === 'goal') && this.childOf(chatId)) return null;
    const now = this.now();
    const prio = needs ? 2 : 1;
    const held = this.byChat.get(chatId);
    if (held && held.prio > prio && now - held.at < HOLD_MS) return null;
    // in quiet hours the banner (and so its push) waits; a "needs you" is said once when they end
    if (kind !== 'momo' && this.quietHold?.hold(chatId, needs, kind)) return null;
    const title = String(opts.title ?? '');
    try {
      const cardId = typeof opts.cardId === 'string' && opts.cardId ? { cardId: opts.cardId } : {};
      const channelId = typeof opts.channelId === 'string' && opts.channelId ? { channelId: opts.channelId } : {};
      this.onBanner({
        kind,
        chatId,
        needs,
        chatTitle: String(opts.chatTitle ?? ''),
        ...cardId,
        ...channelId,
      });
    } catch (error) {
      noteIgnored('report a banner to the push hook', error);
    }

    const body = String(opts.body ?? '');
    // a kind's own groups (computer control: "using" and "done") merge apart
    const sub = typeof opts.group === 'string' ? opts.group : null;
    const key = `${kind}:${needs ? 'needs' : 'done'}${sub ? `:${sub}` : ''}`;
    const previous = this.groups.get(key);
    const others = previous && now - previous.at < MERGE_MS ? [...previous.chats.keys()].filter((c) => c !== chatId) : [];
    const group = others.length ? previous : { kind, needs, sub, at: now, chats: new Map() };
    this._closeChat(chatId, group);
    group.chats.delete(chatId);
    group.chats.set(chatId, {
      title,
      body,
      chatTitle: opts.chatTitle ?? title,
    });
    group.at = now;
    this.groups.set(key, group);
    return this._showGroup(key, group, chatId);
  }

  /** Show only the live members, using the original message when one chat remains. */
  _showGroup(key, group, chatId) {
    const chats = [...group.chats.keys()];
    const merged = chats.length > 1;
    const message = group.chats.get(chatId);
    const shown = {
      title: merged ? mergedTitle(group.kind, group.needs, chats.length, group.sub) : message.title,
      body: merged
        ? prefixUnits(
            [...group.chats.values()]
              .map((m) => m.chatTitle)
              .filter(Boolean)
              .reverse()
              .join(', '),
            180,
          )
        : message.body,
      chats,
    };
    notificationIO(() => group.entry?.handle?.close());
    const handle = notificationIO(() =>
      this.show({
        id: merged ? `merged:${key}` : `chat:${chatId}`,
        groupId: merged ? 'merged' : chatId,
        title: shown.title,
        body: shown.body,
        chatId,
      }),
    );
    if (!handle) {
      this._discardGroup(key, group);
      return null;
    }
    const entry = {
      prio: group.needs ? 2 : 1,
      kind: group.kind,
      at: group.at,
      key,
      group,
      chats,
      handle,
    };
    group.entry = entry;
    for (const c of chats) this.byChat.set(c, entry);
    return shown;
  }

  /**
   * Clicking a merged notification dismisses its group and releases its priority holds.
   * @param {{close(): void}} [expectedHandle] the notification whose click arrived
   */
  clear(chatId, expectedHandle) {
    if (!expectedHandle) for (const kind of ALL_KINDS) this.deferred?.delete(identityKey(kind, chatId));
    this.settled(chatId);
    const e = this.byChat.get(chatId);
    if (!e || (expectedHandle && e.handle !== expectedHandle)) return;
    this._discardGroup(e.key, e.group);
    notificationIO(() => e.handle?.close());
  }

  /** Every notice whose chat key `match` names goes (MoMo's on revoke: electron/momo/notices.cjs). */
  clearMatching(/** @type {(chatId: string) => boolean} */ match) {
    for (const chatId of [...this.byChat.keys()]) if (match(chatId)) this.clear(chatId);
  }

  /** A closed or unshown group owns no visible members or priority holds. */
  _discardGroup(key, group) {
    for (const c of group.chats.keys()) if (this.byChat.get(c)?.group === group) this.byChat.delete(c);
    group.chats.clear();
    if (this.groups.get(key) === group) this.groups.delete(key);
  }

  /** Answered approvals leave the group; unresolved chats keep their own notification. */
  retract(chatId) {
    this.deferred?.delete(identityKey('approval', chatId));
    this.quietHold?.retract(chatId);
    this.settled(chatId);
    if (this.byChat.get(chatId)?.kind === 'approval') this._closeChat(chatId);
  }

  // A same-group replacement is rendered once by notify(), after the new message is added.
  /** @param {object | null} [replacingGroup] */
  _closeChat(chatId, replacingGroup = null) {
    const e = this.byChat.get(chatId);
    if (!e) return;
    this.byChat.delete(chatId);
    e.group.chats.delete(chatId);
    if (!e.group.chats.size) {
      notificationIO(() => e.handle?.close());
      if (this.groups.get(e.key) === e.group) this.groups.delete(e.key);
    } else if (e.group !== replacingGroup) {
      this._showGroup(e.key, e.group, [...e.group.chats.keys()].at(-1));
    }
  }
}

/**
 * A notice the person asked for, outside the chat rules above (a menu action saying it started, such as Help >
 * Capture Performance Profile): shown where the OS supports notifications, and a failure is noted, never thrown.
 * @param {{ Notification: Pick<typeof import('electron').Notification, 'isSupported'> & (new (o: { title: string, body: string }) => { show(): void }) }} electron
 * @param {{ title: string, body: string }} notice
 */
function showNotice({ Notification }, { title, body }) {
  if (!Notification.isSupported()) return;
  notificationIO(() => new Notification({ title, body }).show());
}

/**
 * Wires the notifier to Electron: app:notify(kind, chatId, opts) from any window.
 * @param {any} ipcMain
 * @param {object} o
 * @param {any} o.Notification
 * @param {() => string} o.getMode
 * @param {() => Record<string, boolean>} [o.getKinds]
 * @param {() => boolean} [o.isFocused]
 * @param {(chatId: string) => unknown} [o.onClick]
 * @param {(b: { kind: string, chatId: string, needs: boolean, chatTitle: string }) => void} [o.onBanner]
 * @param {(chatId: string) => boolean} [o.isLinkedChild] a session another chat started and still reports to
 * @param {() => unknown} [o.getQuietHours] the quiet hours setting (prefs.notifyQuietHours); with quietFile, banners wait through them (quietHold.cjs)
 * @param {string} [o.quietFile] where what waited is kept
 * @param {{ on(event: string, fn: () => void): unknown, getSystemIdleTime?(): number }} [o.powerMonitor] looks at the clock again when the Mac wakes; its idle time tells whether the person is at the Mac
 */
function registerNotify(
  ipcMain,
  { Notification, getMode, getKinds, isFocused, isLinkedChild, onClick, onBanner, getQuietHours, quietFile, powerMonitor },
) {
  /** @type {Notifier} */
  let notifier;
  const quietHold =
    getQuietHours && quietFile
      ? createQuietHold({
          quietHours: getQuietHours,
          file: quietFile,
          deliver: (held) => notifier.onCatchUp(held),
          // the mode and switches as they are when the hours end
          still: (kind) => getMode() !== 'never' && getKinds?.()?.[kind] !== false,
        })
      : null;
  notifier = new Notifier({
    quietHold,
    onBanner,
    isLinkedChild,
    getMode,
    getKinds,
    isFocused,
    showNotice: (n) => showNotice({ Notification }, n),
    show: ({ id, groupId, title, body, chatId }) => {
      if (!Notification.isSupported())
        return {
          close() {
            /* nothing to close: no notification was shown */
          },
        };
      const n = new Notification({ id, groupId, title, body, silent: false });
      const handle = { close: () => n.close() };
      let failed = false;
      n.on('failed', (_event, error) => {
        failed = true;
        notifier.clear(chatId, handle);
        noteIgnored('deliver an OS notification', error);
      });
      n.on('click', () => {
        notifier.clear(chatId, handle);
        onClick?.(chatId);
      });
      n.show();
      // Native failure may be emitted during show(), before Notifier records the handle.
      return failed ? null : handle;
    },
  });
  notifier.idleMs = () => (typeof powerMonitor?.getSystemIdleTime === 'function' ? powerMonitor.getSystemIdleTime() * 1000 : null);
  // a Mac that slept through the quiet hours says what waited at the first moment it is awake
  powerMonitor?.on('resume', () => void notifier.quietChanged());
  ipcMain.handle('app:notify', (_e, kind, chatId, opts) => {
    // a window can't make a MoMo notice ('momo' isn't one of its kinds): only main knows whether MoMo is on and what it may say
    if (!KINDS.includes(kind)) return;
    notifier.notify(kind, chatId, opts && typeof opts === 'object' ? opts : {});
  });
  return notifier;
}

module.exports = {
  Notifier,
  registerNotify,
  showNotice,
  needsYou,
  allowed,
  mergedTitle,
  KINDS,
  MODES,
  MERGE_MS,
  HOLD_MS,
};
