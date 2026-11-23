// The extension's service worker wiring (design D5, B2 step 2): Chrome's events to the sessions, the connection to MoPilot, pairing from its page, the toolbar badge.
//
// The pairing code lives in chrome.storage.local (only this extension reads it); the options page sets or
// clears it with a runtime message, which only this extension's own pages may send. While it isn't paired (or MoPilot no longer knows its code), it asks MoPilot's native host for a claim code on install, at startup and with
// every reconnect alarm; MoPilot then asks the user "Allow Chrome to connect?" and the pairing
// completes with no page and no code (#1632). Disconnect on the page holds those asks until the user presses Connect.
import { Client, claimPairing } from './client.mjs';
import { ContextMenu } from './contextMenu.mjs';
import { Downloads } from './downloads.mjs';
import { PanelLink, REQUEST_MS, START_MS } from './panelLink.mjs';
import { readPolicy } from './policy.mjs';
import { NATIVE_HOST, PROTOCOL_VERSION, parseClaimCode, parsePairingCode } from './protocol.mjs';
import { openPanel, perTabPanels } from './panelTab.mjs';
import { PanelState } from './panelState.mjs';
import { Sessions } from './sessions.mjs';
import { TabNotices } from './tabNotices.mjs';
import { setSurvey } from './uninstallSurvey.mjs';
import { Updates } from './updates.mjs';

export const RECONNECT_ALARM = 'mopilot-reconnect';
/** The badge only when the user has something to do, as Claude in Chrome's amber "!" (connected or connecting: none). */
const BADGE = Object.assign(Object.create(null), { unauthorized: '!', unpaired: '!', 'update-required': '!' });
export const BADGE_COLOR = '#F59E0B';
/** Where Download MoPilot goes: the app's download page, which offers the build for this computer. */
export const DOWNLOAD_URL = 'https://mopilot.ai/download';
/** Chrome's answer to a native message when no host is installed: MoPilot isn't on this computer. */
export const HOST_MISSING = /native messaging host not found/i;

/**
 * The pairing as stored, or null.
 * @param {any} chrome
 */
export async function readPairing(chrome) {
  const got = await chrome.storage.local.get('pairing');
  return parsePairingCode(got?.pairing);
}

/** MoPilot's answer while the user hasn't yet answered its "Allow Chrome to connect?" card. */
export const PENDING = Object.freeze({ pending: true });
/** MoPilot's answer when it could not vouch for the host just now (it refused it, or failed to check it): ask again soon. */
export const RETRY = Object.freeze({ retry: true });
/** How often the extension asks again while that card is up, and for how long after the first pending answer. */
export const ASK_AGAIN_MS = 2_000;
export const ASK_FOR_MS = 120_000;
/** How many times a claim the host handed over may fail to trade before the extension waits for the reconnect alarm. */
export const CLAIM_TRIES = 5;
/** How often the page's "Open MoPilot" asks again while the app starts, and for how long. */
export const LAUNCH_AGAIN_MS = 1_000;
export const LAUNCH_FOR_MS = 30_000;

/**
 * The claim code MoPilot's native host hands over for a pairing MoPilot offers now; PENDING while MoPilot
 * asks the user; RETRY when MoPilot refused or failed to check this host, which may pass at the next ask; or null: no host installed, MoPilot not running or offering none, or an answer that isn't a claim
 * code. `auto`: the extension asks by itself (install, startup, the alarm), so MoPilot answers it with a pairing
 * only once the user allowed it in MoPilot. `missing` hears whether Chrome found no host at all.
 * @param {any} chrome @param {{ auto?: boolean, missing?: (yes: boolean) => void }} [o]
 * @returns {Promise<{ port: number, token: string } | typeof PENDING | typeof RETRY | null>}
 */
export async function askHost(chrome, { auto = false, missing } = {}) {
  let answer;
  try {
    answer = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'claim', protocol: PROTOCOL_VERSION, auto });
  } catch (error) {
    // no host installed (the usual case before MoPilot installs one) or it couldn't start: the page pairs instead
    missing?.(HOST_MISSING.test(String(/** @type {any} */ (error)?.message)));
    return null;
  }
  missing?.(false);
  if (answer?.type === 'claim') return parseClaimCode(answer.code);
  if (answer?.type === 'refused' || answer?.type === 'error') return RETRY;
  return answer?.pending === true ? PENDING : null;
}

