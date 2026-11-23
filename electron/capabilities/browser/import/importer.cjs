// Importing bookmarks, history, cookies and passwords from another browser into the built-in browser: one job at a time (start reads and, for cookies and passwords, unlocks the key and lists the sites; run writes what the user chose, one category at a time), cancel, and what was imported so it can be removed.
const crypto = require('node:crypto');
const { ImportError, classify } = require('./errors.cjs');
const { siteOf, siteOfOrigin, groupCookies } = require('./sites.cjs');
const { writeCookies } = require('./cookies.cjs');
const { zeroKey } = require('./chromiumKey.cjs');

/** The categories, in the order they run. */
const KINDS = ['bookmarks', 'history', 'cookies', 'passwords'];
/** How long a job waits for the user to choose before its cookies are dropped from memory. */
const JOB_MS = 10 * 60_000;

/**
 * @typedef {{ bookmarks?: boolean, history?: boolean, cookies?: boolean, passwords?: boolean }} Kinds
 * @typedef {{ status: 'ok' | 'failed' | 'cancelled', code?: string, imported?: number, skippedExisting?: number, skippedInvalid?: number, failed?: number, replaced?: number, sites?: number }} KindResult
 */

class BrowserImporter {
  /**
   * @param {{
   *   sources: () => any[],
   *   readers: Record<string, { bookmarks(profile: any): Promise<any[]>, history(profile: any): Promise<any[]>, cookies(profile: any, key: Buffer | null): Promise<{ cookies: any[], stats: any }>, passwords?: (profile: any, key: Buffer | null, o: { file: string | null }) => Promise<{ logins: any[], stats: any }> }>,
   *   key: (service: string) => Promise<Buffer>,
   *   history: () => { importVisits(v: any[], source: string): any, importedSources(): any[], deleteImported(source?: string): number },
   *   bookmarks: () => { importItems(items: any[], name: string, source: string): any, importedSources(): any[], deleteImported(source?: string): number },
   *   session: () => any,
   *   logins: () => { saveMany(l: any[], source: string): { imported: number, replaced: number } | null, importedSources(): any[], deleteImported(source?: string): number },
   *   ledger: InstanceType<typeof import('./cookies.cjs').ImportLedger>,
   *   broadcast?: (channel: string, payload: any) => void,
   *   jobMs?: number,
   * }} o
   *   sources: what listSources reports now
   *   readers: per source kind ('chromium', 'safari'), the reads of one profile
   *   key: the Chromium OSCrypt key for a keychain item (asks the user)
   *   session: the shared profile's Electron session, where cookies go
   *   logins: MoPilot's own login store (credentialStore.cjs), where passwords go
   */
  constructor(o) {
    this.o = { ...o, broadcast: o.broadcast ?? (() => undefined), jobMs: o.jobMs ?? JOB_MS };
    /** the passwords file the user chose (Safari's export), or null */
    this.passwordFile = /** @type {string | null} */ (null);
    /** @type {any} */
    this.job = null;
    /** Latest admitted job owns global progress and the last-import summary, even after it ends. */
    this.latestJobId = /** @type {string | null} */ (null);
  }

  /**
   * The sources with what each can bring: [{ ...source, kinds, passwordFile }]. Arc keeps its bookmarks (pinned tabs)
   * elsewhere; Safari's passwords are in iCloud Keychain, which no app can read, so they come from the file the user
   * exports from Safari (passwordFile: true).
   */
  sources() {
    return this.o.sources().map((s) => ({
      ...s,
      kinds: { bookmarks: s.id !== 'arc', history: true, cookies: true, passwords: true },
      passwordFile: s.kind === 'safari',
    }));
  }

  /** The passwords file the user chose for the next import (null forgets it). */
  setPasswordFile(file) {
    this.passwordFile = typeof file === 'string' && file ? file : null;
  }

