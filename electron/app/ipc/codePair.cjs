// IPC for this Mac's side of pairing by a code (R2b of #5576, behind host.codePair; shape agreed with the Host lane on #5576): status, the one-time approval setup, this Mac's code, the person's Allow or Don't allow, cancel, and every step of a run to the windows (codePair:event). A thin layer: main's service `live.codePairHost` answers (rr-h1); this file binds each call to the preload document that made it, accepts only an offer id of the relay's form for an offer that document made, and passes nothing else from the renderer. Until the service exists every call says why in the Host's own code, so a window never waits on nothing.
const { isEnabled } = require('../../platform/flags.cjs');
const { registerRemoteWindows } = require('../../remote/settingsWindows.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** What a Mac with no code-pair service says: it cannot ask for an approval yet (the reason the Host gives, worded in shared/host/refusalWordsCodePair.mjs). */
const UNAVAILABLE = Object.freeze({ approval: { available: false, reason: 'no_approval_helper' }, connections: false, offers: [] });
/** The relay's offer id (shared/host/methods/codePair.mjs OFFER). */
const OFFER_ID = /^r_[A-Za-z0-9_-]{22}$/;
const refused = (/** @type {string} */ code) => ({ error: { code } });

/** @param {import('electron').IpcMain} ipcMain @param {{ live: Record<string, any>, flagOn?: () => boolean, windows?: { owner: (event: unknown, token: unknown) => string, onRetire?: (fn: (owner: string) => void) => unknown } }} deps */
function register(ipcMain, { live, flagOn = () => isEnabled('host.codePair'), windows }) {
  /** Which document made each open offer: only it may allow, deny or cancel it, and its going away cancels it. @type {Map<string, string>} */
  const offers = new Map();
  /** The page each owner is, so a run's steps (the other device's name, the safety number) go to the page that made the offer and no other. @type {Map<string, { send: (channel: string, payload: unknown) => void, isDestroyed: () => boolean }>} */
  const pages = new Map();
  /** Owners whose page went away: an offer that comes back for one after it left is cancelled at once. */
  const gone = new Set();
  const docs = windows ?? registerRemoteWindows(ipcMain);
  // a page that goes away (navigation, renderer loss, its window closed) takes its open offers with it
  docs.onRetire?.((owner) => retire(owner));
  const service = () => (flagOn() ? (live.codePairHost ?? null) : null);
  /** The service's events reach the windows, wired the first time a service is seen (it may come after this registers) and only while the flag is on. */
  /** @type {any} */
  let wired = null;
  const wire = () => {
    const s = service();
    if (!s || wired === s) return s;
    wired = s;
    s.onEvent?.((/** @type {any} */ e) => {
      if (!flagOn()) return;
      const page = pages.get(offers.get(e?.offerId) ?? '');
      if (page && !page.isDestroyed()) page.send('codePair:event', e);
      if (e && ['done', 'denied', 'used_up', 'expired', 'cancelled', 'failed'].includes(e.phase)) offers.delete(e.offerId);
    });
    return s;
  };
  /** @param {string} owner */
  function retire(owner) {
    gone.add(owner);
    pages.delete(owner);
    for (const [offerId, by] of offers) {
      if (by !== owner) continue;
      offers.delete(offerId);
      void Promise.resolve(wired?.cancel({ offerId })).catch((/** @type {unknown} */ e) =>
        noteIgnored('cancel the offer of a page that went away', e),
      );
    }
  }
  /** The calling page's own token, said in this feature's words when it belongs to a page that went away; the page is kept for its events. @param {any} event @param {unknown} token */
  const ownerOf = (event, token) => {
    let owner;
    try {
      owner = docs.owner(event, token);
    } catch {
      throw new Error('This page changed. Open Settings › Connections again to make a code.');
    }
    if (event?.sender) pages.set(owner, event.sender);
    return owner;
  };
  /** Each handler: the calling document's own token first; off, or no service, is said before anything runs. @param {(s: any, owner: string, p: any) => any} fn */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, token, p) => {
      const owner = ownerOf(event, token);
      if (!flagOn()) return refused('off');
      const s = wire();
      return s ? fn(s, owner, p) : refused('no_approval_helper');
    });
  /** An offer this document made, or null. @param {string} owner @param {unknown} p */
  const offerOf = (owner, p) => {
    const offerId = /** @type {any} */ (p)?.offerId;
    return typeof offerId === 'string' && OFFER_ID.test(offerId) && offers.get(offerId) === owner ? offerId : null;
  };
  ipcMain.handle('codePair:status', async (event, token) => {
    ownerOf(event, token);
    const s = wire();
    return s ? s.status() : UNAVAILABLE;
  });
  handle('codePair:setup', (s) => s.setup());
  // the repair for an approval key the Host and this Mac no longer share; the page asks the person first
  handle('codePair:resetApproval', (s) => (typeof s.resetApproval === 'function' ? s.resetApproval() : refused('unsupported')));
  handle('codePair:offer', async (s, owner) => {
    const r = await s.offer();
    if (!r || typeof r.offerId !== 'string') return r;
    // the page that asked went away while the offer was made: nobody can show it, so it is closed at once
    if (gone.has(owner)) {
      void Promise.resolve(s.cancel({ offerId: r.offerId })).catch((/** @type {unknown} */ e) =>
        noteIgnored('cancel an offer its page left', e),
      );
      return refused('cancelled');
    }
    offers.set(r.offerId, owner);
    return r;
  });
  for (const [channel, name] of [
    ['codePair:allow', 'allow'],
    ['codePair:deny', 'deny'],
    ['codePair:cancel', 'cancel'],
  ])
    handle(channel, (s, owner, p) => {
      const offerId = offerOf(owner, p);
      return offerId ? s[name]({ offerId }) : refused('no_such_offer');
    });
}

module.exports = { register, UNAVAILABLE, OFFER_ID };
