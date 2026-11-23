// Which account the Claude Code CLI's own login is (electron/harness/claude/loginIdentity.cjs): ~/.claude.json is shared with
// other clients (Claude Desktop), so the login is named by the profile the server returns for its token, read in a
// folder MoPilot owns. The CLI is faked; every path is under a temp dir and the accounts are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { type Fetched, fetchedNow } from './support/claudeFetchedProfile.ts';
import { claudeAccountsWorld, flush, profile } from './support/claude-accounts-kit.ts';

const { tmp, shared, make } = claudeAccountsWorld('sage-claude-identity-');
const req = createRequire(import.meta.url);
const { LoginIdentity: CliLoginIdentity, identityOf, loginFile } = req('../electron/harness/claude/loginIdentity.cjs');
const { recentIgnored, clearIgnored } = req('../electron/ignored.cjs');

const writeShared = (cfg: object) => fs.writeFileSync(path.join(shared, '.claude.json'), JSON.stringify(cfg));
let n = 0;
/** An added login whose folder names `cfg`'s account, as the CLI writes it when that login signs in. */
function added(m: any, id: string, cfg: object) {
  fs.mkdirSync(m.dir(id), { recursive: true });
  fs.writeFileSync(path.join(m.dir(id), '.claude.json'), JSON.stringify(cfg));
}
const row = (m: any, id = 'default') => m.view().accounts.find((a: any) => a.id === id);
/** A usage read of the CLI's own login whose CLI fetched `cfg` (a profile) into MoPilot's folder. */
const readAs = (m: any, cfg: Fetched, text = 'Current session: 5% used') =>
  m.cliLogin.read(
    async () => {
      const fetched = fetchedNow(cfg);
      if (fetched) fs.writeFileSync(m.cliLogin.file, JSON.stringify(fetched));
      return text;
    },
    async () => 'plain',
  );
const folder = (id: string) => {
  const dir = path.join(tmp, `cli-${id}-${n++}`);
  return new CliLoginIdentity(dir, { waitMs: 0 });
};

test('a config names an account only with its uuid; email and fetch time are optional', () => {
  assert.equal(identityOf(null), null);
  assert.equal(identityOf({}), null);
  assert.equal(identityOf({ oauthAccount: { accountUuid: '' } }), null);
  assert.equal(identityOf({ oauthAccount: { accountUuid: 7 } }), null);
  assert.deepEqual(identityOf({ oauthAccount: { accountUuid: 'u1', emailAddress: 3, profileFetchedAt: Number.NaN } }), {
    accountUuid: 'u1',
    email: null,
    fetchedAt: null,
  });
  assert.deepEqual(identityOf(profile('u1', 'a@example.com', 42)), { accountUuid: 'u1', email: 'a@example.com', fetchedAt: 42 });
});

