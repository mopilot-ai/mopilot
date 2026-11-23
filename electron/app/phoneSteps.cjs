// What a paired phone reads of a chat's work besides its rows (electron/remote/methods/steps.cjs): one screenshot or zoom step's own picture, shrunk when tapped; where the chat works now (an in-app tab, the user's Chrome, a desktop app); and the hand-offs only the Mac can finish (a sign-in or a check in the in-app browser, a login sheet) as cards that say so. Every harness's calls go through the same registry and browser, so none is special here.
const { originOf } = require('../capabilities/browser/originPolicy.cjs');
const fs = require('node:fs');
const { phoneHostImage } = require('./phoneHostImages.cjs');
const { AppIdentity } = require('../capabilities/appIdentity.cjs');

/** The surface a call needs (capabilities/contract/hostScope.cjs) as a phone names it. */
const KIND = /** @type {const} */ ({ iab: 'iab', bu: 'chrome', cu: 'desktop', desktop: 'desktop' });
/** A hand-off the agent asked for to get past a bot check, not a sign-in (browser/botCheck.cjs words its reason "Complete the CAPTCHA"). */
const CHECK = /captcha|bot check|not a robot|verify (?:you are|you're) human|security check/i;
/** The quality a shrunk picture is sent at. */
const JPEG_QUALITY = 70;
/** The largest picture file read for a phone (a screenshot or photo the user attached). */
const MOST_FILE_BYTES = 25 * 1024 * 1024;

/**
 * A picture, its longest side at most `maxSide`, as the JPEG a phone draws; null when it has no size.
 * @param {any} picture a nativeImage @param {number} maxSide
 */
function shrunk(picture, maxSide) {
  const { width, height } = picture.getSize();
  if (!width || !height) return null;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  let shown =
    scale < 1
      ? picture.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
      : picture;
  // Base64 and the sealed envelope must fit the phone's 256 KB frame.
  for (;;) {
    const size = shown.getSize();
    const jpeg = shown.toJPEG(JPEG_QUALITY);
    if (jpeg.length <= 180_000) return { data: jpeg.toString('base64'), width: size.width, height: size.height };
    if (Math.max(size.width, size.height) <= 64) return null;
    shown = shown.resize({
      width: Math.max(1, Math.floor(size.width / 2)),
      height: Math.max(1, Math.floor(size.height / 2)),
      quality: 'good',
    });
  }
}

/** A card a phone shows but can't answer: the Mac is where it is finished. @param {string} id @param {string} what */
function waitingCard(id, what) {
  const copy = `Waiting for you on your Mac: ${what}`;
  return { id, title: copy, inApp: true, where: 'mac-only', waitingCopy: copy };
}

/** The host a login sheet names, or its origin as it is. @param {string} origin */
function hostOf(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: peerRuntime (history), capabilities (the registry), browserTabs, credentialHandoff
 * @param {() => any} [o.images] Electron's nativeImage
 * @param {{ resolve: (app: string) => Promise<{ name: string, bundleId: string | null } | null> }} [o.identity] an app's name and bundle id
 */
function createPhoneSteps({ live, images = () => require('electron').nativeImage, identity = new AppIdentity() }) {
  /** @type {Set<(chatId: string) => void>} who hears a chat's in-app tabs change */
  const tabListeners = new Set();
  // a hand-off ends when the user is done on the Mac, with no call running then: the browser tells it here (app/browserTools.cjs onChange)
  live.phoneTabsChanged = (/** @type {string} */ chatId) => {
    for (const fn of [...tabListeners]) fn(chatId);
  };
  return {
    /**
     * The picture a screenshot or zoom call returned (the model's own capture), its longest side at most `maxSide`, as a JPEG; null when
     * the call is not one or its picture is not kept.
     * @param {string} chatId @param {string} callId @param {number} maxSide
     */
    async stepImage(chatId, callId, maxSide) {
      const read = live.peerRuntime?.readHistory?.callImage;
      const url = read ? await read(chatId, callId) : null;
      if (!url) return null;
      return shrunk(images().createFromDataURL(url), maxSide);
    },
    /**
     * A picture the user attached to a message, its longest side at most `maxSide`, as a JPEG; null when the message has no such picture
     * kept (history leaves it out, or a file that is gone or not a picture). The message's saved record is read first; a message the turn
     * is still running (not saved yet) is read from the pictures the live feed shows for it.
     * @param {string} chatId @param {string} itemId @param {number} index @param {number} maxSide
     */
    async userImage(chatId, itemId, index, maxSide, check = () => undefined) {
      check();
      const read = live.peerRuntime?.readHistory?.userImage;
      const source = (read ? await read(chatId, itemId, index, check) : null) ?? live.phoneLiveImage?.(chatId, itemId, index) ?? null;
      check();
      if (!source) return null;
      try {
        if (source.hostImage) {
          const picture = await phoneHostImage(live, chatId, source.hostImage, check);
          check();
          picture?.check();
          return picture ? shrunk(images().createFromBuffer(picture.data), maxSide) : null;
        }
        if (source.url) {
          if (source.url.length > Math.ceil((MOST_FILE_BYTES * 4) / 3) + 100) return null;
          return shrunk(images().createFromDataURL(source.url), maxSide);
        }
        const file = await fs.promises.open(source.path, 'r');
        try {
          check();
          const stat = await file.stat();
          check();
          if (!stat.isFile() || stat.size > MOST_FILE_BYTES) return null;
          // Reading at most the stated size plus one also detects a growing/replaced attachment.
          const bytes = Buffer.alloc(stat.size + 1);
          let read = 0;
          while (read < bytes.length) {
            check();
            const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
            check();
            if (!bytesRead) break;
            read += bytesRead;
          }
          if (read !== stat.size) return null;
          return shrunk(images().createFromBuffer(bytes.subarray(0, read)), maxSide);
        } finally {
          await file.close();
        }
      } catch {
        // a file moved or deleted since it was attached: no picture
        return null;
      }
    },
    /**
     * Where the chat's last browser or desktop call worked: the in-app tab it has now (its title and origin), the user's Chrome, or the app
     * a desktop call named. Null before any such call.
     * @param {string} chatId
     */
    async surface(chatId) {
      const last = live.capabilities?.lastSurfaceOf?.(chatId);
      const kind = last ? KIND[/** @type {keyof typeof KIND} */ (last.needs)] : undefined;
      if (!kind) return null;
      if (kind === 'iab') {
        const tab = live.browserTabs?.current(chatId);
        const origin = tab ? originOf(tab.url) : null;
        return { kind, ...(tab?.title ? { title: String(tab.title).slice(0, 200) } : {}), ...(origin ? { origin } : {}) };
      }
      if (kind === 'desktop' && last.app) {
        const found = await identity.resolve(last.app);
        return { kind, app: { name: found?.name ?? last.app, bundleId: found?.bundleId ?? null } };
      }
      return { kind };
    },
    /**
     * The chat's hand-offs only the Mac finishes, as waiting cards: a login sheet (browser_request_credentials: the password never crosses
     * to a phone) and a tab handed to the user (browser_request_signin: a sign-in, or a check the agent may not solve).
     * @param {string} chatId
     */
    waitingCards(chatId) {
      const cards = [];
      for (const view of live.credentialHandoff?.list() ?? [])
        if (view.chatId === chatId) cards.push(waitingCard(`mac-login:${view.id}`, `sign in to ${hostOf(String(view.origin))}`));
      for (const tab of live.browserTabs?.list(chatId) ?? []) {
        const signin = tab.signin;
        if (!signin) continue;
        const check = !signin.credential && CHECK.test(String(signin.reason));
        cards.push(waitingCard(`mac-signin:${tab.id}`, check ? `complete the check on ${signin.site}` : `sign in to ${signin.site}`));
      }
      return cards;
    },
    /**
     * Hears each change in a chat's running calls (a login sheet begins and ends with its call) and in its in-app tabs (a hand-off ends
     * when the user is done on the Mac). @param {(chatId: string) => void} fn
     */
    onCallChange(fn) {
      const offCalls = live.capabilities?.onCallChange(fn);
      tabListeners.add(fn);
      return () => {
        offCalls?.();
        tabListeners.delete(fn);
      };
    },
  };
}

module.exports = { createPhoneSteps, waitingCard };
