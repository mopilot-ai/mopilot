// Handing a built-in browser page over to the user's Chrome for every controller of it: opening the original site there, switching the browser channel (Your Chrome) and cancelling a handoff still connecting.
//
// The chat's route (shared/chromeHandoff.mjs) decides who continues there. Your Chrome opens the site in the chat's
// own Chrome instance and switches the browser channel; a harness that drives Chrome itself (Claude in Chrome, the
// Codex Browser plugin) and MoPilot's chrome_* tools get the site opened in the user's Chrome, and the channel
// stays. Switching the channel changes the saved Preferred browser for every chat, so the result says when it did
// (preferredChanged) and the pane tells the user. Either way a browser_request_signin call still waiting on the page
// ends with a note telling the agent where to continue. A chat with no Chrome controller is told why, never sent to a tab nobody can reach, and one whose
// Chrome tools lack their extension in Chrome is sent to set it up before anything opens.

const { isWebUrl, restartUrl } = require('../../../shared/browser.mjs');
const { handoffRoute, movedNote, needsSetup, opensInUserChrome, setupReason } = require('../../../shared/chromeHandoff.mjs');
const { vendorChromeIdOf } = require('../../../shared/controllerPlan.mjs');
const { noteHandoff } = require('./handoffPages.cjs');

/**
 * The route a chat's sign-in hand-off to the user's Chrome takes (shared/chromeHandoff.mjs): the harness's own Chrome
 * controller on the chat's current segment (`plan`), else Your Chrome while agents already work there, else MoPilot's chrome_* tools while their channel (`relay`, set up at startup) still serves them (`toolsOn`: a switch, or the
 * default where the build ships the extension), else Your Chrome when it is on. A native Codex thread MoPilot serves the user's Chrome to (`codexExtension`) continues there through
 * the Codex Browser plugin on MoPilot's Chrome backend. Your Chrome without its Playwright Extension in Chrome
 * (`extension`, read only when it matters) is 'setup'; MoPilot's own extension known to be missing or off in
 * the user's Chrome (ownExtensionReady of the `relay` channel, read only when it matters) is 'setup-extension'. A vendor route needs no
 * check here: the plan names it only where its extension was found (session/controllerPlan.cjs).
 * @param {{ plan: import('../../../shared/controllerPlan.mjs').Controllers | null,
 *           relay: { kind: 'extension' | 'relay', toolsOn?: () => boolean, relay?: object, inProfile?: (() => { state: string | null }) | null } | null,
 *           isEnabled: (key: string) => boolean, channel: string, channelEnabled?: boolean, tools?: string[],
 *           codexExtension?: boolean, extension?: () => boolean }} o
 */
function chatHandoffRoute({
  plan,
  relay,
  isEnabled,
  channel,
  channelEnabled = false,
  tools = [],
  codexExtension = false,
  extension = () => true,
}) {
  const has = (name) => channelEnabled && tools.includes(name);
  const route = handoffRoute({
    codexExtension: codexExtension && !!relay,
    vendor: vendorChromeIdOf(plan),
    relay: has('chrome_tabs_context_mcp') && has('chrome_navigate') && relay?.toolsOn?.() === true ? relay.kind : null,
    yourChrome: has('sage_browser_snapshot') && isEnabled('shared.browser.extension'),
    onChrome: channel === 'chrome',
  });
  if (route === 'your-chrome' && !extension()) return 'setup';
  if ((route === 'extension' || route === 'codex-extension') && ownExtensionReady(relay) === false) return 'setup-extension';
  return route;
}

/**
 * Whether MoPilot's own extension can take a page over (chatHandoffRoute): connected, else on in
 * the profile it pairs in (a paired one connects once Chrome starts); missing or turned off there can't work; a profile
 * that can't be read, or a channel that isn't the extension's, says nothing (null).
 * @param {{ kind: string, relay?: object, inProfile?: (() => { state: string | null }) | null } | null | undefined} setup
 *   relay: the extension's channel (chromeExtension.cjs), whose status() says whether it is connected
 */
function ownExtensionReady(setup) {
  if (setup?.kind !== 'extension') return null;
  if (/** @type {any} */ (setup.relay)?.status?.().connected) return true;
  const state = setup.inProfile?.().state ?? null;
  if (state === 'on') return true;
  return state === 'missing' || state === 'off' ? false : null;
}

/** How long the chat's Chrome instance waits for the agent's next call after a handoff (the user signs in meanwhile). */
const SIGNIN_IDLE_MS = 60 * 60_000;

/** Handoffs still connecting, by chat: the page that asked, and whether the handoff started the chat's Chrome instance. */
const pending = new Map();

/**
 * Continue the user's task in Chrome without replaying OAuth challenges or replacing newer settings.
 * `route`: the chat's route (app/browserTools.cjs chromeHandoffRoute); `openSite`: opens a site in the user's Chrome
 * for a route that does so (browser/openSite.cjs); `signinMoved`: ends the browser_request_signin call waiting on the
 * handed-off page (any of the chat's when no page is named) with the agent's note (BrowserTabs.signinMoved).
 * A request from the chat's ways-forward strip may name no page (the chat has no in-app tab): only a page it names is checked.
 */