  /** Throws when `job` was cancelled, expired or replaced while the caller awaited. */
  #live(job) {
    if (this.job !== job || job.cancelled) throw new ImportError('cancelled', 'The import was cancelled.');
  }

  /** Completion may report to its caller, but only the latest admitted import can publish globally. */
  #latest(job) {
    return this.latestJobId === job.id;
  }

  /** A late read failure belongs to a cancelled job, not its replacement. */
  #failure(job, error) {
    try {
      this.#live(job);
    } catch (cancelled) {
      return classify(cancelled);
    }
    return classify(error);
  }

  #end(job) {
    clearTimeout(job.timer);
    job.cookies = null;
    job.passwords = null;
    if (this.job === job) this.job = null;
  }

  /**
   * Prepares an import: reads nothing for bookmarks and history (that happens in run), and for cookies and passwords
   * unlocks the browser's key once (the keychain asks the user), reads them and lists their sites. A failure of either
   * does not stop the other categories: it is reported in `failed`.
   * @param {{ source: string, profile: string, kinds: Kinds }} req
   * @returns {Promise<{ jobId: string, sites: { site: string, count: number, logins: number, sensitive: boolean, reason: string | null }[], failed: Record<string, string> }>}
   */
  async start({ source, profile, kinds }) {
    if (this.job?.running) throw new ImportError('busy', 'An import is already running.');
    // a job still waiting for the user's choice (its dialog was reloaded or lost) gives way to the new one
    if (this.job) this.#end(this.job);
    const src = this.sources().find((s) => s.id === source);
    if (!src) throw new ImportError('missing', 'That browser was not found.');
    // a passwords file is read wherever the user saved it: no Full Disk Access is needed for it alone
    const fileOnly =
      src.passwordFile &&
      src.status === 'needs_full_disk_access' &&
      !!kinds?.passwords &&
      !kinds.bookmarks &&
      !kinds.history &&
      !kinds.cookies;
    if (src.status !== 'ready' && !fileOnly)
      throw new ImportError(
        src.status === 'needs_full_disk_access' ? 'access_blocked' : 'unsupported',
        `${src.name} can't be read (${src.status}).`,
      );
    const prof = src.profiles.find((p) => p.id === profile);
    if (!prof) throw new ImportError('missing', 'That profile was not found.');
    const wanted = Object.fromEntries(KINDS.map((k) => [k, !!kinds?.[k] && src.kinds[k]]));
    if (!KINDS.some((k) => wanted[k])) throw new ImportError('unsupported', 'Nothing to import.');
    const job = {
      id: crypto.randomUUID(),
      src,
      prof,
      wanted,
      cancelled: false,
      cookies: /** @type {any[] | null} */ (null),
      passwords: /** @type {any[] | null} */ (null),
      failed: /** @type {Record<string, string>} */ ({}),
      timer: setTimeout(() => this.#end(job), this.o.jobMs),
    };
    job.timer.unref?.();
    this.job = job;
    this.latestJobId = job.id;
    const secrets = ['cookies', 'passwords'].filter((k) => wanted[k]);
    if (secrets.length) {
      /** @type {Buffer | null} */
      let key = null;
      try {
        try {
          if (src.keychainService) key = await this.o.key(src.keychainService);
          this.#live(job);
        } catch (error) {
          // no key (denied, or cancelled meanwhile): neither cookies nor passwords can be read
          const e = this.#failure(job, error);
          if (e.code === 'cancelled') throw e;
          for (const k of secrets) job.failed[k] = e.code;
        }
        const reader = this.o.readers[src.kind];
        for (const k of secrets) {
          if (job.failed[k]) continue;
          try {
            if (k === 'cookies') job.cookies = (await reader.cookies(prof, key)).cookies;
            else job.passwords = (await /** @type {any} */ (reader.passwords)(prof, key, { file: this.passwordFile })).logins;
            this.#live(job);
          } catch (error) {
            const e = this.#failure(job, error);
            if (e.code === 'cancelled') throw e;
            job.failed[k] = e.code;
          }
        }
      } catch (error) {
        // a cancelled import ends here; any other problem leaves the other categories to run
        this.#end(job);
        throw error;
      } finally {
        if (key) zeroKey(key);
      }
    }
    const sites = job.cookies || job.passwords ? groupCookies(job.cookies ?? [], job.passwords ?? []) : [];
    return { jobId: job.id, sites, failed: { ...job.failed } };
  }

  /**
   * Writes what the user chose: bookmarks, then history, then the cookies of the chosen sites. Progress goes out as
   * each category finishes; the results say per category what happened.
   * @param {{ jobId: string, sites?: string[] }} req
   * @returns {Promise<Record<string, KindResult>>}
   */
  async run({ jobId, sites = [] }) {
    const job = this.job;
    if (!job || job.id !== jobId) throw new ImportError('cancelled', 'This import is no longer running.');
    // a second run of the same job (a double click) must not write everything twice
    if (job.running) throw new ImportError('busy', 'This import is already running.');
    this.o.ledger.assertWritable(); // format ownership admits the whole import before any category writes
    job.running = true;
    // the user's choice is in: the job no longer expires while it writes
    clearTimeout(job.timer);
    /** @type {Record<string, KindResult>} */
    const results = {};
    const choice = new Set(sites);
    try {
      for (const kind of KINDS) {
        if (!job.wanted[kind]) continue;
        if (job.failed[kind]) results[kind] = { status: 'failed', code: job.failed[kind] };
        else if (this.job !== job || job.cancelled) results[kind] = { status: 'cancelled' };
        else results[kind] = await this.#one(job, kind, choice);
        if (this.#latest(job)) this.o.broadcast('browser:importProgress', { jobId, kind, result: results[kind] });
      }
      if (this.#latest(job)) this.o.ledger.recordLast({ source: job.src.id, profile: job.prof.id, results });
    } finally {
      this.#end(job);
    }
    return results;
  }

  /** One category's read and write; a failure is that category's result, never a throw. */
  async #one(job, kind, choice) {
    const { src, prof } = job;
    const reader = this.o.readers[src.kind];
    try {
      if (kind === 'bookmarks') {
        const items = await reader.bookmarks(prof);
        this.#live(job);
        return { status: 'ok', ...this.o.bookmarks().importItems(items, src.name, src.id) };
      }
      if (kind === 'history') {
        const visits = await reader.history(prof);
        this.#live(job);
        return { status: 'ok', ...this.o.history().importVisits(visits, src.id) };
      }
      if (kind === 'passwords') {
        const chosen = job.passwords.filter((l) => choice.has(siteOfOrigin(l.origin)));
        const out = this.o.logins().saveMany(chosen, `import:${src.id}`);
        if (!out) return { status: 'failed', code: 'storage_unavailable' };
        return {
          status: 'ok',
          imported: out.imported,
          replaced: out.replaced,
          sites: new Set(chosen.map((l) => siteOfOrigin(l.origin))).size,
        };
      }
      const chosen = job.cookies.filter((c) => choice.has(siteOf(c.host)));
      return await this.o.ledger.runCookieMutation(async () => {
        this.#live(job); // a cancelled job may have waited behind a removal before its turn starts
        const out = await writeCookies(this.o.session(), chosen, {
          isCurrent: () => this.job === job && !job.cancelled,
          onWritten: (written) => this.o.ledger.recordCookies(src.id, written, siteOf),
        });
        this.#live(job);
        return { status: 'ok', imported: out.imported, failed: out.failed, sites: new Set(out.written.map((c) => siteOf(c.host))).size };
      });
    } catch (error) {
      const e = this.#failure(job, error);
      return e.code === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', code: e.code };
    }
  }

  /** Stops the job: nothing more is written, and its cookies leave memory. A job that is not this one is left alone. */
  cancel(jobId) {
    const job = this.job;
    if (!job || job.id !== jobId) return false;
    job.cancelled = true;
    this.#end(job);
    return true;
  }

  /** What imports brought, for Settings → Browser → Imported data. */
  imported() {
    return {
      history: this.o.history().importedSources(),
      bookmarks: this.o.bookmarks().importedSources(),
      cookies: this.o.ledger.sites(),
      passwords: this.o.logins().importedSources(),
      last: this.o.ledger.last(),
    };
  }

  /** Removes the cookies an import wrote (one site, or every site). */
  removeCookies(site) {
    return this.o.ledger.remove(this.o.session(), site);
  }

  deleteHistory(source) {
    return this.o.history().deleteImported(source);
  }

  deleteBookmarks(source) {
    return this.o.bookmarks().deleteImported(source);
  }

  /** Forgets the passwords an import brought (one source, or all). */
  deletePasswords(source) {
    return this.o.logins().deleteImported(source);
  }
}

module.exports = { BrowserImporter, KINDS, JOB_MS };
