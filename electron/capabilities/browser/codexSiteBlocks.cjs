// Codex Browser Use blocks in MoPilot's one site no-go list, for every harness (#1319 G13, #1562).
//
// The sites the user blocked for Codex (browser/config.toml [origins].denied), the browser_use policies in
// config.toml and the organization's managed policy are the user's own policy, so MoPilot's own browser
// tools refuse them in every chat, whatever its harness (Codex, Claude Code, ACP) and after a switch, in both
// browsers' site tables (origins.cjs `external`, wired in electron/app/browserSiteTables.cjs).
//
// A read that fails never drops a block. The managed policy comes only from a running Codex: the one it last
// reported is kept through a read that fails or times out, while Codex isn't running and across restarts (in
// a small file of its own, with the browser fields only, never the rest of Codex's config). config.toml's own
// browser_use is also read from the file, so a block there applies at once, Codex running or not; while Codex
// answers, a block in its report or in the file applies. A file that doesn't parse (the user is halfway through
// an edit) keeps the rules last read from it; a file that is gone has none.
const { fs: nodeFs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('smol-toml');
const { writeAtomic, readStoreFile } = require('../../platform/fsutil.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { browseBlock, locksOf, policiesOf, CONFIG_FILE } = require('./codexBrowserUse.cjs');

/** What a refusal adds when the organization's policy is the one Codex reported before (it isn't answering now). */
const REMEMBERED = 'This is the policy Codex reported when it last ran; MoPilot reads it again whenever Codex runs.';

/** How long the policy Codex reported is reused before it is read again (in the background). */
const POLICY_MS = 60_000;

/**
 * The parts of Codex's policy that decide site access, and nothing else: config/read's whole config may hold
 * secrets (an MCP server's env), so only its browser_use table is kept.
 * @param {{ requirements?: any, config?: any } | null | undefined} limits
 */
function browserLimits(limits) {
  const r = limits?.requirements;
  const c = limits?.config;
  const requirements = isJsonRecord(r)
    ? Object.fromEntries(['allowBrowserAndComputerUse', 'browserUse'].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
    : null;
  return { requirements, config: isJsonRecord(c?.browser_use) ? { browser_use: c.browser_use } : null };
}

/**
 * A TOML file as last read: parsed again only when it changed (path, inode, change time or size), {} when there
 * is none, and the contents last read while it can't be read or parsed (null when nothing was read before).
 * @param {typeof nodeFs} fs
 * @param {() => string} file
 */
function tomlFile(fs, file) {
  /** @type {{ stamp: string, data: any } | null} */
  let seen = null;
  return () => {
    const at = file();
    // another file (CODEX_HOME moved): what the old one said is not this one's
    if (seen && !seen.stamp.startsWith(`${at}\0`)) seen = null;
    try {
      const st = fs.statSync(at);
      const stamp = `${at}\0${st.ino}\0${st.mtimeMs}\0${st.size}`;
      if (seen?.stamp === stamp) return seen.data;
      let data = seen?.data ?? null;
      try {
        data = parse(fs.readFileSync(at, 'utf8'));
      } catch (error) {
        // removed since the stat: the next read finds no file
        noteIgnored(`read ${at} (its rules last read still apply)`, error, ['ENOENT']);
      }
      seen = { stamp, data };
      return data;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') return seen?.data ?? null;
      seen = null;
      return {};
    }
  };
}

/** A path as the user knows it: under their home folder, from ~. */
function shownPath(/** @type {string} */ file, home = os.homedir()) {
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

class CodexSiteBlocks {
  /**
   * @param {{ browserUse: InstanceType<typeof import('./codexBrowserUse.cjs').CodexBrowserUse>, store: string | null,
   *           fs?: typeof nodeFs }} o
   *   browserUse: Codex Browser Use's settings (its CODEX_HOME and policy read); store: where the policy last read
   *   is kept between runs (null: only in memory)
   */
  constructor(o) {
    this.browserUse = o.browserUse;
    this.store = o.store;
    this.fs = o.fs ?? nodeFs;
    /** CODEX_HOME for the read under way (reason(), shown()), read once per call */
    this.home = '';
    /** browser/config.toml: the sites the user blocked for Codex */
    this.rulesFile = tomlFile(this.fs, () => path.join(this.home, CONFIG_FILE));
    /** config.toml: its browser_use policies, read here too */
    this.configFile = tomlFile(this.fs, () => path.join(this.home, 'config.toml'));
    /**
     * the policy last read and when its read started; `known`: the last read answered (Codex's config, every layer,
     * then applies beside the file's)
     * @type {{ at: number, limits: { requirements: any, config: any }, known: boolean }}
     */
    this.policySeen = { at: Number.NEGATIVE_INFINITY, limits: this.load(), known: false };
  }

  /** The user's blocked sites (browser/config.toml), as last read. */
  rules() {
    this.home = this.browserUse.home();
    return this.rulesFile() ?? {};
  }

  /**
   * Why Codex Browser Use refuses `url` in any chat (browseBlock), or null: from the files as they are now and the
   * policy Codex last reported, which is read again in the background once it is POLICY_MS old (at once after a
   * read that decided nothing).
   * @param {string} url
   */
  reason(url, now = Date.now()) {
    if (now - this.policySeen.at > POLICY_MS) this.refresh(now);
    const rules = this.rules();
    const where = { configFile: shownPath(path.join(this.home, 'config.toml')) };
    const { limits, known } = this.policySeen;
    const managed = browseBlock({}, { requirements: limits.requirements }, url, where);
    // the organization's policy as Codex last reported it (Codex isn't answering now): say so, and how it is read again
    if (managed) return known ? managed : `${managed} ${REMEMBERED}`;
    // a block in either applies: Codex's report (every layer) while it answers, and the file as it is now
    return (
      browseBlock(rules, { config: known ? limits.config : null }, url, where) ?? browseBlock({}, { config: this.fileConfig() }, url, where)
    );
  }

  /** config.toml's browser_use as the file says now, else (unreadable) as Codex last reported it. */
  fileConfig() {
    const own = this.configFile();
    return own === null ? this.policySeen.limits.config : isJsonRecord(own.browser_use) ? { browser_use: own.browser_use } : null;
  }

  /**
   * The settings view (CodexBrowserUse.state, or a change's answer) with what reason() applies beside Codex's own
   * answer, so Settings shows every block the browser tools refuse: config.toml's policies from the file, and while
   * Codex doesn't answer, the managed policy last read (and browser use turned off by it).
   * @param {any} view
   */
  shown(view) {
    if (!Array.isArray(view?.policies)) return view;
    this.home = this.browserUse.home();
    const managed = view.requirementsKnown ? null : this.policySeen.limits.requirements;
    // one row per rule: a pattern the file decides differently from Codex's report shows both ways
    const key = (/** @type {any} */ p) => JSON.stringify(p);
    const seen = new Set(view.policies.map(key));
    const more = [...policiesOf(managed, null), ...policiesOf(null, this.fileConfig())].filter(
      (p) => !seen.has(key(p)) && seen.add(key(p)),
    );
    return { ...view, disabled: view.disabled ?? locksOf(managed, null).all, policies: [...view.policies, ...more] };
  }

  /** Reads the policy again; only the newest read may replace it, and only a read that answered does. */
  refresh(/** @type {number} */ now) {
    const seen = { ...this.policySeen, at: now };
    this.policySeen = seen;
    // limits() never rejects: a policy it can't read (Codex timed out or isn't running) is reported as unknown, which
    // decides nothing: the policy last read stays, and the next command reads again rather than a minute later (#1531)
    void this.browserUse.limits().then((read) => {
      if (this.policySeen !== seen) return;
      if (!read.requirementsKnown) {
        seen.at = Number.NEGATIVE_INFINITY;
        seen.known = false;
        return;
      }
      const limits = browserLimits(read);
      const changed = JSON.stringify(limits) !== JSON.stringify(seen.limits);
      seen.limits = limits;
      seen.known = true;
      if (changed) this.save(limits);
    });
  }

  /** The policy kept from the last run, or none. */
  load() {
    if (!this.store) return { requirements: null, config: null };
    const { data } = readStoreFile(this.store, 'the Codex Browser Use policy last read', isJsonRecord);
    return browserLimits(data);
  }

  save(limits) {
    if (!this.store) return;
    try {
      writeAtomic(this.store, `${JSON.stringify({ version: 1, ...limits })}\n`, this.fs);
    } catch (error) {
      // it still applies for this run
      noteIgnored('keep the Codex Browser Use policy for the next run', error);
    }
  }
}

module.exports = { CodexSiteBlocks, browserLimits, shownPath, POLICY_MS };