function chromeHandoff({
  browserWindows,
  chromeChannel,
  browserControl,
  isEnabled,
  getPrefs,
  commitPrefs,
  changed,
  owner = /** @type {(chatId: string) => string | null} */ ((_chatId) => null),
  route: routeOf = /** @type {(chatId: string) => import('../../../shared/chromeHandoff.mjs').HandoffRoute} */ ((_chatId) => 'your-chrome'),
  openSite = /** @type {(url: string, route: import('../../../shared/chromeHandoff.mjs').HandoffRoute) => Promise<void>} */ (
    async () => {
      throw new Error('Opening a site in your Chrome is not available here.');
    }
  ),
  signinMoved = /** @type {(chatId: string, note: string, webContentsId: number | undefined) => void} */ (
    (_chatId, _note, _webContentsId) => undefined
  ),
}) {
  return async (/** @type {{ webContentsId?: number, chatId?: string, url?: string }} */ { webContentsId, chatId, url } = {}, host) => {
    /** @type {{ webContentsId: number | undefined, cancelled: boolean, fresh: boolean, settling?: boolean } | null} */
    let job = null;
    let out;
    /** @param {{ cancelled: boolean }} current */
    const live = (current) => {
      if (current.cancelled) throw new Error('Cancelled.');
    };
    try {
      const initialPrefs = getPrefs();
      if (webContentsId != null) browserWindows.owned(webContentsId, host);
      if (typeof chatId !== 'string' || !chatId) throw new Error('Open this page beside a chat before continuing with an agent in Chrome.');
      const route = routeOf(chatId);
      const segment = owner(chatId);
      const currentRoute = () => {
        if (owner(chatId) !== segment || routeOf(chatId) !== route)
          throw new Error('The chat’s Chrome controller changed. Try again with its current tools.');
        if (webContentsId != null) browserWindows.owned(webContentsId, host);
      };
      if (needsSetup(route)) throw new Error(setupReason(route));
      if (!isWebUrl(url)) throw new Error('Enter an http or https URL for the site you want to use.');
      const target = restartUrl([url]);
      if (!target) throw new Error('Enter the original site you were signing in to, rather than the identity provider.');
      if (opensInUserChrome(route)) {
        const opening = { webContentsId, cancelled: false, fresh: false };
        job = opening;
        pending.set(chatId, opening);
        // the agent never sees a tab MoPilot's own instance opens: the user's Chrome gets the site, the agent
        // picks it up with its own tool, and the channel stays as it is
        try {
          await openSite(target, route);
        } catch (error) {
          throw new Error(`Could not open the site in your Chrome: ${error?.message || 'it did not start'}.`);
        }
        live(opening);
        currentRoute();
        // the user signs in there: a group of the chat's holding that site keeps nothing alive (handoffPages, #1403)
        noteHandoff(chatId, target);
        signinMoved(chatId, movedNote(route, target), webContentsId);
        if (pending.get(chatId) === opening) pending.delete(chatId);
        return { ok: true, url: target, route };
      }
      if (!isEnabled()) throw new Error('Your Chrome is unavailable. Check Browser settings.');
      const current = { webContentsId, cancelled: false, fresh: !chromeChannel.has(chatId) };
      job = current;
      pending.set(chatId, current);
      // the user signs in there next: the instance waits for the agent's next call longer than an idle one does
      const inst = await chromeChannel.instance(chatId, { idleMs: SIGNIN_IDLE_MS });
      live(current);
      currentRoute();
      const result = await inst.call('browser_navigate', { url: target });
      live(current);
      currentRoute();
      // Chrome answered: from here the handoff finishes, or fails, on its own
      current.settling = true;
      if (result.isError)
        throw new Error(
          'Could not open the site in Chrome. Install the Playwright Extension and check the connection in Browser settings.',
        );
      if (webContentsId != null) browserWindows.owned(webContentsId, host);
      if (getPrefs() !== initialPrefs || !isEnabled())
        throw new Error('Browser settings changed while connecting. Try again with the current settings.');
      inst.needsSnapshot = true;
      const previous = initialPrefs.channel;
      const configureSeq = browserControl.seq + 1;
      const active = await browserControl.configure('chrome');
      try {
        currentRoute();
      } catch (error) {
        if (getPrefs() === initialPrefs && browserControl.seq === configureSeq) {
          await browserControl.configure(previous);
          changed();
        }
        throw error;
      }
      if (getPrefs() !== initialPrefs || browserControl.seq !== configureSeq)
        throw new Error('Browser settings changed while connecting. Try again with the current settings.');
      if (active !== 'chrome') {
        await browserControl.configure(previous);
        changed();
        throw new Error('Could not switch browser control to Chrome. Check Browser settings and try again.');
      }
      try {
        commitPrefs({ ...initialPrefs, channel: 'chrome' });
      } catch (error) {
        await browserControl.configure(previous);
        changed();
        throw error;
      }
      changed();
      signinMoved(chatId, movedNote('your-chrome', target), webContentsId);
      // the saved Preferred browser changed with it: the pane says so (#1523 §3), never silently
      out = { ok: true, url: target, route: 'your-chrome', preferredChanged: previous !== 'chrome' };
    } catch (error) {
      out = job?.cancelled
        ? { ok: false, cancelled: true, message: 'Cancelled.' }
        : { ok: false, message: error?.message || 'Could not continue in Chrome.' };
    }
    if (job && pending.get(chatId) === job) pending.delete(chatId);
    return out;
  };
}

/**
 * Stops a page's handoff that is still waiting for Chrome, so it never switches settings. An instance the handoff
 * started (still waiting for the user's approval in Chrome) is stopped; one an agent was already using is left running.
 * @returns {boolean} whether a handoff was cancelled
 */
function cancelChromeHandoff(
  { browserWindows, chromeChannel },
  /** @type {{ webContentsId?: number, chatId?: string }} */ { webContentsId, chatId } = {},
  host,
) {
  browserWindows.owned(webContentsId, host);
  const job = pending.get(chatId);
  if (!job || job.webContentsId !== webContentsId || job.cancelled || job.settling) return false;
  job.cancelled = true;
  if (job.fresh) void chromeChannel.stop(chatId);
  return true;
}

module.exports = { chromeHandoff, cancelChromeHandoff, chatHandoffRoute, ownExtensionReady };
