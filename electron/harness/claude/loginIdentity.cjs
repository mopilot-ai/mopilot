// Which account each Claude Code login is: the server's answer for its token (harness/claude/loginReader.cjs reads it), never
// a config's own name. The CLI's ~/.claude.json is shared with every client that runs the CLI on ~/.claude (Claude
// Desktop, a terminal), and whichever last fetched a profile wrote its account there; an added login's folder can
// name one account while its credential store holds another's token, and the CLI never corrects that name (#1582).
// The CLI's /usage cache is keyed by that name too. So every login's usage is read in a MoPilot-owned folder, the
// answer is kept as the login's account, and an added login whose answer is another account than the one it was
// added as says so.
const { clock } = require('../../platform/ports/clock.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { LoginIdentity, identityOf, readConfigFile } = require('./loginReader.cjs');

const DEFAULT_ID = 'default';
/** Where MoPilot reads each added login, under userData: one folder per login id. */
const CHECK_ROOT = 'claude-login-check';
/** @typedef {{ accountUuid: string, email: string | null }} Account */
/**
 * @typedef {{ id: string, email?: string | null, loggedIn?: boolean, serverAccount?: Account, addedAs?: Account, warned?: string }} AddedLogin
 *   serverAccount: the server's last answer for its token; addedAs: the account it was added as; warned: the other
 *   account the user was last told it is signed in as
 */
/** @typedef {InstanceType<typeof LoginIdentity>} Reader */
/**
 * @typedef {{ configFile: (id?: string) => string, defaultInfo: { email: string | null, loggedIn?: boolean }, cliLogin: Reader,
 *   identity: (id: string) => Reader | null, broadcast: (evt: any) => void, changed: () => void, userData: string,
 *   checks: Map<string, Reader>, state: { accounts: AddedLogin[], defaultAccount?: Account | null } }} Logins
 */

/** @param {Logins} logins @param {string} id */
const namedBy = (logins, id) => identityOf(readConfigFile(logins.configFile(id)));
/** @param {{ accountUuid: string, email: string | null } | null} n @returns {Account | undefined} */
const accountOf = (n) => (n ? { accountUuid: n.accountUuid, email: n.email } : undefined);
/** @param {Logins} logins @param {string} id */
const addedLogin = (logins, id) => logins.state.accounts.find((a) => a.id === id);

/**
 * The CLI's own login as the accounts view shows it. The server's answer wins over what ~/.claude.json names; after a
 * failed read the last answer is kept, unverified. With no answer ever, the shared config's name stands, doubted when an
 * added login already is that account: MoPilot never keeps two logins of one account, so the name came from another
 * client.
 * @param {Logins} logins
 * @returns {{ email: string | null, identity: 'verified' | 'unverified' | null }}
 */
function cliLogin(logins) {
  const { read, who } = logins.cliLogin.last;
  if (read === 'ok' && who) return { email: who.email, identity: 'verified' };
  const known = logins.state.defaultAccount;
  if (known) return { email: known.email, identity: read === 'failed' ? 'unverified' : null };
  const named = namedBy(logins, DEFAULT_ID);
  const doubted =
    read === 'failed' || (!!named && logins.state.accounts.some((a) => namedBy(logins, a.id)?.accountUuid === named.accountUuid));
  return { email: logins.defaultInfo.email ?? named?.email ?? null, identity: doubted ? 'unverified' : null };
}

/** An added login's account: the server's answer for its token in this run, else the last one kept for it. */
function serverAccountOf(logins, id) {
  const reader = logins.identity(id);
  if (reader?.last.read === 'ok' && reader.last.who) return reader.last.who;
  return addedLogin(logins, id)?.serverAccount ?? null;
}

/**
 * An added login as the accounts view shows it: the server's account for its token once known. 'mismatch': that is
 * another account than the one it was added as (`addedAs`), so it needs signing in again as that one. 'unverified':
 * the last read could not ask the server (or the login was just signed in again and nothing answered yet), so the
 * label stands but is not confirmed; a kept mismatch stays one, since it is the last thing the server said.
 * @param {Logins} logins @param {AddedLogin} a
 * @returns {{ email: string | null, identity: 'verified' | 'mismatch' | 'unverified' | null, addedAs: string | null }}
 */
function shownLogin(logins, a) {
  const server = serverAccountOf(logins, a.id);
  const failed = logins.identity(a.id)?.last.read === 'failed';
  if (!server) return { email: a.email ?? null, identity: failed ? 'unverified' : null, addedAs: null };
  const other = !!a.addedAs && a.addedAs.accountUuid !== server.accountUuid;
  return {
    email: server.email ?? a.email ?? null,
    identity: other ? 'mismatch' : failed ? 'unverified' : 'verified',
    addedAs: other ? (a.addedAs?.email ?? null) : null,
  };
}

/**
 * The email a login is shown with: the server's account when it is known (the CLI names its login from a config that
 * can be another account's).
 * @param {Logins} logins @param {string} id
 */
function loginEmail(logins, id) {
  if (id === DEFAULT_ID) return cliLogin(logins).email;
  const a = addedLogin(logins, id);
  return a ? shownLogin(logins, a).email : null;
}

/**
 * A login's row fields in the accounts view: its email, whether it is the account shown, with 'mismatch' the account it
 * was added as, and the server account it is (`serverId`: a usage reading of another account is never shown for it).
 * @param {Logins} logins @param {AddedLogin} a @param {string | null | undefined} planEmail its cached plan's email
 */
function loginRow(logins, a, planEmail) {
  const serverId = serverIdOf(logins, a.id);
  if (a.id === DEFAULT_ID) {
    const cli = cliLogin(logins);
    return { email: cli.email, identity: cli.identity, serverId };
  }
  const shown = shownLogin(logins, a);
  const addedAs = shown.addedAs ? { addedAs: shown.addedAs } : {};
  return { email: shown.email ?? planEmail ?? null, identity: shown.identity, ...addedAs, serverId };
}

/**
 * The server account a login is (#1312), or null when that is not known for sure: only the server's answer for its
 * token. A config's name is not (the CLI's shared config can name another client's account, and an added login's
 * folder can name another account than its token's).
 * @param {Logins} logins @param {string} id
 * @returns {string | null}
 */
function serverIdOf(logins, id) {
  if (id !== DEFAULT_ID) return serverAccountOf(logins, id)?.accountUuid ?? null;
  const { read, who } = logins.cliLogin.last;
  return read === 'ok' && who ? who.accountUuid : null;
}

/**
 * The reader of the CLI's own login for `logins` (harness/claude/accounts.cjs): an answer is kept as the last known account
 * (claude-accounts.json defaultAccount) and shown at once.
 * @param {{ state: { defaultAccount?: any }, changed: () => void }} logins @param {string} userData
 */
const cliLoginOf = (logins, userData) =>
  new LoginIdentity(path.join(userData, 'claude-cli-login'), {
    onRead: (last) => {
      if (last.who) logins.state.defaultAccount = last.who;
      logins.changed();
    },
  });

/** The folder MoPilot reads added login `id` in. @param {string} userData @param {string} id */
const checkDir = (userData, id) => path.join(userData, CHECK_ROOT, id);

/**
 * The reader of added login `id`: an answer is kept on its record and shown at once. When it is another account than
 * the login was added as, the user is told once per such account (`warned`), so a read while a sign-in again is still
 * open, which answers for the token it replaces, says nothing new; an answer of the account it was added as clears it.
 * @param {Logins} logins @param {string} userData @param {string} id
 */
const addedLoginOf = (logins, userData, id) =>
  new LoginIdentity(checkDir(userData, id), {
    onRead: (last) => {
      const a = addedLogin(logins, id);
      const who = last.read === 'ok' ? last.who : null;
      /** @type {object | null} */
      let notice = null;
      if (a && who) {
        a.serverAccount = who;
        // a login added before MoPilot kept which account that was: the first answer is it
        const addedAs = (a.addedAs ??= who);
        if (addedAs.accountUuid === who.accountUuid) delete a.warned;
        else if (a.warned !== who.accountUuid) {
          a.warned = who.accountUuid;
          notice = { type: 'notice', kind: 'otherAccount', id, email: who.email, addedAs: addedAs.email };
        }
      }
      logins.changed();
      if (notice) logins.broadcast(notice);
    },
  });

/** The reader of added login `id`, made once; null when there is no such login (a key's folder). @param {Logins} logins @param {string} id */
function readerOf(logins, id) {
  if (!addedLogin(logins, id)) return null;
  let reader = logins.checks.get(id);
  if (!reader) logins.checks.set(id, (reader = addedLoginOf(logins, logins.userData, id)));
  return reader;
}

/**
 * Added login `id` was removed: its reader is forgotten, and MoPilot's folder for it goes after `delayMs` (nothing
 * there is linked).
 * @param {Logins} logins @param {string} id @param {number} delayMs
 */
function forgetAdded(logins, id, delayMs) {
  const reader = logins.checks.get(id);
  logins.checks.delete(id);
  const dir = checkDir(logins.userData, id);
  const remove = () => void clock.setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), delayMs);
  // after the reads already started there, which would write the folder again
  if (reader) reader.queue.then(remove);
  else remove();
}

