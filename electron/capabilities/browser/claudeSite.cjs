// Whether the built-in browser's shared profile is signed in to claude.ai, read from its cookies and pushed to windows.
//
// - Signed in means the profile holds claude.ai's `sessionKey` cookie with a value, as a session cookie or one whose
//   expiry is still ahead. The name is claude.ai's, not ours: if it is ever renamed this answers false, and the
//   artifact pane's login-redirect check is the fallback.
// - start() reads it and follows the profile's cookie changes, keeping only claude.ai's `sessionKey` (a sign-in in the
//   pane, a cookie import, a sign-out, an eviction). The soonest expiry of the cookies that count re-reads too, since
//   Chromium need not announce one.
// - Latest read wins: each change bumps a generation and starts one coalesced re-read. A read a newer change overtook
//   is discarded and read again; a read that fails keeps the last answer (null: unknown until a read decides).
// - Each new answer goes to every window as browser:claudeSignIn with a monotonic seq; the snapshot (invoke
//   browser:claudeSignIn) carries the seq of the answer it holds, and the renderer keeps the higher.
// - It lives in main: it follows the profile, and keeps its answer, with no window open.
const { noteIgnored } = require('../../ignored.cjs');

const CHANNEL = 'browser:claudeSignIn';
const CLAUDE_URL = 'https://claude.ai';
const COOKIE = 'sessionKey';
/** setTimeout's longest delay: a later expiry re-reads then, and waits again. */
const MAX_DELAY = 2 ** 31 - 1;

/** Whether a cookie's domain is claude.ai or one of its subdomains, never a lookalike such as claude.ai.evil.com. */
function claudeDomain(/** @type {unknown} */ domain) {
  const d = String(domain ?? '')
    .toLowerCase()
    .replace(/^\./, '');
  return d === 'claude.ai' || d.endsWith('.claude.ai');
}

/** Whether a cookie (from a read or a change event) is claude.ai's sign-in cookie. */
const isSignInCookie = (/** @type {any} */ cookie) => !!cookie && cookie.name === COOKIE && claudeDomain(cookie.domain);

/**
 * When a cookie stops counting, in ms since the epoch: Infinity for a session cookie (Electron gives those no
 * expirationDate), -Infinity for an expiry that is not a number, so a malformed cookie never reads as signed in.
 */
function expiresAt(/** @type {any} */ cookie) {
  if (cookie.session === true || cookie.expirationDate === undefined) return Infinity;
  return Number.isFinite(cookie.expirationDate) ? cookie.expirationDate * 1000 : -Infinity;
}

/**
 * What a read of the profile's cookies says: whether a sign-in cookie counts at `now`, and when the soonest of those
 * stops counting (Infinity when none will).
 * @param {unknown} cookies what cookies.get resolved
 * @param {number} now
 */
function readAnswer(cookies, now) {
  const counted = (Array.isArray(cookies) ? cookies : []).filter(
    (c) => isSignInCookie(c) && typeof c.value === 'string' && c.value !== '' && expiresAt(c) > now,
  );
  return { signedIn: counted.length > 0, until: Math.min(...counted.map(expiresAt)) };
}