/** The statuses in which the extension asks the native host for a pairing. */
const NEEDS_PAIRING = new Set(['unpaired', 'unauthorized']);

/**
 * Starts the extension in a service worker's global scope (`g`: chrome, WebSocket, crypto, the timers and, in tests, now).
 * @param {any} g
 */
export function startBackground(g) {
  const chrome = g.chrome;
  const log = (what, error) => console.warn(`MoPilot: couldn't ${what}:`, error);
  /** @type {Client} */
  let client;
  // Disconnect on the page: the extension doesn't ask MoPilot by itself until Connect (kept across restarts)
  let held = false;
  const holding = chrome.storage.local.get('held').then(
    (got) => {
      held = got?.held === true;
    },
    (error) => log('read whether the extension was disconnected', error),
  );
  const hold = (/** @type {boolean} */ on) => {
    held = on;
    return on ? chrome.storage.local.set({ held: true }) : chrome.storage.local.remove('held');
  };
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch((error) => log('color the badge', error));
  /** The side panel's pages hear of MoPilot's updates and of the connection changing (no page open: dropped). */
  const toPanel = (/** @type {object} */ event) => {
    Promise.resolve(chrome.runtime.sendMessage({ type: 'panelEvent', event })).catch((error) => {
      // no side panel open is the usual case, not a failure
      if (!/Receiving end does not exist/.test(String(error?.message))) log('tell the side panel what changed', error);
    });
  };
  const panel = new PanelLink({ send: (m) => client.send(m), connected: () => client.status === 'connected', event: toPanel, timers: g });
  const sessions = new Sessions({ chrome, send: (m) => client.send(m), storage: chrome.storage.session, log, sourcedPopups: true });
  // the side panel's notice for the tab in front, and the blocked page for an agent's tab (tabNotices.mjs)
  const notices = new TabNotices({ chrome, held: (tabId) => sessions.owner.has(tabId), notify: () => toPanel({ kind: 'tabNotice' }), log });
  sessions.debuggers.onBlocked = (tabId) => notices.extensionBlocked(tabId);
  const panelState = new PanelState(chrome);
  const menu = new ContextMenu({ chrome, state: panelState, notify: (tabId) => toPanel({ kind: 'draft', tabId }), log });
  // an update Chrome downloaded is applied once no agent holds a tab (updates.mjs)
  const updates = new Updates({ chrome, idle: () => sessions.owner.size === 0, log });
  /** Chrome found no native host when the extension last asked: MoPilot isn't installed on this computer */
  let missing = false;
  const sawHost = (/** @type {boolean} */ yes) => {
    missing = yes;
  };
  client = new Client({
    WebSocket: g.WebSocket,
    crypto: g.crypto,
    pairing: () => readPairing(chrome),
    sessions,
    ready: sessions.restore(),
    version: chrome.runtime.getManifest().version,
    timers: g,
    log,
    policy: () => readPolicy(chrome),
    panel: (m) => panel.receive(m),
    onStatus: (status) => {
      if (status !== 'connected') panel.drop();
      toPanel({ kind: 'status', status });
      // MoPilot no longer knows the stored code (it paired again, or took another port): ask its host
      if (status === 'unauthorized') void pairFromHost().catch((error) => log("pair through MoPilot's native host", error));
      chrome.action.setBadgeText({ text: BADGE[status] ?? '' }).catch((error) => log('set the badge', error));
    },
  });

  // a download a chat's agent starts in its tab is reported to MoPilot (downloads.mjs)
  const downloads = new Downloads({ chrome, owner: (tabId) => sessions.owner.get(tabId), send: (m) => client.send(m), log });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    sessions.onDebuggerEvent(source, method, params);
    downloads.cdp(source, method, params);
  });
  chrome.downloads.onCreated.addListener((item) => downloads.created(item));
  // the user brought a chat's tab to the front (the agent's own tabs open in the background): MoPilot keeps it
  // open when the chat lets go of its tabs
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    const chat = sessions.owner.get(tabId);
    if (chat) client.send({ chat, method: 'chrome.tabs.onActivated', params: [tabId] });
  });
  chrome.downloads.onChanged.addListener((delta) => void downloads.changed(delta));
  chrome.debugger.onDetach.addListener((source, reason) => sessions.onDebuggerDetach(source, reason));
  chrome.tabs.onCreated.addListener((tab) => sessions.onTabCreated(tab));
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => sessions.onNavigationTarget(details));
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.onTabRemoved(tabId);
    void panelState.forget(tabId).catch((error) => log('forget a closed tab’s chat', error));
  });
  chrome.tabs.onReplaced.addListener((added, removed) => {
    void panelState.replace(added, removed).then(
      () => toPanel({ kind: 'tabReplaced', added, removed }),
      (error) => {
        log('keep a replaced tab’s chat', error);
        toPanel({ kind: 'tabReplaced', added, removed, failed: true });
      },
    );
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => sessions.onTabUpdated(tabId, change, tab));
  // installed (or turned on for the first time): the page shows the connection coming up, as both vendors open one
  chrome.runtime.onInstalled.addListener((details) => {
    // the page as a checklist, as ChatGPT's install page is: connected, pinned, Try it
    if (details?.reason === 'install')
      sessions
        .openTab({ url: chrome.runtime.getURL('options.html#welcome') }, { focused: true })
        .catch((error) => log('open its page', error));
  });
  setSurvey(chrome, log);
  // the toolbar button (and its shortcut) opens the side panel of the tab it was clicked on, as both vendors' do; a tab
  // the user hasn't opened one on shows none (panelTab.mjs)
  perTabPanels(chrome, log);
  chrome.action.onClicked.addListener((tab) => openPanel(chrome, tab, log));
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== RECONNECT_ALARM) return;
    void connectOrPair();
    updates.apply();
  });
  chrome.runtime.onStartup.addListener(() => void connectOrPair());
  // the administrator changed the policy: connect again, so MoPilot gets the new blocked sites with the handshake
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'managed') void client.reset();
  });

  /** Connects, then pairs through the native host when it has no code to connect with; failures are logged. */
  function connectOrPair() {
    return holding
      .then(() => client.connect())
      .then(() => pairFromHost())
      .catch((error) => log("pair through MoPilot's native host", error));
  }

  /** Trades a claim code for the pairing code and keeps it; resolves with the port, or null when MoPilot refused. */
  async function claim(/** @type {{ port: number, token: string }} */ c) {
    const code = await claimPairing(g.WebSocket, c, { timers: g });
    const parsed = parsePairingCode(code);
    if (!parsed) return null;
    await chrome.storage.local.set({ pairing: code });
    await client.reset();
    return parsed.port;
  }

  /** @type {Promise<number | null> | null} the native host pairing under way: overlapping asks share it */
  let hostPairing = null;
  /** "Open MoPilot" from the page: since when the native host is starting it, and the timer that asks again. */
  const launching = { since: 0, timer: /** @type {any} */ (null) };
  /** Asks the host to open MoPilot, starting it when it isn't running; again every second for 30 s while it starts. */
  async function launch() {
    const answer = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'open', protocol: PROTOCOL_VERSION, what: 'app' }).then(
      (a) => {
        sawHost(false);
        return a;
      },
      (error) => {
        sawHost(HOST_MISSING.test(String(error?.message)));
        return null;
      },
    );
    const now = (g.now ?? Date.now)();
    // gives up only 30 s after the first "starting" (none yet: since is 0, which a real clock is always far past)
    if (answer?.type === 'opened' || answer?.starting !== true || (launching.since > 0 && now - launching.since >= LAUNCH_FOR_MS)) {
      launching.since = 0;
      // it is up: connect now rather than at the next retry, and ask it for the pairing it may now offer
      if (answer?.type === 'opened') {
        await client.reset();
        await pairFromHost();
      }
      return answer?.type === 'opened';
    }
    launching.since ||= now;
    launching.timer ??= g.setTimeout(() => {
      launching.timer = null;
      void launch().catch((error) => log('open MoPilot', error));
    }, LAUNCH_AGAIN_MS);
    return true;
  }
  /** While MoPilot asks the user: since when, the timer that asks the host again, and the claims traded in vain since. */
  const waiting = { since: 0, timer: /** @type {any} */ (null), silent: false, failed: 0, retrying: 0 };
  /** Asks the host again in ASK_AGAIN_MS (once at a time), instead of waiting for the next reconnect alarm. */
  const askAgain = () => {
    waiting.timer ??= g.setTimeout(() => {
      waiting.timer = null;
      void pairFromHost().catch((error) => log("pair through MoPilot's native host", error));
    }, ASK_AGAIN_MS);
  };
  /**
   * The host's answer: a claim is traded (a trade that fails, as when the app's socket isn't taking connections yet, asks
   * the host again, for CLAIM_TRIES at most, since the user's Allow is not asked twice); PENDING asks again shortly, for
   * ASK_FOR_MS at most; RETRY (MoPilot could not vouch for the host this time) asks again the same way, for the same
   * time, and leaves the user's question as it is; anything else ends the wait.
   */
  const answered = (/** @type {any} */ c) => {
    if (c === RETRY) {
      waiting.silent = false;
      const at = (g.now ?? Date.now)();
      waiting.retrying ||= at;
      if (at - waiting.retrying < ASK_FOR_MS) askAgain();
      return null;
    }
    waiting.retrying = 0;
    // no answer at all: MoPilot isn't running (or its host isn't installed), so Connect may start it
    waiting.silent = c === null;
    if (c !== PENDING) {
      waiting.since = 0;
      if (!c) {
        waiting.failed = 0;
        return null;
      }
      return claim(c).then((port) => {
        if (port !== null) waiting.failed = 0;
        else if (++waiting.failed < CLAIM_TRIES) askAgain();
        return port;
      });
    }
    const now = (g.now ?? Date.now)();
    waiting.since ||= now;
    if (now - waiting.since < ASK_FOR_MS) askAgain();
    return null;
  };
  /**
   * Pairs through the native host; resolves with the port, or null. Only while the extension needs it and the user
   * didn't press Disconnect; MoPilot hands over a pairing only once the user allowed it there.
   */
  function pairFromHost() {
    waiting.silent = false;
    if (held || !NEEDS_PAIRING.has(client.status)) return Promise.resolve(null);
    hostPairing ??= askHost(chrome, { auto: true, missing: sawHost })
      .then(answered)
      .finally(() => {
        hostPairing = null;
      });
    return hostPairing;
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    // only this extension's own pages (the options page) pair or unpair it
    if (sender?.id !== chrome.runtime.id || !String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
    void answer(message, sender).then(reply, (error) =>
      reply({
        status: client.status,
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {}),
      }),
    );
    return true;
  });

  /** @param {any} message */
  async function answer(message, sender) {
    // the side panel's requests go to MoPilot as they are; chromePanel.cjs checks them there
    if (message?.type === 'panel') {
      const params = { ...message.params };
      if (['start', 'send'].includes(message.method))
        params.deadline = Date.now() + (message.method === 'start' ? START_MS : REQUEST_MS) - 1000;
      /** @type {string | null} */
      let grant = null;
      try {
        if (['start', 'send'].includes(message.method) && params.tab) {
          if (!client.panelTabs) throw new Error('Update MoPilot to use this existing page from the side panel.');
          const source = new URL(String(sender.url));
          if (source.pathname !== '/sidepanel.html' || source.searchParams.get('tabId') !== String(params.tab.id))
            throw new Error('Send from the panel of the page you want to use.');
          if (message.method === 'send' && (typeof params.chatId !== 'string' || !params.chatId))
            throw new Error('Choose a chat before sending this page.');
          const targetChat = message.method === 'send' ? params.chatId : null;
          params.tab = await sessions.admissions.offer(params.tab.id, Date.now(), targetChat);
          grant = params.tab.grant;
        }
        return { ...(await status()), result: await panel.request(String(message.method), params) };
      } finally {
        if (grant) sessions.admissions.revoke(grant);
      }
    }
    if (message?.type === 'download') {
      await sessions.openTab({ url: DOWNLOAD_URL }, { focused: true });
      return status();
    }
    if (message?.type === 'update') {
      // Update extension: Chrome installs a newer version and the extension starts again with it
      const said = await updates.check();
      return { ...(await status()), ...(said ? { error: said } : { updating: true }) };
    }
    if (message?.type === 'tabChat') {
      // the chat whose tab group a tab is in, for that tab's panel to open (a tab the agent opened, or one dragged in)
      const chat = sessions.owner.get(Number(message.tabId));
      return chat ? { chat: { id: chat, title: sessions.chats.get(chat)?.title ?? 'MoPilot' } } : { chat: null };
    }
    if (message?.type === 'panelRepair') {
      await panelState.repair(message.tabId, true);
      return {};
    }
    if (message?.type === 'panelBind') {
      await panelState.bind(message.tabId, message.chat, message.explicit !== false);
      return {};
    }
    if (message?.type === 'panelDraft') {
      await panelState.keep(message.tabId, String(message.text));
      return {};
    }
    if (message?.type === 'takeDraft') return { text: await menu.take(message.tabId) };
    if (message?.type === 'tabNotice') {
      // a tab closed since the panel read it has no notice: said as none
      const tab = await chrome.tabs.get(Number(message.tabId)).then(
        (t) => t,
        (error) => (log('read the tab for its notice', error), null),
      );
      return { notice: tab ? await notices.of(tab.id, String(tab.url)) : null };
    }
    if (message?.type === 'retryTab') return { retried: await notices.retry(Number(message.tabId)) };
    if (message?.type === 'capture') {
      // the side panel's screenshot of the tab in front; a page Chrome keeps from extensions (chrome://, the Web Store) says so
      const tabId = Number(message.tabId);
      if (!Number.isSafeInteger(tabId)) return { error: 'Open a web page to add a screenshot of it.' };
      const data = await sessions.debuggers.capture(tabId).catch((error) => {
        log('take a screenshot for the side panel', error);
        return null;
      });
      return data ? { dataUrl: `data:image/png;base64,${data}` } : { error: "MoPilot can't take a screenshot of this page." };
    }
    if (message?.type === 'try') {
      // Try it: MoPilot opens a new chat with a sample task drafted (its text is MoPilot's, not this page's)
      const opened = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'open', protocol: PROTOCOL_VERSION, what: 'try' }).then(
        (answer) => answer?.type === 'opened',
        () => false,
      );
      return { ...(await status()), ...(opened ? { opened: true } : { error: "Couldn't reach MoPilot. Open it, then try again." }) };
    }
    if (message?.type === 'launch') {
      const ok = await launch();
      // not installed: the panel offers Download MoPilot instead (status' missing)
      return { ...(await status()), ...(ok || missing ? {} : { error: 'Open MoPilot from Applications.' }) };
    }
    if (message?.type === 'connect') {
      // the user pressed Connect, or MoPilot opened the page for its host: ask it now (MoPilot asks the user).
      // No answer from the host at all: MoPilot isn't running, so it starts, and is asked once it is up (launch)
      await hold(false);
      await pairFromHost();
      if (waiting.silent) await launch();
      return status();
    }
    if (message?.type === 'pair') {
      await hold(false);
      // Advanced: a one-time claim code MoPilot offered is traded for the pairing code; a pasted pairing code is
      // used as it is
      const offered = parseClaimCode(message.code);
      if (offered) {
        const port = await claim(offered);
        if (port !== null) return { status: client.status, port };
        return { status: client.status, error: 'That code expired. Press Connect.' };
      }
      const code = String(message.code ?? '').trim();
      const parsed = parsePairingCode(code);
      if (!parsed) return { status: client.status, error: "That isn't a MoPilot pairing code." };
      await chrome.storage.local.set({ pairing: code });
      await client.reset();
      return { status: client.status, port: parsed.port };
    }
    if (message?.type === 'unpair') {
      await hold(true);
      await chrome.storage.local.remove('pairing');
      await client.reset();
      return { status: client.status };
    }
    return status();
  }

  /** The connection as the page shows it; asking: MoPilot shows the user its question now (answer it there). */
  async function status() {
    const pairing = await readPairing(chrome);
    return {
      status: client.status,
      port: pairing?.port ?? null,
      asking: waiting.since > 0,
      ...(launching.since ? { starting: true } : {}),
      // which side to update while the two speak different protocol versions
      ...(client.status === 'update-required' ? { update: client.update } : {}),
      ...(missing && (client.status === 'offline' || client.status === 'unpaired') ? { missing: true } : {}),
    };
  }

  const ready = connectOrPair();
  return { sessions, client, downloads, panel, notices, menu, updates, ready };
}
