// Which account an added Claude Code login is (#1582 item 6): its own folder can name one account while its token is
// another's, and the CLI never corrects that name (a token refresh marks it freshly fetched). So an added login is
// the server's answer for its token, read in a folder MoPilot owns (electron/harness/claude/loginIdentity.cjs), and the row
// says when that is another account than the one it was added as. The CLI is faked; the accounts are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { type Fetched, fetchedNow } from './support/claudeFetchedProfile.ts';
import { claudeAccountsWorld, flush, profile } from './support/claude-accounts-kit.ts';

const world = claudeAccountsWorld('sage-claude-added-identity-');
const { nextUserData } = world;
const req = createRequire(import.meta.url);
const { serverIdOf, loginFile, loginEmail } = req('../electron/harness/claude/loginIdentity.cjs');
const { loginAccounts } = req('../electron/harness/claude/usageSchedule.cjs');

const ON = { loggedIn: true, email: null, subscriptionType: null, authMethod: null };
/** ClaudeAccounts on `state` whose own CLI login is signed in. */
function make(state: object, status?: (id: string) => object, userData?: string) {
  const r = world.make(state, status, userData);
  r.m.takeDefault(ON);
  return r;
}
/** An added login whose own folder names `cfg`'s account. */
function names(userData: string, id: string, cfg: object) {
  const dir = path.join(userData, 'claude-accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cfg));
}
/** Accounts state with added logins whose folders name the given accounts, written before MoPilot starts. */
function start(
  accounts: { id: string; uuid: string; email: string; extra?: object }[],
  extra: object = {},
  status?: (id: string) => object,
) {
  const userData = nextUserData();
  for (const a of accounts) names(userData, a.id, profile(a.uuid, a.email, 1, a.extra));
  return make(
    { active: accounts[0]?.id ?? 'default', accounts: accounts.map((a) => ({ id: a.id, email: a.email, loggedIn: true })), ...extra },
    status,
    userData,
  );
}
/** A usage read of login `id` whose CLI fetched `cfg` (the server's profile for its token) into MoPilot's folder. */
const readAs = (m: any, id: string, cfg: Fetched, text = 'Current session: 5% used') =>
  m.identity(id).read(
    async () => {
      const fetched = fetchedNow(cfg);
      if (fetched) fs.writeFileSync(m.identity(id).file, JSON.stringify(fetched));
      return text;
    },
    async () => 'plain',
  );
const row = (m: any, id: string) => m.view().accounts.find((a: any) => a.id === id);
const MEG = { uuid: 'u-meg', email: 'meg@example.com' };
const DZ = { uuid: 'u-dz', email: 'dz@example.com' };

test("the reported case: an added login's folder names one account and its token is another's", async () => {
  const { m, events } = start([{ id: 'b1', ...MEG }]);
  // the CLI's own login is dz, as the server said
  await m.cliLogin.read(
    async () => (fs.writeFileSync(m.cliLogin.file, JSON.stringify(profile(DZ.uuid, DZ.email, Date.now() + 1))), 'x'),
    async () => 'plain',
  );
  // before its token was read, the folder's name is not taken as the server's word
  assert.equal(serverIdOf(m, 'b1'), null);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], [MEG.email, null]);
  // its token is dz's
  assert.equal(await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1)), 'Current session: 5% used');
  assert.equal(serverIdOf(m, 'b1'), DZ.uuid);
  // one account is one row (#1312): the added login is shown, as the server's account, marked as not the one added
  assert.deepEqual(m.view().same, { default: 'b1' });
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, row(m, 'b1').addedAs], [DZ.email, 'mismatch', MEG.email]);
  // its usage is the verified account's
  assert.equal(loginAccounts(() => m).accountOf('b1'), DZ.uuid);
  assert.deepEqual(loginAccounts(() => m).loginsOf('default'), ['b1', 'default']);
  // the user is told once
  assert.deepEqual(
    events.filter((e) => e.type === 'notice'),
    [{ type: 'notice', kind: 'otherAccount', id: 'b1', email: DZ.email, addedAs: MEG.email }],
  );
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);
});