test("the folder runs the CLI on the login's own credential store, whatever folder that login uses", () => {
  const c = folder('env');
  assert.deepEqual(c.env({}), { CLAUDE_CONFIG_DIR: c.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
  assert.deepEqual(c.env({ CLAUDE_CONFIG_DIR: '/home/x/.claude-alt' }), {
    CLAUDE_CONFIG_DIR: c.dir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/x/.claude-alt',
  });
  assert.equal(c.env({ CLAUDE_CONFIG_DIR: '/a', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/b' }).CLAUDE_SECURESTORAGE_CONFIG_DIR, '/b');
});

test("each read marks the folder's profile stale, keeps its account and cache, and takes only a profile fetched since it began", async () => {
  const c = folder('stale');
  fs.mkdirSync(c.dir, { recursive: true });
  const cache = { fetchedAtMs: 5, accountUuid: 'u-old' };
  fs.writeFileSync(
    c.file,
    JSON.stringify({ ...profile('u-old', 'old@example.com', Date.now(), { seatTier: 'x' }), cachedUsageUtilization: cache }),
  );
  let seen: any;
  await c.read(
    async () => {
      seen = JSON.parse(fs.readFileSync(c.file, 'utf8'));
      // a profile from before this read (another read's) is not this token's answer
      fs.writeFileSync(c.file, JSON.stringify(profile('u-old', 'old@example.com', 1)));
      return 'x';
    },
    async () => 'plain',
  );
  // the CLI refetches a profile older than a day; its cache for that account still answers a refused /usage. The email
  // goes: only that refetch writes it back (a token refresh marks the profile fetched and keeps the account)
  assert.deepEqual(seen, {
    oauthAccount: { accountUuid: 'u-old', profileFetchedAt: 0, seatTier: 'x' },
    cachedUsageUtilization: cache,
    hasCompletedOnboarding: true,
  });
  assert.deepEqual(c.last, { read: 'failed', who: null }, 'it reached the login (it names an account) but fetched no profile');
});

test("a token that turned out to be another account is read again, so its figures are not the old account's cache", async () => {
  const c = folder('switched');
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(c.file, JSON.stringify(profile('u-old', 'old@example.com', 1)));
  const runs: string[] = [];
  const out = await c.read(
    async () => {
      runs.push(JSON.parse(fs.readFileSync(c.file, 'utf8')).oauthAccount.accountUuid);
      if (runs.length === 1) fs.writeFileSync(c.file, JSON.stringify(profile('u-new', 'new@example.com', Date.now() + 1)));
      return `reading ${runs.length}`;
    },
    async () => 'plain',
  );
  assert.equal(out, 'reading 2');
  assert.deepEqual(runs, ['u-old', 'u-new']);
  assert.deepEqual(c.last.who, { accountUuid: 'u-new', email: 'new@example.com' });
  // the same account again is read once
  runs.length = 0;
  assert.equal(
    await c.read(
      async () => {
        runs.push('again');
        fs.writeFileSync(c.file, JSON.stringify(profile('u-new', 'new@example.com', Date.now() + 1)));
        return 'once';
      },
      async () => 'plain',
    ),
    'once',
  );
  assert.deepEqual(runs, ['again']);
});

// The reported case: Claude Desktop wrote its own account into ~/.claude.json, so the keychain login (another
// account) was shown as the account the user had just added.
test('two logins with the same local email but different server identities each show their own account', async () => {
  writeShared(profile('u-dz', 'dz@example.com', 1));
  const { m, events } = make({ active: 'default', accounts: [{ id: 'b1', email: 'dz@example.com', loggedIn: true }] });
  added(m, 'b1', profile('u-dz', 'dz@example.com', 1));
  m.defaultInfo = { loggedIn: true, email: 'dz@example.com', subscriptionType: 'max', authMethod: 'claude.ai' };
  // before any answer the shared name is doubted: an added login already is that account
  assert.deepEqual([row(m).email, row(m).identity], ['dz@example.com', 'unverified']);
  assert.equal(
    await readAs(m, () =>
      profile('u-mg', 'mg@example.com', Date.now() + 1, { organizationType: 'claude_max', organizationRateLimitTier: 't20' }),
    ),
    'Current session: 5% used',
  );
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', 'verified']);
  // its plan comes from the same answer, not from the shared config
  assert.deepEqual([row(m).organizationType, row(m).rateLimitTier], ['claude_max', 't20']);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], ['dz@example.com', null]);
  // the answer is kept for the next start, and the windows were told
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')).defaultAccount, { accountUuid: 'u-mg', email: 'mg@example.com' });
  assert.equal(events.filter((e) => e.type === 'changed').length, 1);
  // the same answer again changes nothing, so nothing is broadcast
  await readAs(m, () => profile('u-mg', 'mg@example.com', Date.now() + 1));
  assert.equal(events.filter((e) => e.type === 'changed').length, 1);
});

test('another client renaming ~/.claude.json after an answer does not rename the CLI login', async () => {
  writeShared(profile('u-mg', 'mg@example.com', 1));
  const { m } = make({ active: 'default', accounts: [] });
  await readAs(m, () => profile('u-mg', 'mg@example.com', Date.now() + 1));
  writeShared(profile('u-dz', 'dz@example.com', Date.now() + 2));
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', 'verified']);
  // its usage cache is MoPilot's folder; its plan is not taken from a config naming another account
  assert.equal(loginFile(m, 'default', 'usage'), m.cliLogin.file);
  assert.equal(loginFile(m, 'default', 'plan'), m.cliLogin.file);
  // a shared config naming the same account has the plan tier this CLI's profile answer lacks
  writeShared(profile('u-mg', 'mg@example.com', 3, { organizationType: 'claude_max', organizationRateLimitTier: 't20' }));
  assert.equal(loginFile(m, 'default', 'plan'), path.join(shared, '.claude.json'));
  assert.deepEqual([row(m).rateLimitTier, row(m).email], ['t20', 'mg@example.com']);
  assert.equal(loginFile(m, 'b1', 'usage'), path.join(m.dir('b1'), '.claude.json'));
});

test('a server read that fails keeps the last known identity and marks it unverified', async () => {
  writeShared(profile('u-dz', 'dz@example.com', 1));
  const { m } = make({ active: 'default', defaultAccount: { accountUuid: 'u-mg', email: 'mg@example.com' }, accounts: [] });
  // before this run's first answer the last one is shown as it is
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', null]);
  // the folder read and the plain one both fail: the reading's error reaches the caller
  await assert.rejects(
    m.cliLogin.read(
      async () => {
        throw new Error('offline');
      },
      async () => {
        throw new Error('still offline');
      },
    ),
    /still offline/,
  );
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', 'unverified']);
  // the CLI read usage and named its credentials' account, but its profile fetch never landed
  await readAs(m, () => profile('u-mg', 'mg@example.com'));
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', 'unverified']);
  // the reading came from the folder's cache all the same
  assert.equal(loginFile(m, 'default', 'usage'), m.cliLogin.file);
  // the shared config names another account than the last answer: its plan is not this login's
  assert.equal(loginFile(m, 'default', 'plan'), m.cliLogin.file);
  writeShared(profile('u-mg', 'mg@example.com', 1));
  assert.equal(loginFile(m, 'default', 'plan'), path.join(shared, '.claude.json'));
  assert.deepEqual(m.state.defaultAccount, { accountUuid: 'u-mg', email: 'mg@example.com' });
  // the next answer clears the mark
  await readAs(m, () => profile('u-mg', 'mg@example.com', Date.now() + 1));
  assert.deepEqual([row(m).email, row(m).identity], ['mg@example.com', 'verified']);
});

test('with no answer ever, a failed read doubts the shared name', async () => {
  writeShared(profile('u-dz', 'dz@example.com', 1));
  const { m } = make({ active: 'default', accounts: [] });
  assert.deepEqual([row(m).email, row(m).identity], ['dz@example.com', null]);
  // nothing to check the shared config against: its plan stands
  assert.equal(loginFile(m, 'default', 'plan'), path.join(shared, '.claude.json'));
  await readAs(m, () => profile('u-dz', 'dz@example.com'));
  assert.deepEqual([row(m).email, row(m).identity], ['dz@example.com', 'unverified']);
});

test('a reading that fails after the profile landed still names the login, and its error reaches the caller', async () => {
  const c = folder('late-fail');
  await assert.rejects(
    c.read(
      async () => {
        fs.writeFileSync(c.file, JSON.stringify(profile('u-mg', 'mg@example.com', Date.now() + 1)));
        throw new Error('usage endpoint 429');
      },
      async () => assert.fail('the folder reached the login: no plain read'),
    ),
    /usage endpoint 429/,
  );
  assert.deepEqual(c.last, { read: 'ok', who: { accountUuid: 'u-mg', email: 'mg@example.com' } });
});

test('a folder that reached the login before is not read the old way when a read fails there', async () => {
  const c = folder('reached');
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(c.file, JSON.stringify(profile('u-a', 'a@example.com', 1)));
  await assert.rejects(
    c.read(
      async () => {
        throw new Error('Timed out reading Claude Code usage');
      },
      async () => assert.fail("the shared config's cache may be another account's"),
    ),
    /Timed out/,
  );
  assert.deepEqual(c.last, { read: 'failed', who: null });
});

test('an older CLI that cannot reach the login in the folder reads it the old way, and the shared name stands', async () => {
  const c = folder('old-cli');
  clearIgnored();
  // it fails there (signed out in that folder): the plain read answers
  assert.equal(
    await c.read(
      async () => {
        throw new Error('Not logged in');
      },
      async () => 'plain text',
    ),
    'plain text',
  );
  assert.deepEqual(c.last, { read: 'pending', who: null });
  assert.ok(recentIgnored().some((e: any) => e.context === "read the Claude Code CLI login in MoPilot's folder"));
  // it answers there without naming any account
  assert.equal(
    await c.read(
      async () => 'Not logged in',
      async () => 'plain again',
    ),
    'plain again',
  );
  assert.deepEqual(c.last, { read: 'pending', who: null });
  // a folder that cannot be written reads the old way too
  const blocked = new CliLoginIdentity(path.join(tmp, 'a-file'), { waitMs: 0 });
  fs.writeFileSync(blocked.dir, 'not a folder');
  assert.equal(
    await blocked.read(
      async () => assert.fail('no folder to run in'),
      async () => 'plain',
    ),
    'plain',
  );
});

test('reads take turns, so a read never marks stale the profile another is waiting for', async () => {
  const c = folder('turns');
  const order: string[] = [];
  let release = () => {};
  const first = c.read(
    async () => {
      order.push('first starts');
      await new Promise<void>((r) => (release = r));
      fs.writeFileSync(c.file, JSON.stringify(profile('u-a', 'a@example.com', Date.now() + 1)));
      order.push('first ends');
      return 'a';
    },
    async () => 'plain',
  );
  const second = c.read(
    async () => {
      order.push('second starts');
      fs.writeFileSync(c.file, JSON.stringify(profile('u-a', 'a2@example.com', Date.now() + 1)));
      return 'b';
    },
    async () => 'plain',
  );
  await flush();
  assert.deepEqual(order, ['first starts']);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(order, ['first starts', 'first ends', 'second starts']);
  // a folder the reads made is the user's alone
  assert.equal((fs.statSync(c.dir).mode & 0o777).toString(8), '700');
  assert.deepEqual(c.last.who, { accountUuid: 'u-a', email: 'a2@example.com' });
  // a failed read does not stop the next one; the folder reached the login before, so a read without a profile failed
  await assert.rejects(
    c.read(
      async () => {
        throw new Error('x');
      },
      async () => {
        throw new Error('y');
      },
    ),
  );
  assert.equal(
    await c.read(
      async () => 'z',
      async () => 'plain z',
    ),
    'z',
  );
  assert.equal(c.last.read, 'failed');
});

test('the hold before the CLI closes waits for the profile it is fetching, and gives up after the wait', async () => {
  const c = new CliLoginIdentity(path.join(tmp, `hold-${n++}`), { waitMs: 200, pollMs: 5 });
  await c.read(
    async (hold: () => Promise<void>) => {
      setTimeout(() => fs.writeFileSync(c.file, JSON.stringify(profile('u-a', 'a@example.com', Date.now() + 1))), 20);
      await hold();
      return 'a';
    },
    async () => 'plain',
  );
  assert.deepEqual(c.last, { read: 'ok', who: { accountUuid: 'u-a', email: 'a@example.com' } });
  const started = Date.now();
  await c.read(
    async (hold: () => Promise<void>) => {
      fs.writeFileSync(c.file, JSON.stringify(profile('u-a', 'a@example.com')));
      await hold();
      return 'b';
    },
    async () => 'plain',
  );
  assert.ok(Date.now() - started >= 200);
  assert.equal(c.last.read, 'failed');
});

test('an added login is a duplicate of the CLI login only when the server said which account that is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // the CLI login's config names dz, but no answer said so: signing dz in is not refused
  writeShared(profile('u-dz', 'dz@example.com', 1));
  const doubted = make({ active: 'default', accounts: [] }, () => ({ loggedIn: true, email: 'dz@example.com' }));
  const r = doubted.m.startLogin('claude');
  // the new login's own folder names the account its token was issued to
  const signIn = (m: any, id: string) =>
    fs.writeFileSync(path.join(m.root, id, '.claude.json'), JSON.stringify(profile('u-dz', 'dz@example.com', 1)));
  signIn(doubted.m, r.id);
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(
    doubted.events.filter((e) => e.type === 'notice').map((e) => e.kind),
    ['signedIn'],
  );
  assert.ok(doubted.m.state.accounts.some((a: any) => a.id === r.id));
  // once the server said it is dz, the same account is refused as already signed in: the new folder goes
  const sure = make({ active: 'default', accounts: [] }, () => ({ loggedIn: true, email: 'dz@example.com' }));
  await readAs(sure.m, () => profile('u-dz', 'dz@example.com', Date.now() + 1));
  const dup = sure.m.startLogin('claude');
  const dir = path.join(sure.m.root, dup.id);
  signIn(sure.m, dup.id);
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(
    sure.events.filter((e) => e.type === 'notice'),
    [{ type: 'notice', kind: 'duplicate', email: 'dz@example.com' }],
  );
  assert.deepEqual(sure.m.state.accounts, []);
  // its own login is signed out, and its folder goes a little later, links first
  assert.ok(sure.runs.some((x) => x.join(' ') === `claude auth logout ${dup.id}`));
  assert.ok(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink());
  t.mock.timers.tick(5000);
  const end = performance.now() + 5000;
  while (fs.existsSync(dir) && performance.now() < end) await new Promise((r) => setImmediate(r));
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(shared, 'projects')));
});