class ClaudeSiteSignIn {
  /**
   * @param {{ session: () => any, broadcast: (channel: string, payload: any) => void, now?: () => number,
   *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void } }} o
   *   session: the shared profile's session (BrowserStorage.shared), asked for at start()
   *   broadcast: to every window; none open is fine
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? { setTimeout, clearTimeout };
    /** @type {boolean | null} null until a read decides */
    this.signedIn = null;
    /** bumped with each new answer */
    this.seq = 0;
    /** bumped by each change and by stop(): a read started under an older one is stale */
    this.gen = 0;
    /** the session followed while started, else null */
    this.ses = null;
    /** whether `changed` is subscribed on it */
    this.subscribed = false;
    /** @type {Promise<void> | null} the read in flight, which reads again while changes overtake it */
    this.reading = null;
    /** the re-read at the soonest expiry */
    this.timer = null;
    this.onChanged = (/** @type {unknown} */ _event, /** @type {any} */ cookie) => {
      if (isSignInCookie(cookie)) this.changed();
    };
  }

  /** Reads the answer and follows the profile's changes; a second start() before stop() does nothing. */
  start() {
    if (this.ses) return;
    this.ses = this.o.session();
    try {
      this.ses.cookies.on('changed', this.onChanged);
      this.subscribed = true;
    } catch (error) {
      // no change events: the answer is read now and at each expiry only
      noteIgnored("follow the browser profile's claude.ai cookie", error);
    }
    this.changed();
  }

  /** Stops following the profile: a read in flight is discarded, the last answer stays. */
  stop() {
    const ses = this.ses;
    if (!ses) return;
    this.ses = null;
    this.gen++;
    this.expireAt(Infinity);
    if (this.subscribed) ses.cookies.removeListener('changed', this.onChanged);
    this.subscribed = false;
  }

  /** The cookie may have changed: one read, coalesced with the one in flight (which then reads again). */
  changed() {
    this.gen++;
    // the reads start on the next microtask, once `reading` holds them, and clear it in the same step as their last
    // generation check: a change never finds a read that already finished
    this.reading ??= Promise.resolve().then(() => this.readLatest());
  }

  async readLatest() {
    try {
      for (;;) {
        const { gen, ses } = this;
        if (!ses) return;
        /** @type {ReturnType<typeof readAnswer> | null} */
        let answer = null;
        try {
          answer = readAnswer(await ses.cookies.get({ url: CLAUDE_URL, name: COOKIE }), this.now());
        } catch (error) {
          // the last answer stands (null while none was decided)
          noteIgnored("read the browser profile's claude.ai sign-in", error);
        }
        // a newer change, or stop(), overtook this read: its answer is stale
        if (gen !== this.gen) continue;
        if (answer) {
          this.expireAt(answer.until);
          this.publish(answer.signedIn);
        }
        return;
      }
    } finally {
      this.reading = null;
    }
  }

  /** A re-read when the soonest counted cookie expires; Infinity cancels it. */
  expireAt(/** @type {number} */ until) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (until === Infinity) return;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        this.changed();
      },
      Math.min(until - this.now(), MAX_DELAY),
    );
    // it never keeps the process up
    this.timer.unref();
  }

  publish(/** @type {boolean} */ signedIn) {
    if (signedIn === this.signedIn) return;
    this.signedIn = signedIn;
    this.seq++;
    try {
      this.o.broadcast(CHANNEL, this.snapshot());
    } catch (error) {
      // a window that could not take the push reads the snapshot (the answer above stands)
      noteIgnored("push the browser's claude.ai sign-in to the windows", error);
    }
  }

  /** @returns {{ signedIn: boolean | null, seq: number }} */
  snapshot() {
    return { signedIn: this.signedIn, seq: this.seq };
  }

  /** The answer, once the read in flight (if any) settles. */
  async state() {
    await this.reading;
    return this.snapshot();
  }
}

/**
 * The shared profile's claude.ai sign-in, started, and invoke browser:claudeSignIn answering it (the push of the same
 * name comes from it). dispose() stops it and removes the handler.
 * @param {{ ipcMain: { handle: Function, removeHandler: Function } } & ConstructorParameters<typeof ClaudeSiteSignIn>[0]} o
 */
function registerClaudeSignIn({ ipcMain, ...o }) {
  const signIn = new ClaudeSiteSignIn(o);
  ipcMain.handle(CHANNEL, () => signIn.state());
  signIn.start();
  return {
    signIn,
    dispose: () => {
      ipcMain.removeHandler(CHANNEL);
      signIn.stop();
    },
  };
}

module.exports = { ClaudeSiteSignIn, registerClaudeSignIn, readAnswer, claudeDomain, isSignInCookie, CHANNEL, COOKIE };