test("a token refresh during a read marks the folder's old name fetched without naming it again: nothing is learned", async () => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  const reader = m.identity('b1');
  assert.equal(m.identity('b1'), reader, 'one reader per login');
  // an earlier read put the folder's own (wrong) name in MoPilot's folder
  fs.mkdirSync(reader.dir, { recursive: true });
  fs.writeFileSync(reader.file, JSON.stringify(profile(MEG.uuid, MEG.email, 1)));
  reader.waitMs = 5000;
  reader.pollMs = 5;
  const started = Date.now();
  // the CLI refreshed the token: it fetched a profile, merged its plan fields and kept the account uuid (CLI 2.1.302)
  const out = await reader.read(
    async (hold: () => Promise<void>) => {
      const cfg = JSON.parse(fs.readFileSync(reader.file, 'utf8'));
      assert.equal('emailAddress' in cfg.oauthAccount, false, 'the read clears the email only the profile check writes');
      fs.writeFileSync(
        reader.file,
        JSON.stringify({ oauthAccount: { ...cfg.oauthAccount, profileFetchedAt: Date.now() + 1, seatTier: 'x' } }),
      );
      // no profile is coming at this start: the hold does not wait it out
      await hold();
      return 'Current session: 5% used';
    },
    async () => assert.fail('the folder reached the login'),
  );
  assert.equal(out, 'Current session: 5% used');
  assert.ok(Date.now() - started < 5000);
  // not taken as the server naming meg, and not a failed read either
  assert.deepEqual(reader.last, { read: 'pending', who: null });
  assert.equal(serverIdOf(m, 'b1'), null);
  // the reading came from MoPilot's folder all the same
  assert.equal(loginFile(m, 'b1', 'usage'), reader.file);
  // a read that fails after a refresh reaches the caller and learns nothing either
  await assert.rejects(
    reader.read(
      async () => {
        const cfg = JSON.parse(fs.readFileSync(reader.file, 'utf8'));
        fs.writeFileSync(reader.file, JSON.stringify({ oauthAccount: { ...cfg.oauthAccount, profileFetchedAt: Date.now() + 1 } }));
        throw new Error('usage endpoint 429');
      },
      async () => assert.fail('the folder reached the login'),
    ),
    /429/,
  );
  assert.equal(reader.last.read, 'pending');
  // the next read has a fresh token, so the CLI's profile check runs and names the token's account
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.deepEqual(reader.last, { read: 'ok', who: { accountUuid: DZ.uuid, email: DZ.email } });
});

test('signing an added login in again forgets its account until a read names it, and warns when it is another one', async () => {
  const { m, events } = start([{ id: 'b1', ...MEG }]);
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, 'addedAs' in row(m, 'b1')], [MEG.email, 'verified', false]);
  const changed = events.length;
  // the user signs it in again; the browser is signed in to claude.ai as dz
  const cmd = m.reloginCommand('claude', 'b1');
  assert.equal(cmd.at(-1), 'login');
  assert.ok(events.length > changed, 'the windows are told it is no longer confirmed');
  assert.equal(serverIdOf(m, 'b1'), null);
  assert.equal(m.identity('b1').last.read, 'failed');
  // the CLI's login wrote dz into the folder: the row does not take that as the server's word, nor fold it
  names(m.userData, 'b1', profile(DZ.uuid, DZ.email, Date.now()));
  m.state.accounts[0].email = DZ.email;
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], [DZ.email, 'unverified']);
  // the next read names dz: another account than it was added as
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.deepEqual([row(m, 'b1').identity, row(m, 'b1').addedAs], ['mismatch', MEG.email]);
  assert.deepEqual(events.filter((e) => e.type === 'notice').at(-1), {
    type: 'notice',
    kind: 'otherAccount',
    id: 'b1',
    email: DZ.email,
    addedAs: MEG.email,
  });
  // the answer and the account it was added as are kept for the next start
  const saved = JSON.parse(fs.readFileSync(m.file, 'utf8')).accounts[0];
  assert.deepEqual(
    [saved.serverAccount, saved.addedAs],
    [
      { accountUuid: DZ.uuid, email: DZ.email },
      { accountUuid: MEG.uuid, email: MEG.email },
    ],
  );
  // signed in again as meg: confirmed, and nothing to warn about
  const notices = events.filter((e) => e.type === 'notice').length;
  m.reloginCommand('claude', 'b1');
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], [MEG.email, 'verified']);
  assert.equal(events.filter((e) => e.type === 'notice').length, notices);
});