test('signing the CLI login in again, or out, leaves its last account unverified until the next reading', async () => {
  const { m } = make({ active: 'default', accounts: [] });
  // nothing answered yet: nothing to retire
  assert.deepEqual(m.reloginCommand('claude', 'default'), ['claude', 'auth', 'login']);
  assert.equal(m.cliLogin.last.read, 'pending');
  await readAs(m, () => profile('u-a', 'a@example.com', Date.now() + 1));
  assert.deepEqual(m.reloginCommand('claude', 'default'), ['claude', 'auth', 'login']);
  assert.deepEqual([row(m).email, row(m).identity], ['a@example.com', 'unverified']);
  await readAs(m, () => profile('u-a', 'a@example.com', Date.now() + 1));
  assert.equal(row(m).identity, 'verified');
  m.takeDefault({ loggedIn: true, email: null, subscriptionType: null, authMethod: null });
  assert.equal(row(m).identity, 'verified', 'a read that it is still signed in changes nothing');
  m.takeDefault({ loggedIn: false, email: null, subscriptionType: null, authMethod: null });
  assert.deepEqual([row(m).email, row(m).identity], ['a@example.com', 'unverified']);
});

test('a fresh profile is built when the fake CLI writes it, so the read it answers counts it however slow the runner', async () => {
  const { m } = make({ active: 'default', accounts: [] });
  // built before the read, its fetch time can fall before the read's start: refused instead of racing
  const early = profile('u-a', 'a@example.com', Date.now() + 1);
  assert.throws(() => fetchedNow(early), /races its clock/);
  assert.equal(fetchedNow(null), null);
  assert.deepEqual(fetchedNow(profile('u-a', 'a@example.com', 1)), profile('u-a', 'a@example.com', 1));
  // the runner stalls between building the call and the read starting: the thunk's profile still counts
  const read = () => profile('u-a', 'a@example.com', Date.now());
  const end = Date.now() + 5;
  while (Date.now() < end);
  await readAs(m, read);
  assert.deepEqual([row(m).email, row(m).identity], ['a@example.com', 'verified']);
});

test('an unreadable config names no account and is noted; a missing one quietly names none', () => {
  clearIgnored();
  fs.writeFileSync(path.join(shared, '.claude.json'), '{ half written');
  const { m } = make({ active: 'default', accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] });
  assert.equal(row(m).identity, null);
  assert.ok(recentIgnored().some((e: any) => e.context === "read a Claude Code login's account"));
  clearIgnored();
  fs.rmSync(path.join(shared, '.claude.json'));
  assert.deepEqual([row(m).email, row(m).identity], [null, null]);
  assert.equal(recentIgnored().filter((e: any) => e.context === "read a Claude Code login's account").length, 0);
});
