// The user's turn on a browser tab (browser_request_signin, #1834): the agent hands the tab over and its call returns at once, so its turn
// ends, as Claude in Chrome's and the Codex browser's hand-offs do. The hold outlives the turn: agent input to the tab stays paused until the
// user clicks "Done, continue" (which sends "Done on <site>" into the chat through its current harness), replies, presses Stop, closes the
// tab, switches harness or archives the chat. Nothing waits on the hold, so no turn is ever left running on it.
const { ToolError } = require('../contract/registry.cjs');
const { originOf } = require('./origins.cjs');
const { oneLine } = require('./hostUtil.cjs');
const { PROBE_MS, CREDENTIAL_FIELD, credentialFieldIn } = require('./credentialProbe.cjs');
const { doneOn } = require('../../../shared/doneContinue.mjs');
const { isIdentityProvider } = require('../../../shared/browser.mjs');
const { addHook, addGuard } = require('../../session/hookChain.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { noteHandoff, settleStale } = require('./handoffNotes.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */
/** @typedef {import('./host.cjs').Tab} Tab */
/** @typedef {'done' | 'cancelled' | 'replied' | 'stopped' | 'switched' | 'moved' | 'closed'} HandoffEnd */

/** Main's wiring (installUserTurns): "Done, continue" on a browser host sends through the chats of the app whose host it is, none for another. */
const wirings = new Set();
/** The chat store of the app whose browser host `host` is, where hand-off lines go (handoffNotes.cjs); none for another host. */
const chatsOf = (/** @type {any} */ host) => [...wirings].find((w) => w.browserTabs === host)?.chats;
/** Each chat's sign-in the agent asked for in chat on the user's Chrome (no tab to hold there), until the user answers. */
const chromeAsks = new Map();
/** Each line's own number: two hand-offs in one millisecond are two lines (handoffNotes.cjs rewrites a line by its id). */
let noteSeq = 0;

/** The site a hand-off names: the page's host, or its address when it has none. */
const siteOf = (/** @type {Tab} */ tab) => {
  const origin = originOf(tab.url);
  return origin ? new URL(origin).host : oneLine(tab.url, 120);
};

/**
 * Whether the tab's page really asks for a credential, so the pane says "Sign in to <site>" rather than "Your turn on <site>": an identity
 * provider's page, or one with a password or one-time-code field. A page that can't be read counts as not asking.
 * @param {Tab} tab
 */
async function asksForCredential(tab) {
  if (isIdentityProvider(tab.url)) return true;
  // the page and each frame with its own session (another site's sign-in widget): any field is a sign-in
  return credentialFieldIn(tab, { ms: PROBE_MS, unreadable: false });
}

/**
 * Hands `tab` to the user. Returns at once; the hold ends by endHandoff.
 * @param {BrowserTabs} host
 * @param {Tab} tab
 * @param {{ reason?: string, credential?: boolean }} [o]
 */
function handOver(host, tab, { reason = '', credential = false } = {}) {
  if (tab.signin) throw new ToolError(`${tab.id} is already the user's turn.`, 'busy');
  tab.signinMoved = '';
  const since = Date.now();
  tab.signin = {
    reason: oneLine(reason, 200),
    since,
    credential: !!credential,
    site: siteOf(tab),
    noteId: `handoff-${tab.id}-${since}-${++noteSeq}`,
  };
  // the chat's line for every surface, phones included: "Finish signing in to <site> on your Mac"
  noteHandoff(chatsOf(host), tab.chatId, tab.signin.noteId, tab.signin);
  tab.mark = tab.mark || 'handoff';
  // its favicon carries the hand-off until the user sees the tab
  host.o.cursor?.clear(tab, 'handoff');
  try {
    host.o.select(tab);
  } catch (error) {
    // the tab may have closed meanwhile: its close ends the hold
    noteIgnored('show the tab handed to the user', error);
  }
  host.emit(tab.chatId);
}

/**
 * Ends `tab`'s hold, if it has one. Done tells the agent through its next browser result too; a move to the user's Chrome leaves the
 * agent's note there. Returns the hold that ended, or null.
 * @param {BrowserTabs} host
 * @param {Tab} tab
 * @param {HandoffEnd} how
 */
function endHandoff(host, tab, how) {
  const hold = tab.signin;
  if (!hold) return null;
  tab.signin = null;
  noteHandoff(chatsOf(host), tab.chatId, hold.noteId, hold, how);
  if (how === 'done') host.change(tab.chatId, `user_done ${tab.id}: the user finished on ${hold.site}; read the page again`);
  if (how === 'moved' && tab.signinMoved) host.change(tab.chatId, tab.signinMoved);
  host.emit(tab.chatId);
  return hold;
}

/**
 * Ends every hold of a chat (the user replied, pressed Stop or switched harness); returns how many ended.
 * @param {BrowserTabs} host
 * @param {string} chatId
 * @param {HandoffEnd} how
 */
function endHandoffs(host, chatId, how) {
  let n = 0;
  for (const t of host.list(chatId)) if (endHandoff(host, t, how)) n++;
  return n;
}

/**
 * "Done, continue" (done) or giving up (not done) on a chat's held tab: `tabId` names it, or null for whichever holds. Done sends
 * "Done on <site>" into the chat (through the app's wiring and the chat's current harness; queued behind a turn that still runs). False when none holds.
 * @param {BrowserTabs} host
 * @param {string} chatId
 * @param {string | null} tabId
 * @param {boolean} done
 */
async function handoffDone(host, chatId, tabId, done) {
  const t = host.list(chatId).find((x) => x.signin && (!tabId || x.id === tabId));
  if (!t) return false;
  const hold = endHandoff(host, t, done ? 'done' : 'cancelled');
  const live = [...wirings].find((w) => w.browserTabs === host);
  if (done && hold && live) await resumeChat(live)(chatId, doneOn(hold.site));
  return true;
}

/**
 * The user took a chat's hand-off to their Chrome (browser/handoff.cjs): the held tab on the handed-off page (its own page or its popup's
 * opener, `wcId`; every tab of the chat when no page is named) ends its hold, and the agent's next result carries `note`, which says where
 * it continues. False when none holds.
 * @param {BrowserTabs} host
 */
function handoffMoved(host, chatId, note, /** @type {number | null | undefined} */ wcId = null) {
  const onPage = (/** @type {Tab} */ t) => wcId == null || t.backend.id === wcId || t.root?.backend.id === wcId;
  const held = host.list(chatId).filter((x) => x.signin && onPage(x));
  for (const t of held) {
    t.signinMoved = note;
    endHandoff(host, t, 'moved');
  }
  return held.length > 0;
}

/** The refusal of an agent call on a held tab. */
const heldError = (/** @type {Tab} */ tab) =>
  new ToolError(`It is the user's turn on ${tab.id}, so agent input to it is paused. Use another tab, or end your turn.`, 'signin_pending');

/**
 * Wires the hand-offs to main's chat controller, which every harness's turns go through with or without a window: user input on its way to
 * the harness (a new turn or a steer, Done's own message included) means the user replied; Stop, or a harness switch picked for the chat
 * (its session's pendingSwitch), ends the hand-off too. Input only queued behind a running turn leaves the tab the user's until it is sent.
 * "Done, continue" sends through it from then on. The browser host is read when needed (it starts after the sessions).
 * @param {{ controller: any, peerRuntime?: any, browserTabs?: BrowserTabs | null, chats?: any }} live
 */
function installUserTurns(live) {
  const end = (/** @type {string} */ chatId, /** @type {HandoffEnd} */ how) => {
    const ask = chromeAsks.get(chatId);
    if (ask) {
      chromeAsks.delete(chatId);
      noteHandoff(live.chats, chatId, ask.noteId, ask, how);
    }
    try {
      live.browserTabs?.endHandoffs(chatId, how);
    } catch (error) {
      // the browser host may be closing: a tab that went ends its own hand-off
      noteIgnored("end a chat's browser hand-off", error);
    }
  };
  const { controller } = live;
  addGuard(controller, 'beforeDispatch', (/** @type {{ chatId: string, item: any }} */ { chatId, item }) => {
    if (item?.opts?.human) end(chatId, 'replied');
  });
  addHook(controller, 'onStopped', (/** @type {string} */ chatId) => end(chatId, 'stopped'));
  addHook(controller.state, 'publish', (/** @type {{ chatId: string, patch?: Record<string, unknown> }} */ p) => {
    if (p?.patch?.pendingSwitch) end(p.chatId, 'switched');
  });
  wirings.add(live);
  // a hand-off line left open by the app's last run waits on nothing now
  settleStale(live.chats);
}

/**
 * On the user's Chrome the agent can't hand a tab over (browser_request_credentials refuses there): it asks the user in chat, and the
 * chat's line says to finish signing in on the Mac until the user replies, presses Stop or the chat switches harness.
 * @param {string} chatId
 * @param {string | null | undefined} site where the sign-in is (the Chrome route's name when no page is known); none: not the Chrome route
 * @param {string} [reason]
 * @returns {string | null | undefined} `site`, for the caller's route check
 */
function askedInChrome(chatId, site, reason = '') {
  const live = [...wirings].at(-1);
  if (!site || !live?.chats || chromeAsks.has(chatId)) return site;
  const since = Date.now();
  const ask = { site, reason: oneLine(reason, 200), credential: true, since, noteId: `handoff-chrome-${chatId}-${since}-${++noteSeq}` };
  if (noteHandoff(live.chats, chatId, ask.noteId, ask)) chromeAsks.set(chatId, ask);
  return site;
}

/**
 * What "Done, continue" sends: the user's own message, through the chat's current harness like any send (queued while a turn runs).
 * @param {{ controller: any, peerRuntime?: any }} live
 */
const resumeChat = (live) => (/** @type {string} */ chatId, /** @type {string} */ text) => {
  // a chat another app is running keeps what is typed until it lets go (the window's hold): never send past it from here
  if (live.controller.state?.get(chatId)?.runningElsewhere)
    throw new Error('This chat is running in another app. Send your message when it is done there.');
  const item = { text, attachments: [], opts: { human: true } };
  return live.controller.send(chatId, live.peerRuntime ? live.peerRuntime.userTurn(chatId, item) : item, null, true);
};

const { HANDOFF_CONTINUES } = require('../../../shared/doneContinue.mjs');

module.exports = {
  PROBE_MS,
  HANDOFF_CONTINUES,
  installUserTurns,
  askedInChrome,
  resumeChat,
  asksForCredential,
  handOver,
  endHandoff,
  endHandoffs,
  handoffDone,
  handoffMoved,
  heldError,
  siteOf,
  CREDENTIAL_FIELD,
};