test("a login's last answer stands across a restart until it is signed in again or out", async () => {
  const saved = { accountUuid: DZ.uuid, email: DZ.email };
  const { m } = start([{ id: 'b1', ...MEG }], { accounts: [{ id: 'b1', email: MEG.email, loggedIn: true, serverAccount: saved }] });
  assert.equal(serverIdOf(m, 'b1'), DZ.uuid);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, row(m, 'b1').addedAs], [DZ.email, 'mismatch', MEG.email]);
  // a failed read keeps it (the token did not change)
  await assert.rejects(
    m.identity('b1').read(
      async () => {
        throw new Error('offline');
      },
      async () => {
        throw new Error('still offline');
      },
    ),
  );
  assert.equal(serverIdOf(m, 'b1'), DZ.uuid);
  // signed out: no answer stands for whoever signs it in next
  m.takeAccount(m.state.accounts[0], { loggedIn: false });
  assert.equal(serverIdOf(m, 'b1'), null);
  assert.equal(m.state.accounts[0].serverAccount, undefined);
  // still signed out on the next read of its status: nothing more to forget
  m.takeAccount(m.state.accounts[0], { loggedIn: false });
  assert.equal(m.state.accounts[0].addedAs.accountUuid, MEG.uuid);
});

test('a login added before MoPilot kept which account it was added as takes it from its folder, else from the first answer', async () => {
  // its folder could not be read when MoPilot started
  const userData = nextUserData();
  fs.mkdirSync(path.join(userData, 'claude-accounts', 'b1'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'claude-accounts', 'b1', '.claude.json'), '{ half written');
  const { m, events } = make({ active: 'b1', accounts: [{ id: 'b1', email: MEG.email, loggedIn: true }] }, undefined, userData);
  assert.equal(m.state.accounts[0].addedAs, undefined);
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  // the first answer is the account it is: nothing to warn about
  assert.deepEqual(m.state.accounts[0].addedAs, { accountUuid: DZ.uuid, email: DZ.email });
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], [DZ.email, 'verified']);
  assert.equal(events.filter((e) => e.type === 'notice').length, 0);
  // a read that names no profile (the CLI never fetched one) teaches nothing about it
  await readAs(m, 'b1', profile(DZ.uuid, DZ.email));
  assert.deepEqual(m.state.accounts[0].serverAccount, { accountUuid: DZ.uuid, email: DZ.email });
});

test("an added login's plan comes from its own folder only while that names the account its token is", async () => {
  const { m } = start([{ id: 'b1', ...MEG, extra: { organizationType: 'claude_max', organizationRateLimitTier: 't20' } }]);
  const own = path.join(m.dir('b1'), '.claude.json');
  // nothing known yet: its folder, as before
  assert.deepEqual([loginFile(m, 'b1', 'plan'), loginFile(m, 'b1', 'usage')], [own, own]);
  assert.equal(row(m, 'b1').rateLimitTier, 't20');
  // its token is meg's: the folder's plan is its own
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.deepEqual([loginFile(m, 'b1', 'plan'), loginFile(m, 'b1', 'usage')], [own, m.identity('b1').file]);
  // its token is dz's: the folder's plan is meg's, so it is not shown for this login
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(loginFile(m, 'b1', 'plan'), m.identity('b1').file);
  assert.equal(row(m, 'b1').rateLimitTier, null);
  // a key's folder and an unknown login have no reader: their own config, as before
  assert.equal(m.identity('key-apiKey'), null);
  assert.equal(loginFile(m, 'gone', 'plan'), path.join(m.root, 'gone', '.claude.json'));
});

test("removing an added login forgets its reader and deletes MoPilot's folder for it", async (t) => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  const dir = m.identity('b1').dir;
  assert.ok(fs.existsSync(dir));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  m.remove(undefined, 'b1');
  assert.equal(m.identity('b1'), null);
  // once the reads that started there are done
  await flush();
  t.mock.timers.tick(0);
  assert.equal(fs.existsSync(dir), false);
});