/**
 * Logins added before MoPilot kept which account each was added as: the account its folder names, as its sign-in
 * wrote it there.
 * @param {Logins} logins
 */
function adoptAddedAs(logins) {
  for (const a of logins.state.accounts) {
    const named = a.addedAs ? undefined : accountOf(namedBy(logins, a.id));
    if (named) a.addedAs = named;
  }
}

/**
 * An added login just signed in (`claude auth login` in its folder): the CLI wrote the profile it fetched with the
 * new token there, so that is the server's answer and the account it was added as.
 * @param {Logins} logins @param {AddedLogin} a
 */
function signedInAs(logins, a) {
  const named = accountOf(namedBy(logins, a.id));
  if (named) a.serverAccount = a.addedAs = named;
}

/**
 * An added login is signed in again or out: its token may be another account's now, so no answer for it stands until
 * the next read. The account it was added as stays, to say whether the new sign-in is that one.
 * @param {Logins} logins @param {AddedLogin} a
 */
function retireAdded(logins, a) {
  delete a.serverAccount;
  logins.identity(a.id)?.retire();
}

/**
 * Added login `id` is being signed in again (its terminal command is about to run): which account that is, the next
 * read of its usage says, and its row warns when that is not the one it was added as.
 * @param {Logins} logins @param {string} id
 */
