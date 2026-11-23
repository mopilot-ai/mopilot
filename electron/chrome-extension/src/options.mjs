// The extension's options page (design D5, #1632): the connection's state in one line and its one next step, as Claude in Chrome and ChatGPT show theirs; the pairing code only under Advanced.
//
// Pairing needs no code: Connect (or MoPilot opening this page with `#pair=host`) asks MoPilot's native host,
// and MoPilot asks the user "Allow Chrome to connect?" (electron/capabilities/browser/
// chromePairOffers.cjs). Where no host is installed (a developer build), MoPilot opens the page with
// `#pair=<one-time claim code>`: the code goes into Advanced's field, out of the address bar, and nothing pairs until
// the user presses Pair. Web pages cannot open this page (it is not web-accessible), so only MoPilot or the user
// can offer a code. One state shows at a time, read from the background's answer alone.
import { parseClaimCode, parsePairingCode } from './protocol.mjs';

/** What the page shows for each status: tone (the dot), the line, and whether Connect is the next step. */
export const VIEWS = Object.assign(Object.create(null), {
  connected: { tone: 'ok', text: 'Connected to MoPilot', connect: false },
  asking: { tone: 'wait', text: 'Allow it in MoPilot to finish connecting.', connect: false },
  connecting: { tone: 'wait', text: 'Connecting…', connect: false },
  offline: { tone: 'off', text: "MoPilot isn't open.", connect: false, launch: true },
  starting: { tone: 'wait', text: 'Starting MoPilot…', connect: false },
  unpaired: { tone: 'off', text: 'Not connected', connect: true },
  unauthorized: { tone: 'off', text: 'Not connected', connect: true },
  // the two speak different protocol versions: the older side updates
  updateExtension: { tone: 'error', text: 'Extension update required.', connect: false, update: true },
  updateApp: { tone: 'error', text: 'MoPilot update required.', connect: false, download: true },
  missing: { tone: 'off', text: "MoPilot isn't set up on this computer.", connect: false, download: true },
});
const BLANK = { tone: 'off', text: '', connect: false };

/**
 * How soon the page asks again while a status may change by itself: the background doesn't tell the page when the
 * connection changes, so without this "Connecting…" stayed after Pair even once connected, and a page opened before
 * the extension's first ask came back stayed "Not connected" while MoPilot was asking the user (seen in Chrome).
 */
export const FOLLOW_MS = {
  connecting: 1_000,
  asking: 1_000,
  starting: 1_000,
  unpaired: 2_000,
  unauthorized: 2_000,
  offline: 5_000,
  'update-required': 5_000,
};

/** The connection's own view: an update one side needs, MoPilot not installed, or the status as it is. */
function baseOf(/** @type {any} */ r) {
  if (r?.status === 'update-required') return r.update === 'app' ? VIEWS.updateApp : VIEWS.updateExtension;
  if (r?.missing) return VIEWS.missing;
  return VIEWS[String(r?.status)] ?? BLANK;
}

/**
 * The one state the background's answer shows: an error, MoPilot asking the user, or the connection's status.
 * @param {{ status?: string, error?: string, asking?: boolean, starting?: boolean, update?: string, missing?: boolean } | undefined} r
 */
export function viewOf(r) {
  const base = baseOf(r);
  if (r?.error) return { tone: 'error', text: r.error, connect: base.connect };
  if (r?.asking && r.status !== 'connected') return VIEWS.asking;
  if (r?.starting && r.status !== 'connected') return VIEWS.starting;
  return base;
}

/**
 * Starts the page in its window (`g`: chrome, document, location, history, setTimeout, clearTimeout), whose timers it
 * calls on the window itself. `onConnected`: the connection came up (the settings tabs read MoPilot's again).
 * @param {any} g @param {{ onConnected?: () => void }} [o]
 */
