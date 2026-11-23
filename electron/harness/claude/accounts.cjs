// Several Claude Code logins side by side.
//
// "default" is the CLI's own login (~/.claude, ~/.claude.json): Sage never changes it. Every other
// account runs the same CLI with CLAUDE_CONFIG_DIR pointed at its own folder, made under
// <userData>/claude-accounts/<id>. The CLI keys its credentials by that folder (a keychain item
// suffixed with a hash of the literal path on macOS, .credentials.json elsewhere), so logins never mix,
// and each record keeps the path it signed in with across moves (identity/contract/accountDirs.cjs).
// Sage never stores, reads or refreshes the tokens (sign-in runs `claude auth login`).
//
// Everything that isn't a credential is shared: each account folder links to the entries of
// ~/.claude (projects, settings, skills, plugins…; plans stay the account's own, identity/contract/accountDirs.cjs), so chats, transcripts and settings are the same
// on every account and a chat can move between accounts by resuming its session. The account's
// .claude.json keeps its own login fields; every other field is merged both ways with
// ~/.claude.json (before a session starts and after it ends), so what the CLI saves on an account
// (project trust, user-level MCP servers) is not lost and reaches the other accounts too.
//
// Keys Sage holds (API key, MoPilot credits) get a folder of their own too ("key-<mode>"), so the
// CLI's cached login of whichever account was active never mixes with a key.
const { clock } = require('../../platform/ports/clock.cjs');
const { sharedRoot } = require('../../platform/claudeHome.cjs');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const crypto = require('node:crypto');
const { psQuote } = require('../../platform/winbin.cjs');
const { readStateFile, writePrivate } = require('../../platform/fsutil.cjs');
const { isAccountState, accountFolder } = require('../../identity/contract/accountState.cjs');
const {
  isLockEntry,
  unlinkLocks,
  OWN_FOLDERS,
  ownFolders,
  linkShared,
  linksTo,
  adoptConfigDir,
  placeConfigDir,
  deleteAccountFolders,
} = require('../../identity/contract/accountDirs.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { parseClaudeStatus } = require('./status.cjs');
const loginIdentity = require('./loginIdentity.cjs');
const { cliLoginOf, serverIdOf, readerOf, forgetAdded, adoptAddedAs, retireAdded, reloginAdded, signInRepeats, loginRow } = loginIdentity;
const { loginPlan, usageFetchedAt } = loginIdentity;
const { foldSameAccounts } = require('../../identity/contract/sameAccount.cjs');
const { LOGIN_FIELD, NO_SYNC, readConfig, same, merge3, syncable } = require('./configMerge.cjs');

const DEFAULT_ID = 'default';
/** ~/.claude entries an account must not share: its own login lives there. */
const PRIVATE_ENTRIES = new Set(['.credentials.json', '.claude.json', '.config.json']);
/** Shared folders the CLI creates on demand: link them even before they exist. */
const ALWAYS_SHARED = ['projects', 'todos', 'file-history', 'session-env', 'shell-snapshots'];
const SYNC_BASE = '.sage-config-base.json';
const POLL_MS = 3000;
const LOGIN_WAIT_MS = 10 * 60_000;

/** The CLI's own config folder (~/.claude, or CLAUDE_CONFIG_DIR): settings, skills and the user-level CLAUDE.md. */
/**
 * The terminal command that runs `claude auth login` with CLAUDE_CONFIG_DIR set: through env on
 * macOS, through PowerShell on Windows (no /usr/bin/env there).
 */
function loginCommand(bin, dir, platform = process.platform) {
  if (platform === 'win32')
    return ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', `$env:CLAUDE_CONFIG_DIR=${psQuote(dir)}; & ${psQuote(bin)} auth login`];
  return ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${dir}`, bin, 'auth', 'login'];
}

const sharedConfig = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Write the CLI's own .claude.json: through a symlink (a dotfiles setup keeps its link), and only if it
 * still holds `was`, the text the merge read; the CLI writes it often, and a write it made since wins.
 */
function writeShared(f, text, was) {
  let real = f;
  try {
    real = fs.realpathSync.native(f);
  } catch (error) {
    // not there yet (ENOENT): write the path itself
    noteIgnored("resolve the Claude Code CLI's .claude.json", error, ['ENOENT']);
  }
  if (readText(real) !== was) return false;
  writePrivate(real, text);
  return true;
}

class ClaudeAccounts {
  /**
   * @param {{ userData: string, broadcast: (evt: any) => void, run: (bin: string, args: string[], account: string) => Promise<string>,
   *           signedIn?: (id: string) => void, forgotten?: (id: string) => void }} o signedIn: a login that read signed out now
   *   reads signed in; forgotten: an added login was removed
   */
  constructor(o) {
    this.userData = o.userData;
    this.broadcast = o.broadcast;
    this.run = o.run;
    this.signedIn =
      o.signedIn ??
      (() => {
        /* nobody to tell */
      });
    this.forgotten =
      o.forgotten ??
      (() => {
        /* nobody to tell */
      });
    this.file = path.join(o.userData, 'claude-accounts.json');
    this.root = path.join(o.userData, 'claude-accounts');
    /**
     * @type {{ active: string, autoSwitch: boolean, defaultAccount?: { accountUuid: string, email: string | null } | null,
     *          accounts: { id: string, email: string | null, subscriptionType: string | null, loggedIn: boolean, [k: string]: any }[] }}
     */
    this.state = { active: DEFAULT_ID, autoSwitch: true, accounts: [] };
    // first run, or an unreadable file (kept aside by readStateFile): start from the defaults
    Object.assign(this.state, readStateFile(this.file, 'the Claude Code accounts', isAccountState));
    // a sign-in that never finished leaves an empty record behind
    this.state.accounts = this.state.accounts.filter((a) => a.email || a.loggedIn);
    if (!this.get(this.state.active)) this.state.active = DEFAULT_ID;
    for (const a of this.state.accounts) adoptConfigDir(a, this.root);
    /** Added logins running at their folder here because their recorded path couldn't be kept. */
    this.moved = new Set();
    this.pending = null;
    this.cliLogin = cliLoginOf(this, o.userData);
    /** Which account each added login is, read in MoPilot's folder for it (harness/claude/loginIdentity.cjs). */
    this.checks = new Map();
    adoptAddedAs(this);
    this.statusReads = new Map();
    this.refreshRun = null;
    /** Last read of the CLI's own login. @type {{loggedIn: boolean, email: string|null, subscriptionType: string|null, authMethod: string|null}} */
    this.defaultInfo = { loggedIn: false, email: null, subscriptionType: null, authMethod: null };
    /** Whether the CLI's own login has been read since the app started: until then `defaultInfo` is not an answer. */
    this.defaultChecked = false;
  }

  /** @returns {{ id: string, loggedIn?: boolean, [k: string]: any } | null} the default login has only its id */
  get(id) {
    return id === DEFAULT_ID ? { id: DEFAULT_ID } : this.state.accounts.find((a) => a.id === id) || null;
  }
  /** The reader of which account login `id` is (harness/claude/loginIdentity.cjs), or null for a key's folder or an unknown id. */
  identity(id) {
    return id === DEFAULT_ID ? this.cliLogin : readerOf(this, id);
  }
  /** The folder the CLI runs this login with: its recorded path when it can be kept (identity/contract/accountDirs.cjs). */
  dir(id) {
    const local = accountFolder(this.root, id);
    const a = this.state.accounts.find((x) => x.id === id);
    // a recorded path that couldn't be kept is tried again at the next start
    if (!a || this.moved.has(id)) return local;
    adoptConfigDir(a, this.root);
    const { dir, moved } = placeConfigDir(a.configDir, local);
    if (moved) this.moved.add(id);
    return dir;
  }
  save() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writePrivate(this.file, JSON.stringify(this.state, null, 2));
  }
  /** Signed-in logins that are one server account, folded into the login shown for it (identity/contract/sameAccount.cjs). */
  sameAccounts() {
    const logins = [{ id: DEFAULT_ID, loggedIn: this.defaultInfo.loggedIn }, ...this.state.accounts];
    return foldSameAccounts(logins, (a) => (a.loggedIn ? serverIdOf(this, a.id) : null), this.state.active);
  }
  /**
   * Renderer-safe view: no paths, no credentials. The CLI's own login comes first. A login that is the same account as
   * another is left out and named in `same` (folded id -> shown id); the login in use is named by its shown login.
   */
  view() {
    const same = this.sameAccounts();
    const row = (a) => {
      const plan = this.cachedPlan(a.id);
      return {
        id: a.id,
        // the server's account for its token once known (harness/claude/loginIdentity.cjs), which may not be the one it was added as
        ...loginRow(this, a, plan?.email),
        subscriptionType: a.subscriptionType ?? null,
        authMethod: a.authMethod ?? null,
        organizationType: plan?.organizationType ?? null,
        rateLimitTier: plan?.rateLimitTier ?? null,
        loggedIn: !!a.loggedIn,
        checked: a.id === DEFAULT_ID ? this.defaultChecked : true,
        // signed out where its login may not be: its folder moved, so the CLI can't find its sign-in
        reconfirm: !a.loggedIn && (!!a.unconfirmed || this.moved.has(a.id)),
        isDefault: a.id === DEFAULT_ID,
      };
    };
    return {
      active: same[this.state.active] ?? this.state.active,
      autoSwitch: this.state.autoSwitch,
      login: this.pending ? { id: this.pending.id } : null,
      same,
      accounts: [{ id: DEFAULT_ID, ...this.defaultInfo }, ...this.state.accounts.filter((a) => a.loggedIn || this.pending?.id !== a.id)]
        .filter((a) => !same[a.id])
        .map(row),
    };
  }
  changed() {
    this.save();
    this.broadcast({ type: 'changed', state: this.view() });
  }

  /** Link the shared ~/.claude entries into an account folder and refresh its .claude.json. */
  prepare(id) {
    const dir = this.dir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shared = sharedRoot();
    const names = new Set(ALWAYS_SHARED);
    try {
      for (const n of fs.readdirSync(shared)) names.add(n);
    } catch (error) {
      // no shared ~/.claude yet (ENOENT): link only the always-shared entries
      noteIgnored('list the shared Claude Code folder', error, ['ENOENT']);
    }
    unlinkLocks(dir);
    ownFolders(dir);
    for (const n of names) {
      if (PRIVATE_ENTRIES.has(n) || isLockEntry(n) || OWN_FOLDERS.includes(n)) continue;
      const target = path.join(shared, n);
      const link = path.join(dir, n);
      if (ALWAYS_SHARED.includes(n) && !fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink() && linksTo(link, target)) continue;
        // the CLI created its own copy before we linked it: leave real data alone
        if (!st.isSymbolicLink()) continue;
        fs.unlinkSync(link);
      } catch (error) {
        // no entry at the link path yet (ENOENT): create it below
        noteIgnored("check a Claude Code account's shared link", error, ['ENOENT']);
      }
      try {
        linkShared(target, link);
      } catch (error) {
        // the CLI then uses its own copy in this folder
        noteIgnored(`link the shared Claude Code entry ${n} into an account`, error);
      }
    }
    this.syncConfig(dir);
    return dir;
  }

  /**
   * Merge the non-login fields of the folder's .claude.json and the CLI's own, both ways, against
   * what they agreed on last time. The login fields of each side stay where they are.
   */
  syncConfig(dir) {
    const mineFile = path.join(dir, '.claude.json');
    const baseFile = path.join(dir, SYNC_BASE);
    let mine, theirs, theirsText, base;
    try {
      mine = readConfig(mineFile)?.value ?? {};
      const shared = readConfig(sharedConfig());
      theirs = shared?.value ?? null;
      theirsText = shared?.text ?? null;
      base = readConfig(baseFile)?.value ?? {};
    } catch (error) {
      // All three inputs are needed: an empty substitute can erase login fields or config changes.
      noteIgnored('read the Claude Code config inputs to merge them', error);
      return;
    }
    const merged = merge3(base, syncable(theirs), syncable(mine));
    const next = { ...merged };
    for (const [k, v] of Object.entries(mine)) if (LOGIN_FIELD.test(k)) next[k] = v;
    next.hasCompletedOnboarding = true;
    writePrivate(mineFile, JSON.stringify(next, null, 2));
    // the CLI's own file is only touched when a field really changed on our side, and never created.
    // If the CLI wrote it meanwhile, the base stays as it was, so the next sync merges our change again.
    let agreed = true;
    if (theirs && !same(syncable(theirs), merged)) {
      const back = {};
      for (const [k, v] of Object.entries(theirs)) if (LOGIN_FIELD.test(k) || NO_SYNC.has(k)) back[k] = v;
      agreed = writeShared(sharedConfig(), JSON.stringify({ ...back, ...merged }, null, 2), theirsText);
    }
    if (agreed) writePrivate(baseFile, JSON.stringify(merged));
  }
  /** A session on this folder ended: carry what the CLI saved into the shared config. */
  syncBack(id) {
    if (!id || id === DEFAULT_ID) return;
    const dir = this.dir(id);
    if (fs.existsSync(path.join(dir, '.claude.json'))) this.syncConfig(dir);
  }
  /** Folder for a key Sage holds ('apiKey' | 'mopilot'). */
  keyId(mode) {
    return `key-${mode}`;
  }
  keyEnv(mode) {
    return { CLAUDE_CONFIG_DIR: this.prepare(this.keyId(mode)) };
  }

  /** Extra environment for running the CLI as this account (nothing for the CLI's own login). */
  env(id) {
    if (!id || id === DEFAULT_ID || !this.get(id)) return {};
    return { CLAUDE_CONFIG_DIR: this.prepare(id) };
  }

  /** The .claude.json the CLI keeps for this login, found without making any folder (reads only). */
  configFile(id) {
    if (!id || id === DEFAULT_ID) return sharedConfig();
    const a = this.state.accounts.find((x) => x.id === id);
    const kept = a?.configDir && !this.moved.has(id) && fs.existsSync(a.configDir);
    return path.join(kept ? a.configDir : accountFolder(this.root, id), '.claude.json');
  }

  /** The login fields an account's .claude.json caches (plan tier, org), never tokens (harness/claude/loginIdentity.cjs). */
  cachedPlan(id) {
    return loginPlan(this, id);
  }
  /** When the CLI last fetched this login's plan usage (ms): its /usage text is only as new as this. */
  usageFetchedAt(id) {
    return usageFetchedAt(this, id);
  }

  /**
   * An account's login as the CLI reports it, or null when the CLI can't say (not installed, timed out,
   * unexpected output). A failed read is not a sign-out: callers keep what they last knew, so a stored
   * account is never saved without its email and then dropped as an unfinished sign-in at the next start.
   */
  async status(bin, id) {
    try {
      const out = parseClaudeStatus(await this.run(bin, ['auth', 'status', '--json'], id));
      return {
        loggedIn: out.loggedIn,
        email: out.email ?? this.cachedPlan(id)?.email ?? null,
        subscriptionType: out.subscriptionType ?? null,
        authMethod: out.authMethod ?? null,
      };
    } catch (error) {
      noteIgnored('read a Claude Code login', error);
      return null;
    }
  }

  /** Take a read of the CLI's own login; one that reads signed in again is reported. */
  takeDefault(status) {
    const was = this.defaultInfo.loggedIn;
    // a read that failed is an answer too: waiting for one that never comes would hold back every offer
    this.defaultChecked = true;
    this.defaultInfo = status ?? this.defaultInfo;
    if (was && !this.defaultInfo.loggedIn) this.cliLogin.retire(); // whoever signs it in next is unconfirmed
    if (!was && this.defaultInfo.loggedIn) this.signedIn(DEFAULT_ID);
  }
  /** Take a read of an added login; one that reads signed in again is reported. */
  takeAccount(a, status) {
    const was = !!a.loggedIn;
    Object.assign(a, status);
    // signed out: whoever signs it in next is unconfirmed
    if (was && !a.loggedIn) retireAdded(this, a);
    // the path that read signed in is the one its login is keyed by from now on
    if (a.loggedIn) {
      a.configDir = this.dir(a.id);
      a.unconfirmed = undefined;
      this.moved.delete(a.id);
    }
    if (!was && a.loggedIn) this.signedIn(a.id);
  }

  /** A status publication belongs to the latest read for this account. */
  async readStatus(bin, id) {
    const owner = {};
    this.statusReads.set(id, owner);
    const status = await this.status(bin, id);
    return { status, current: () => this.statusReads.get(id) === owner };
  }

  /**
   * Start adding an account: makes its folder and returns the terminal command that signs it in.
   * The CLI's login is watched until it lands (or ten minutes pass).
   */
  startLogin(bin) {
    this.cancelLogin();
    const id = crypto.randomBytes(6).toString('hex');
    const a = { id, email: null, subscriptionType: null, loggedIn: false, configDir: accountFolder(this.root, id) };
    this.state.accounts.push(a);
    const dir = this.prepare(id);
    const startedAt = clock.now();
    /** @type {{id: string, timer?: ReturnType<typeof setTimeout>}} */
    const login = { id };
    const ownsLogin = () => this.pending === login && this.get(id) === a;
    const retry = () => {
      if (clock.now() - startedAt > LOGIN_WAIT_MS) return this.cancelLogin();
      login.timer = clock.setTimeout(poll, POLL_MS);
    };
    // Retain ownership through both reads; cancellation or removal retires their late results.
    const poll = async () => {
      const st = await this.status(bin, id);
      if (!ownsLogin()) return;
      if (st?.loggedIn) {
        const read = await this.readStatus(bin, DEFAULT_ID);
        if (!ownsLogin()) return;
        if (!read.current()) return retry();
        this.pending = null;
        this.takeDefault(read.status);
        // the same server account, never just the same email (#1312); the CLI's own login only when the server named it
        const repeats = signInRepeats(this, id);
        // only a login still signed in is a duplicate; one that lapsed is replaced by this sign-in
        if (repeats.duplicate) {
          this.discard(id, bin);
          this.broadcast({ type: 'notice', kind: 'duplicate', email: st.email });
          return this.changed();
        }
        Object.assign(a, st);
        for (const old of repeats.lapsed) {
          const wasActive = this.state.active === old.id;
          this.discard(old.id, bin);
          if (wasActive) this.state.active = id;
        }
        this.broadcast({ type: 'notice', kind: 'signedIn', id, email: st.email });
        return this.changed();
      }
      return retry();
    };
    this.pending = login;
    login.timer = clock.setTimeout(poll, POLL_MS);
    this.changed();
    return { state: this.view(), id, command: loginCommand(bin, dir) };
  }
  cancelLogin() {
    if (!this.pending) return this.view();
    clock.clearTimeout(this.pending.timer);
    const { id } = this.pending;
    this.pending = null;
    const a = this.get(id);
    if (a && !a.loggedIn) this.discard(id);
    this.changed();
    return this.view();
  }
  /** Command that signs an existing account in again (its login lapsed). */
  reloginCommand(bin, id) {
    if (id !== DEFAULT_ID) {
      reloginAdded(this, id);
      return loginCommand(bin, this.prepare(id));
    }
    this.cliLogin.retire(); // which account it signs in as, the next read of its usage says
    return [bin, 'auth', 'login'];
  }

  discard(id, bin) {
    const pending = this.pending;
    if (pending && pending.id === id) {
      clock.clearTimeout(pending.timer);
      this.pending = null;
    }
    this.statusReads.delete(id);
    forgetAdded(this, id, bin ? 5000 : 0);
    // where it ran, without making a folder again: its recorded path (maybe a link) and its folder here
    const [configDir, local] = [this.state.accounts.find((a) => a.id === id)?.configDir, accountFolder(this.root, id)];
    // best effort: the folder is deleted below either way
    if (bin) this.run(bin, ['auth', 'logout'], id).catch((error) => noteIgnored('sign a removed Claude Code account out', error));
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    this.moved.delete(id);
    this.forgotten(id);
    if (this.state.active === id) this.state.active = DEFAULT_ID;
    // remove only this account's own files; the shared entries are links
    clock.setTimeout(() => deleteAccountFolders(configDir, local), bin ? 5000 : 0);
  }
  /** Sign an added account out and forget it. The CLI's own login is signed out in a terminal instead. */
  remove(bin, id) {
    if (id === DEFAULT_ID) throw new Error('The Claude Code CLI login is signed out with `claude auth logout`');
    this.discard(id, bin);
    this.changed();
    return this.view();
  }
  setActive(id) {
    if (!this.get(id)) throw new Error('Unknown account');
    this.state.active = id;
    this.changed();
    return this.view();
  }
  setAutoSwitch(on) {
    this.state.autoSwitch = !!on;
    this.changed();
    return this.view();
  }
  /** Re-read every account's login (email, plan, signed in or not). */
  async refresh(bin) {
    const run = {};
    this.refreshRun = run;
    const ownsRefresh = () => this.refreshRun === run;
    const read = await this.readStatus(bin, DEFAULT_ID);
    if (!ownsRefresh()) return this.view();
    if (read.current()) this.takeDefault(read.status);
    for (const a of this.state.accounts) {
      if (this.pending?.id === a.id) continue;
      const read = await this.readStatus(bin, a.id);
      if (!ownsRefresh()) return this.view();
      if (read.current() && this.get(a.id) === a && read.status) this.takeAccount(a, read.status);
    }
    this.changed();
    return this.view();
  }
}

module.exports = { ClaudeAccounts, merge3, syncable, CLAUDE_DEFAULT_ID: DEFAULT_ID, sharedRoot, loginCommand };