function reloginAdded(logins, id) {
  const a = addedLogin(logins, id);
  if (!a) return;
  retireAdded(logins, a);
  logins.changed();
}

/**
 * What a new sign-in of added login `id` repeats, by server account and never by email (#1312): whether a login still
 * signed in is that account (a duplicate), and the lapsed logins it replaces. A lapsed login can no longer be read, so
 * it is the account it was added as when the server never said. The new login is named first by what its sign-in wrote.
 * @param {Logins} logins @param {string} id
 * @returns {{ duplicate: boolean, lapsed: AddedLogin[] }}
 */
function signInRepeats(logins, id) {
  const a = addedLogin(logins, id);
  if (a) signedInAs(logins, a);
  const account = serverIdOf(logins, id);
  if (!account) return { duplicate: false, lapsed: [] };
  const others = logins.state.accounts.filter((x) => x.id !== id);
  const signedIn = [{ id: DEFAULT_ID, loggedIn: logins.defaultInfo.loggedIn }, ...others].filter((x) => x.loggedIn);
  return {
    duplicate: signedIn.some((x) => serverIdOf(logins, x.id) === account),
    lapsed: others.filter((x) => !x.loggedIn && (serverIdOf(logins, x.id) ?? x.addedAs?.accountUuid) === account),
  };
}

/**
 * The .claude.json a login's cached plan is read from: its own config only while that names the account the server
 * named, or last named (this CLI's profile answer carries no plan tier), else MoPilot's folder for it.
 * @param {Logins} logins @param {string} id @param {any} own its own config, already read
 */
function planFile(logins, id, own = readConfigFile(logins.configFile(id))) {
  const reader = logins.identity(id);
  if (!reader) return logins.configFile(id);
  const { read, who } = reader.last;
  const account = id === DEFAULT_ID ? (read === 'ok' ? who : logins.state.defaultAccount)?.accountUuid : serverIdOf(logins, id);
  return !account || identityOf(own)?.accountUuid === account ? logins.configFile(id) : reader.file;
}

/**
 * The .claude.json a login's cached plan and usage are read from: its own config, or MoPilot's folder for it. Its
 * usage cache is MoPilot's folder once a read ran there; its plan, planFile.
 * @param {Logins} logins @param {string} id @param {'plan' | 'usage'} what
 */
function loginFile(logins, id, what) {
  const reader = logins.identity(id);
  if (what === 'plan') return planFile(logins, id);
  return reader?.reached ? reader.file : logins.configFile(id);
}

/**
 * The login fields a login's config caches (plan tier, org), never tokens, read once in the usual case.
 * @param {Logins} logins @param {string} id
 */
function loginPlan(logins, id) {
  const ownFile = logins.configFile(id);
  const own = readConfigFile(ownFile);
  const file = planFile(logins, id, own);
  const a = (file === ownFile ? own : readConfigFile(file))?.oauthAccount;
  if (!a) return null;
  return {
    email: a.emailAddress ?? null,
    organizationType: a.organizationType ?? null,
    rateLimitTier: a.organizationRateLimitTier ?? a.userRateLimitTier ?? null,
  };
}

/**
 * When the CLI last fetched this login's plan usage (ms), or null when its config doesn't say. When the usage endpoint
 * refuses (a 429 it remembers for minutes), /usage answers from that cache, so its text is only as new as this.
 * @param {Logins} logins @param {string} id
 */
function usageFetchedAt(logins, id) {
  const t = readConfigFile(loginFile(logins, id, 'usage'))?.cachedUsageUtilization?.fetchedAtMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.min(t, clock.now()) : null;
}

module.exports = {
  LoginIdentity,
  identityOf,
  cliLogin,
  cliLoginOf,
  readerOf,
  forgetAdded,
  adoptAddedAs,
  retireAdded,
  reloginAdded,
  signInRepeats,
  loginRow,
  loginEmail,
  loginFile,
  loginPlan,
  usageFetchedAt,
  serverIdOf,
};