export function startOptions(g, o = {}) {
  const { chrome, document, location, history } = g;
  // the window's own timers, called on the window: Chrome refuses window.setTimeout called on another object ("Illegal
  // invocation"), which once left the page's follow-ups never running there while every test passed
  const timers = g;
  const $ = (id) => document.getElementById(id);
  /** Sets an element the page may not have: a page without Advanced or the pin tip. */
  const on = (id, f) => {
    const el = $(id);
    if (el) f(el);
  };
  /** @type {any} */
  let follow = null;
  let connected = false;
  const show = (r) => {
    if (r?.status === 'connected' && !connected) o.onConnected?.();
    connected = r?.status === 'connected';
    steps(r);
    const v = viewOf(r);
    $('dot').className = `dot ${v.tone}`;
    $('line').textContent = v.text;
    $('connect').hidden = !v.connect;
    on('launch', (el) => {
      el.hidden = !v.launch;
    });
    on('update', (el) => {
      el.hidden = !v.update;
    });
    on('download', (el) => {
      el.hidden = !v.download;
    });
    $('disconnect').hidden = r?.status !== 'connected';
    // the port is a detail for whoever pairs by hand: under Advanced only
    on('port', (el) => {
      el.textContent = r?.port ? `Port ${r.port}` : '';
    });
    // a status still settling is asked again; an error stays until the user acts
    timers.clearTimeout(follow);
    follow = null;
    const settling = r?.status === 'connected' ? r.status : r?.asking ? 'asking' : r?.starting ? 'starting' : r?.status;
    // the checklist also waits for the user to pin it, which Chrome tells no page about
    const ms = r?.error ? 0 : Object.hasOwn(FOLLOW_MS, settling) ? FOLLOW_MS[settling] : welcome && !pinned ? FOLLOW_MS.unpaired : 0;
    if (ms) follow = timers.setTimeout(() => void refresh(), ms);
  };
  const send = (message) => chrome.runtime.sendMessage(message).then(show);
  // opened on install (background.mjs): the page is a checklist too, as ChatGPT's install page is
  const welcome = String(location.hash || '') === '#welcome';
  let tried = false;
  let pinned = false;
  /** @type {any} the background's last answer, for a step that changes between answers (pinning) */
  let last = null;
  const steps = (/** @type {any} */ r) => {
    last = r;
    if (!welcome) return;
    // pinning happens in Chrome's menu, not here: read again with every answer while the checklist shows
    if (!pinned) readPin();
    tried ||= r?.opened === true;
    on('welcome', (el) => {
      el.hidden = false;
    });
    on('step-connect', (el) => {
      el.className = r?.status === 'connected' ? 'done' : '';
    });
    on('step-pin', (el) => {
      el.className = pinned ? 'done' : '';
    });
    on('step-try', (el) => {
      el.className = tried ? 'done' : '';
    });
  };
  const offered = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('pair');
  if (offered || welcome) history.replaceState(null, '', location.pathname);
  if (offered && offered !== 'host') {
    // a code MoPilot offered where it has no native host: Advanced, opened, with the code in its field
    const ok = !!(parseClaimCode(offered) ?? parsePairingCode(offered));
    on('code', (el) => {
      el.value = ok ? offered : '';
    });
    on('advanced', (el) => {
      el.open = true;
    });
    on('hint', (el) => {
      el.textContent = ok ? 'MoPilot on this computer offered this code. Press Pair to connect.' : "That isn't a MoPilot pairing code.";
    });
  }
  $('connect').addEventListener('click', () => send({ type: 'connect' }));
  on('launch', (el) => el.addEventListener('click', () => send({ type: 'launch' })));
  on('update', (el) => el.addEventListener('click', () => send({ type: 'update' })));
  on('download', (el) => el.addEventListener('click', () => send({ type: 'download' })));
  $('disconnect').addEventListener('click', () => send({ type: 'unpair' }));
  on('pair', (el) => el.addEventListener('click', () => send({ type: 'pair', code: $('code').value })));
  on('try', (el) => el.addEventListener('click', () => send({ type: 'try' })));
  // the pin tip, as both vendors give it: only where the page can tell the extension isn't on the toolbar
  function readPin() {
    on('pin', (el) =>
      Promise.resolve(chrome.action?.getUserSettings?.())
        .then((s) => {
          el.hidden = s?.isOnToolbar !== false;
          if (s?.isOnToolbar === true && !pinned) {
            pinned = true;
            steps(last);
          }
        })
        // the tip is a convenience: without Chrome's answer it stays hidden
        .catch((error) => console.warn("MoPilot: couldn't read whether it is on the toolbar:", error)),
    );
  }
  readPin();
  const refresh = () => send({ type: 'status' });
  // opened by MoPilot for its native host: ask it now, so MoPilot asks the user
  return { refresh, ready: offered === 'host' ? send({ type: 'connect' }) : refresh() };
}