test('a new sign-in names the account it was added as and is, from what its sign-in wrote; a folder naming none names neither', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make({ active: 'default', accounts: [] }, () => ({ loggedIn: true, email: MEG.email }));
  const r = m.startLogin('claude');
  fs.writeFileSync(path.join(m.root, r.id, '.claude.json'), JSON.stringify(profile(MEG.uuid, MEG.email, Date.now())));
  t.mock.timers.tick(3000);
  await flush();
  const a = m.state.accounts.find((x: any) => x.id === r.id);
  assert.deepEqual(
    [a.addedAs, a.serverAccount],
    [
      { accountUuid: MEG.uuid, email: MEG.email },
      { accountUuid: MEG.uuid, email: MEG.email },
    ],
  );
  assert.equal(serverIdOf(m, r.id), MEG.uuid);
  const none = make({ active: 'default', accounts: [] }, () => ({ loggedIn: true, email: MEG.email }));
  const r2 = none.m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  const b = none.m.state.accounts.find((x: any) => x.id === r2.id);
  assert.deepEqual([b.addedAs, b.serverAccount], [undefined, undefined]);
});

test('a read that began before a sign-in again learns nothing of the login after it, on either kind of login', async () => {
  const { m, events } = start([{ id: 'b1', ...MEG }]);
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  await readAs(m, 'default', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  for (const id of ['b1', 'default']) {
    const reader = m.identity(id);
    let release = () => {};
    const late = reader.read(
      async () => {
        await new Promise<void>((r) => (release = r));
        // the profile of the token it began with
        fs.writeFileSync(reader.file, JSON.stringify(profile(DZ.uuid, DZ.email, Date.now() + 1)));
        return 'old figures';
      },
      async () => 'plain',
    );
    await flush();
    m.reloginCommand('claude', id);
    const notices = events.filter((e) => e.type === 'notice').length;
    release();
    assert.equal(await late, 'old figures');
    assert.equal(reader.last.read, 'failed', id);
    assert.equal(serverIdOf(m, id), null, id);
    assert.equal(events.filter((e) => e.type === 'notice').length, notices, id);
    // a plain read that began before it learns nothing either
    const plain = reader.read(
      async () => {
        m.reloginCommand('claude', id);
        throw new Error('Not logged in');
      },
      async () => 'plain',
    );
    fs.rmSync(reader.file, { force: true });
    assert.equal(await plain, 'plain');
    assert.equal(reader.last.read, 'failed', id);
    // the next read answers for the new sign-in
    await readAs(m, id, () => profile(MEG.uuid, MEG.email, Date.now() + 1));
    assert.equal(serverIdOf(m, id), MEG.uuid, id);
  }
});

test('the user is told once per other account, not again by a read while a sign-in again is still open', async () => {
  const { m, events } = start([{ id: 'b1', ...MEG }]);
  const told = () => events.filter((e) => e.type === 'notice').length;
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(told(), 1);
  // the user signs it in again; a read before the browser sign-in finished still answers for dz's token
  m.reloginCommand('claude', 'b1');
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(told(), 1);
  assert.equal(row(m, 'b1').identity, 'mismatch', 'the row still says so');
  // signed in as meg: confirmed; a later sign-in as dz again is told again
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.equal(m.state.accounts[0].warned, undefined);
  m.reloginCommand('claude', 'b1');
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(told(), 2);
  // a third account is told too
  await readAs(m, 'b1', () => profile('u-third', 'third@example.com', Date.now() + 1));
  assert.equal(told(), 3);
  // reads of a login removed meanwhile record nothing on it
  const reader = m.identity('b1');
  m.state.accounts = [];
  await readAs({ identity: () => reader }, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(told(), 3);
});

test("a removed login's folder goes after the reads already started there", async () => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  const reader = m.identity('b1');
  let release = () => {};
  const running = reader.read(
    async () => {
      await new Promise<void>((r) => (release = r));
      fs.writeFileSync(reader.file, JSON.stringify(profile(MEG.uuid, MEG.email, Date.now() + 1)));
      return 'x';
    },
    async () => 'plain',
  );
  await flush();
  m.remove(undefined, 'b1');
  await flush();
  assert.ok(fs.existsSync(reader.dir), 'not while a read runs there');
  release();
  await running;
  const end = performance.now() + 2000;
  while (fs.existsSync(reader.dir) && performance.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(fs.existsSync(reader.dir), false);
  // a login never read has no reader: its folder goes at once
  const other = start([{ id: 'b2', ...MEG }]);
  fs.mkdirSync(path.join(other.userData, 'claude-login-check', 'b2'), { recursive: true });
  other.m.remove(undefined, 'b2');
  const end2 = performance.now() + 2000;
  while (fs.existsSync(path.join(other.userData, 'claude-login-check', 'b2')) && performance.now() < end2)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(fs.existsSync(path.join(other.userData, 'claude-login-check', 'b2')), false);
});

test("a read that falls back to the login's own folder dates its figures by that folder, not MoPilot's", async () => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  const reader = m.identity('b1');
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.equal(loginFile(m, 'b1', 'usage'), reader.file);
  // the folder no longer reaches the login (it names nothing and the CLI fails there): the plain read answers
  fs.rmSync(reader.file);
  assert.equal(
    await reader.read(
      async () => {
        fs.rmSync(reader.file, { force: true });
        throw new Error('Not logged in');
      },
      async () => 'plain',
    ),
    'plain',
  );
  assert.equal(loginFile(m, 'b1', 'usage'), path.join(m.dir('b1'), '.claude.json'));
});

test('edges: a server answer without an email, an added account without one, an unknown login, a kept account', async () => {
  // a login whose record already says which account it was added as keeps it, whatever its folder names now
  const kept = { accountUuid: MEG.uuid, email: null };
  const { m } = start([{ id: 'b1', ...DZ }], { accounts: [{ id: 'b1', email: 'b1@example.com', loggedIn: true, addedAs: kept }] });
  assert.deepEqual(m.state.accounts[0].addedAs, kept);
  m.state.accounts[0].serverAccount = { accountUuid: DZ.uuid, email: null };
  // no email from the server: the login's own; no email for the added account: none named
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, 'addedAs' in row(m, 'b1')], ['b1@example.com', 'mismatch', false]);
  assert.equal(loginEmail(m, 'gone'), null);
  // signing in again a login MoPilot does not hold forgets nothing
  const events = m.state.accounts.map((x: any) => ({ ...x }));
  assert.equal(m.reloginCommand('claude', 'gone').at(-1), 'login');
  assert.deepEqual(m.state.accounts, events);
  assert.equal(loginEmail(m, 'b1'), 'b1@example.com');
  // nor its own: its cached plan's
  m.state.accounts[0].email = null;
  assert.equal(row(m, 'b1').email, DZ.email);
});

