// Reads which account a Claude Code login is, in a folder MoPilot owns: CLAUDE_CONFIG_DIR is that folder and
// CLAUDE_SECURESTORAGE_CONFIG_DIR the login's own credential store (the CLI takes its refresh and storage locks there,
// beside the login's other runs). The folder's profile is marked stale before each read, so the CLI fetches
// /api/oauth/profile with the token in use and writes the answer there. MoPilot reads that answer, not the
// credentials. A token refresh marks the
// profile fetched without naming the account again (CLI 2.1.302), so the read clears the email first and never takes
// a refresh for an answer. The account stays named meanwhile: the CLI keeps answering /usage from its cache for that
// account when the usage endpoint refuses (a 429), and drops the cache once the answer names another account. Which
// login each reader is for: harness/claude/loginIdentity.cjs.
const { clock } = require('../../platform/ports/clock.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { unrefTimer } = require('./cli.cjs');

/** How long a read waits, after its result, for the CLI to write the profile it fetched at start. */
const PROFILE_WAIT_MS = 3000;
const POLL_MS = 100;

/**
 * The account a .claude.json names: its uuid, email and when the CLI fetched that profile (ms), or null.
 * @param {any} cfg
 * @returns {{ accountUuid: string, email: string | null, fetchedAt: number | null } | null}
 */
function identityOf(cfg) {
  const a = cfg?.oauthAccount;
  if (!a || typeof a.accountUuid !== 'string' || !a.accountUuid) return null;
  return {
    accountUuid: a.accountUuid,
    email: typeof a.emailAddress === 'string' ? a.emailAddress : null,
    fetchedAt: typeof a.profileFetchedAt === 'number' && Number.isFinite(a.profileFetchedAt) ? a.profileFetchedAt : null,
  };
}

/** A .claude.json, or null when it is missing or unreadable (then it names no account). */
function readConfigFile(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (error) {
    // a login not signed in yet has none; one being written reads again at the next view
    if (/** @type {any} */ (error)?.code !== 'ENOENT') noteIgnored("read a Claude Code login's account", error);
    return null;
  }
}

/**
 * A login, read in MoPilot's folder `dir`. 'pending': no answer yet, or the CLI cannot read that login there (an older
 * CLI without CLAUDE_SECURESTORAGE_CONFIG_DIR); 'ok': the server named `who`; 'failed': the read reached the login but
 * no profile came back.
 */
class LoginIdentity {
  /**
   * @param {string} dir
   * @param {{ waitMs?: number, pollMs?: number, onRead?: (last: LoginIdentity['last']) => void }} [o] onRead: a read
   *   changed what is known
   */
  constructor(dir, o = {}) {
    this.dir = dir;
    this.onRead =
      o.onRead ??
      (() => {
        /* nobody to tell */
      });
    this.file = path.join(dir, '.claude.json');
    this.waitMs = o.waitMs ?? PROFILE_WAIT_MS;
    this.pollMs = o.pollMs ?? POLL_MS;
    /** @type {{ read: 'pending' | 'ok' | 'failed', who: { accountUuid: string, email: string | null } | null }} */
    this.last = { read: 'pending', who: null };
    /** A read ran in the folder (its /usage answer came from the folder's cache), whatever it learned. */
    this.reached = false;
    /** Counts sign-ins and sign-outs: a read that began before one learns nothing of the login after it. */
    this.epoch = 0;
    /** The reads in turn: each clears the folder's account and looks for the profile fetched after its start. */
    this.queue = Promise.resolve();
  }

  /** The variables that run the CLI as the login `base` would run on, with its config in this folder. */
  env(base) {
    return {
      CLAUDE_CONFIG_DIR: this.dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: base.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? base.CLAUDE_CONFIG_DIR ?? '',
    };
  }

  /**
   * Mark the folder's profile stale, so the next CLI start fetches its token's profile (the CLI refetches one older
   * than a day). Its email goes too: only that profile check writes the email, while a token refresh marks the
   * profile fetched and keeps the account named before. Returns the account it named, for the cache kept for it.
   */
  stale() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfg = readConfigFile(this.file) ?? {};
    const named = identityOf(cfg);
    let oauthAccount;
    if (named) {
      const { emailAddress: _named, ...kept } = cfg.oauthAccount;
      oauthAccount = { ...kept, profileFetchedAt: 0 };
    }
    writePrivate(this.file, JSON.stringify({ ...cfg, oauthAccount, hasCompletedOnboarding: true }, null, 2));
    return named?.accountUuid ?? null;
  }

  /**
   * What the CLI wrote since `since` (ms): the profile it fetched (`who`), or a token refresh's mark (`refreshed`: the
   * account named before, marked fetched without an email). After a refresh the CLI fetches no profile at that start.
   */
  heardSince(since) {
    const named = identityOf(readConfigFile(this.file));
    const fresh = !!named && named.fetchedAt !== null && named.fetchedAt >= since;
    const who = fresh && named.email !== null ? { accountUuid: named.accountUuid, email: named.email } : null;
    return { who, refreshed: fresh && !who };
  }

  /** The profile the CLI fetched since `since` (ms), or null. */
  fetchedSince(since) {
    return this.heardSince(since).who;
  }

  /** Wait until the CLI wrote a profile fetched since `since`, or refreshed its token instead, at most waitMs. */
  async waitFor(since) {
    const end = clock.now() + this.waitMs;
    const heard = () => {
      const h = this.heardSince(since);
      return h.who || h.refreshed;
    };
    while (!heard() && clock.now() < end) await new Promise((r) => unrefTimer(r, this.pollMs));
  }

  /**
   * The login was signed in again or out: the account last named is no longer confirmed, and stays shown as
   * unverified until the next read answers.
   */
  retire() {
    this.epoch++;
    if (this.last.read === 'ok') this.take('failed');
  }

  /**
   * The read the old way, when the folder never reached the login (an older CLI): nothing is known from it.
   * @param {() => Promise<any>} plain @param {(read: 'pending' | 'failed') => void} take
   */
  async plainly(plain, take) {
    // its reading is the login's own folder's, whatever this read may record
    this.reached = false;
    try {
      const out = await plain();
      take('pending');
      return out;
    } catch (error) {
      take('failed');
      throw error;
    }
  }

  /**
   * Record what a read learned, and tell the owner when that changed.
   * @param {'pending' | 'ok' | 'failed'} read @param {{ accountUuid: string, email: string | null } | null} [who]
   */
  take(read, who = null) {
    const was = JSON.stringify(this.last);
    this.reached = read !== 'pending';
    this.last = { read, who };
    if (JSON.stringify(this.last) !== was) this.onRead(this.last);
  }

  /**
   * Run `inFolder(hold)`, a CLI run with env(...) set: `hold` is awaited before its CLI closes, so the profile has time
   * to land. When it fails without a profile, the folder never reached the login, and `plain()` reads it the old way.
   * @template T
   * @param {(hold: () => Promise<void>) => Promise<T>} inFolder
   * @param {() => Promise<T>} plain
   * @returns {Promise<T>}
   */
  read(inFolder, plain) {
    const run = async () => {
      const since = clock.now();
      const epoch = this.epoch;
      /** @type {LoginIdentity['take']} what this read learned, unless the login was signed in again or out since it began */
      const take = (read, who = null) => {
        if (this.epoch === epoch) this.take(read, who);
      };
      const hold = () => this.waitFor(since);
      let out;
      try {
        // a folder that cannot be written reads the old way below
        const before = this.stale();
        out = await inFolder(hold);
        const now = this.fetchedSince(since)?.accountUuid;
        // the token is another account than the one the CLI's cache was kept for: read again, so no figure is the old one's
        if (before && now && now !== before) out = await inFolder(hold);
      } catch (error) {
        const { who, refreshed } = this.heardSince(since);
        if (who) {
          take('ok', who);
          throw error;
        }
        // it reached the login and refreshed its token: nothing is learned of its account this time
        if (refreshed) {
          this.reached = true;
          throw error;
        }
        // a folder that named an account reached the login before: this read failed, and the old way would answer
        // from the shared config's cache, which may be another account's
        if (identityOf(readConfigFile(this.file))) {
          take('failed');
          throw error;
        }
        noteIgnored("read the Claude Code CLI login in MoPilot's folder", error);
        return this.plainly(plain, take);
      }
      const { who, refreshed } = this.heardSince(since);
      if (who) take('ok', who);
      // the token was refreshed instead: the last answer stands, and the next read (a fresh token) fetches the profile
      else if (refreshed) this.reached = true;
      // a folder that names an account was reached (the CLI names the one its credentials were issued to before it
      // fetches the profile): the profile did not come
      else if (identityOf(readConfigFile(this.file))) take('failed');
      else return this.plainly(plain, take);
      return out;
    };
    const out = this.queue.then(run, run);
    this.queue = out.then(
      () => undefined,
      () => undefined,
    );
    return out;
  }
}

module.exports = { LoginIdentity, identityOf, readConfigFile };
