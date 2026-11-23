// Writing imported cookies into the built-in browser's shared session, and the ledger of what an import wrote so it can be taken out again, per site, without touching the user's own cookies.
const { fs } = require('../../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate, withAsyncCleanup } = require('../../../platform/fsutil.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { readOwnedJsonStore } = require('../ownedJsonStore.cjs');
const { isJsonRecord } = require('../../../../shared/jsonRecord.mjs');

/** Only persisted own site entries belong to an import; inherited object keys never do. */
const entryOf = (cookies, site) => (Object.hasOwn(cookies, site) ? cookies[site] : undefined);

/** Only compatible site cleanup records can be displayed or mutated by this format. */
const validEntry = (entry) =>
  isJsonRecord(entry) &&
  typeof entry.source === 'string' &&
  typeof entry.importedAt === 'number' &&
  Array.isArray(entry.entries) &&
  entry.entries.every(
    (target) =>
      Array.isArray(target) &&
      target.length === 4 &&
      typeof target[0] === 'string' &&
      typeof target[1] === 'string' &&
      typeof target[2] === 'string' &&
      typeof target[3] === 'boolean',
  );
const validCookies = (cookies) => isJsonRecord(cookies) && Object.values(cookies).every(validEntry);

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

/** The url a cookie belongs to, as Electron's cookies.set and cookies.remove take it. */
function cookieUrl(c) {
  const host = String(c.host).replace(/^\./, '');
  return `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

/** An imported cookie as session.cookies.set takes it. */
function setDetails(c) {
  return {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    ...(c.hostOnly ? {} : { domain: c.host }),
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : 'unspecified',
    expirationDate: c.expires,
  };
}

/**
 * Sets each cookie in the session (one the session already has is replaced: the user importing wants the other
 * browser's newer sign-in) and flushes the store.
 * @param {{ cookies: { set(d: any): Promise<void>, flushStore(): Promise<void> } }} ses
 * @param {{ host: string, name: string, path: string }[]} cookies
 * @param {{ isCurrent?: () => boolean, onWritten?: (written: typeof cookies) => void }} [o] isCurrent stops cancelled writes; onWritten retains actual cleanup targets even when the flush fails
 * @returns {Promise<{ imported: number, failed: number, written: typeof cookies }>}
 */
async function writeCookies(
  ses,
  cookies,
  { isCurrent = /** @type {() => boolean} */ (() => true), onWritten = (_written) => undefined } = {},
) {
  const written = [];
  let failed = 0;
  for (const c of cookies) {
    if (!isCurrent()) break;
    try {
      await ses.cookies.set(setDetails(c));
      written.push(c);
    } catch (error) {
      // Chromium refuses a cookie it finds invalid (a __Host- cookie without Secure, SameSite=None without Secure)
      noteIgnored('store an imported cookie', error);
      failed++;
    }
  }
  await withAsyncCleanup(
    () => ses.cookies.flushStore(),
    () => onWritten(written),
  );
  return { imported: written.length, failed, written };
}

/** What imports wrote: { version, cookies: { [site]: { source, importedAt, entries: [host, name, path, secure][] } }, last }. */
class ImportLedger {
  /** @param {{ file: string, now?: () => number }} o */
  constructor({ file, now = Date.now }) {
    this.file = file;
    this.now = now;
    /** @type {{ cookies: Record<string, { source: string, importedAt: number, entries: [string, string, string, boolean][] }>, last: any }} */
    this.data = { cookies: {}, last: null };
    this.loaded = false;
    /** @type {Error | null} all writes and session effects must respect saved-format ownership */
    this.writeError = null;
    /** Actual cookie writes whose cleanup ownership could not yet be saved; visible until persisted or removed. */
    this.pendingCookies = new Map();
    /** Physical imports and removals share one order, including after a rejected operation. */
    this.cookieQueue = Promise.resolve();
  }

  #load() {
    if (this.loaded) return;
    this.loaded = true;
    const { data, error, formatError } = readOwnedJsonStore(
      this.file,
      'browser import ledger',
      (raw) => raw.cookies === undefined || validCookies(raw.cookies),
    );
    this.writeError =
      formatError ??
      (error
        ? new Error('The saved browser import ledger could not be read. Restore it and restart MoPilot before editing it.', {
            cause: error,
          })
        : null);
    this.data.cookies = validCookies(data?.cookies) ? data.cookies : {};
    this.data.last = data?.last ?? null;
  }

  /** Admit an import/removal before any browser data or cached recovery ownership changes. */
  assertWritable() {
    this.#load();
    if (this.writeError) throw this.writeError;
  }

  #cookies() {
    return Object.fromEntries([...Object.entries(this.data.cookies), ...this.pendingCookies]);
  }

  /** Order session cookie effects and their ledger update; each caller still receives its own rejection. */
  runCookieMutation(action) {
    const operation = this.cookieQueue.then(action);
    this.cookieQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #save(next) {
    this.assertWritable();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify({ version: 1, ...next }));
    this.data = next;
    this.pendingCookies.clear();
  }

  /** Records the cookies an import wrote, grouped by site; a site imported again replaces its entry. */
  recordCookies(source, written, siteOf) {
    this.assertWritable();
    const bySite = new Map();
    for (const c of written) {
      const site = siteOf(c.host);
      if (!bySite.has(site)) bySite.set(site, []);
      bySite.get(site).push([c.host, c.name, c.path || '/', !!c.secure]);
    }
    let cookies = this.#cookies();
    for (const [site, entries] of bySite) {
      // an import that wrote fewer cookies than an earlier one must not forget the earlier ones: removal deletes both
      const kept = new Map((entryOf(cookies, site)?.entries ?? []).map((e) => [`${e[0]}|${e[1]}|${e[2]}`, e]));
      for (const e of entries) kept.set(`${e[0]}|${e[1]}|${e[2]}`, e);
      cookies = { ...cookies, [site]: { source, importedAt: this.now(), entries: [...kept.values()] } };
    }
    try {
      this.#save({ ...this.data, cookies });
    } catch (error) {
      // These targets were already written into the session. Keep recovery ownership separate from committed state.
      for (const site of bySite.keys()) this.pendingCookies.set(site, cookies[site]);
      throw error;
    }
  }

  /** Remembers the last import, for the settings page. */
  recordLast(last) {
    this.assertWritable();
    this.#save({ ...this.data, cookies: this.#cookies(), last: { ...last, at: this.now() } });
  }

  last() {
    this.#load();
    return this.data.last;
  }

  /** [{ site, source, importedAt, count }] of the sites with imported cookies. */
  sites() {
    this.#load();
    return Object.entries(this.#cookies())
      .map(([site, v]) => ({ site, source: v.source, importedAt: v.importedAt, count: v.entries.length }))
      .sort((a, b) => a.site.localeCompare(b.site));
  }

  /** Takes a site's imported cookies (or every site's) out of the session. Returns how many were removed. */
  remove(ses, site) {
    return this.runCookieMutation(() => this.#remove(ses, site));
  }

  async #remove(ses, site) {
    this.assertWritable();
    const snapshot = this.#cookies();
    const sites = site ? [site] : Object.keys(snapshot);
    const targets = sites.map((s) => ({ site: s, entry: entryOf(snapshot, s) }));
    let removed = 0;
    let failed = 0;
    const updates = [];
    for (const { site: s, entry } of targets) {
      if (!entry) continue;
      const completed = new Set();
      for (const target of entry.entries) {
        // Direct ledger records can still replace ownership between awaits; do not issue another stale removal.
        if (entryOf(this.#cookies(), s) !== entry) break;
        const [host, name, cookiePath, secure] = target;
        try {
          await ses.cookies.remove(cookieUrl({ host, path: cookiePath, secure }), name);
          removed++;
          completed.add(target);
        } catch (error) {
          failed++;
          noteIgnored('remove an imported cookie', error);
        }
      }
      updates.push({ site: s, completed });
    }
    await ses.cookies.flushStore();
    let cookies = this.#cookies();
    for (const { site: s, completed } of updates) {
      const current = entryOf(cookies, s);
      // The queue prevents another removal from retiring this site during its session work.
      // Retire only the exact observed targets; a fresh write creates a new tuple even for the same cookie key.
      const remaining = current.entries.filter((target) => !completed.has(target));
      if (remaining.length) cookies = { ...cookies, [s]: { ...current, entries: remaining } };
      else delete cookies[s];
    }
    this.#save({ ...this.data, cookies });
    if (failed) throw new Error(`${failed} imported cookie${failed === 1 ? '' : 's'} could not be removed. Try again.`);
    return removed;
  }
}

module.exports = { cookieUrl, setDetails, writeCookies, ImportLedger };