test('a lapsed login is replaced by a new sign-in of the account the server last named for it, or else it was added as', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make(
    {
      active: 'default',
      accounts: [
        // lapsed while MoPilot was closed: its last answer is kept
        { id: 'old', email: 'x@example.com', loggedIn: false, serverAccount: { accountUuid: MEG.uuid, email: MEG.email }, addedAs: DZ },
        // lapsed, never named
        { id: 'blank', email: 'blank@example.com', loggedIn: false },
      ],
    },
    (id) => (id === 'old' || id === 'blank' ? { loggedIn: false } : { loggedIn: true, email: MEG.email }),
  );
  const r = m.startLogin('claude');
  fs.writeFileSync(path.join(m.root, r.id, '.claude.json'), JSON.stringify(profile(MEG.uuid, MEG.email, Date.now())));
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(m.state.accounts.map((a: any) => a.id).sort(), ['blank', r.id].sort());
});

test('an added login the server cannot be asked about keeps its label but is unverified; an answer clears it', async () => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  const reader = m.identity('b1');
  const offline = () =>
    reader.read(
      async () => {
        throw new Error('network is unreachable');
      },
      async () => {
        throw new Error('network is unreachable');
      },
    );
  // never answered: the cached label stands, unverified (no server account is claimed for it)
  await assert.rejects(offline(), /unreachable/);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, row(m, 'b1').serverId], [MEG.email, 'unverified', null]);
  // answered as its own account: verified
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity], [MEG.email, 'verified']);
  // the next read reaches the CLI but no profile comes back: the last answer stays shown, unverified
  await readAs(m, 'b1', null);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, row(m, 'b1').serverId], [MEG.email, 'unverified', MEG.uuid]);
  // and an answer again clears it
  await readAs(m, 'b1', () => profile(MEG.uuid, MEG.email, Date.now() + 1));
  assert.equal(row(m, 'b1').identity, 'verified');
});

test('a login the server last named as another account stays a mismatch when the next read fails', async () => {
  const { m } = start([{ id: 'b1', ...MEG }]);
  await readAs(m, 'b1', () => profile(DZ.uuid, DZ.email, Date.now() + 1));
  assert.equal(row(m, 'b1').identity, 'mismatch');
  await readAs(m, 'b1', null);
  assert.deepEqual([row(m, 'b1').email, row(m, 'b1').identity, row(m, 'b1').addedAs], [DZ.email, 'mismatch', MEG.email]);
});
