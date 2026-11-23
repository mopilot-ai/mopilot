// Claude account management (electron/harness/claude/accounts.cjs): adding an account through a terminal
// sign-in that is polled until it lands, cancelling, removing and switching accounts, Windows links
// and the config sync's edge cases. The CLI is faked; every path is under a temp dir (data is made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-accts-cov-'));
const shared = path.join(tmp, 'shared');
fs.mkdirSync(shared, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = shared;
const { ClaudeAccounts, merge3, syncable, loginCommand } = createRequire(import.meta.url)('../electron/harness/claude/accounts.cjs');
const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
const ignored = () => recentIgnored().map((e: any) => [e.context, e.message]);

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const until = async (cond: () => boolean) => {
  // fs.rm finishes on the thread pool; Date is faked in some tests, performance isn't
  const end = performance.now() + 5000;
  while (!cond() && performance.now() < end) await new Promise((r) => setImmediate(r));
  assert.ok(cond());
};
let n = 0;
type Status = { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
function make(opts: { state?: object; status?: (id: string) => Status | Promise<Status> | Error; failLogout?: boolean } = {}) {
  const userData = path.join(tmp, `ud-${n++}`);
  if (opts.state) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify(opts.state));
  }
  const events: any[] = [];
  const runs: string[][] = [];
  const run = async (bin: string, args: string[], id: string) => {
    runs.push([bin, ...args, id]);
    if (args[1] === 'logout' && opts.failLogout) throw new Error('network down');
    if (args[1] !== 'status') return '';
    const st = await (opts.status ?? (() => ({ loggedIn: false })))(id);
    if (st instanceof Error) throw st;
    return JSON.stringify(st);
  };
  const m = new ClaudeAccounts({ userData, broadcast: (e: any) => events.push(e), run });
  return { m, events, runs, userData, notices: () => events.filter((e) => e.type === 'notice') };
}

test('saved state drops unfinished sign-ins and an unknown active account', () => {
  const { m } = make({
    state: { active: 'gone', autoSwitch: false, accounts: [{ id: 'e1' }, { id: 'b1', email: 'b@example.com', loggedIn: true }] },
  });
  assert.equal(m.state.active, 'default');
  assert.equal(m.state.autoSwitch, false);
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    ['b1'],
  );
});

test('a terminal sign-in is polled until it lands, then the account is listed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let signedIn = false;
  const { m, notices, events } = make({
    status: (id) =>
      id === 'default'
        ? { loggedIn: true, email: 'me@example.com' }
        : signedIn
          ? { loggedIn: true, email: 'new@example.com', subscriptionType: 'max', authMethod: 'claude.ai' }
          : { loggedIn: false },
  });
  const r = m.startLogin('/bin/claude');
  const dir = path.join(m.root, r.id);
  assert.deepEqual(r.command, loginCommand('/bin/claude', dir));
  assert.ok(fs.existsSync(path.join(dir, '.claude.json')));
  assert.deepEqual(r.state.login, { id: r.id });
  // the half-made record isn't shown while it signs in
  assert.deepEqual(
    r.state.accounts.map((a: any) => a.id),
    ['default'],
  );
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(notices(), []);
  signedIn = true;
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: r.id, email: 'new@example.com' }]);
  const v = m.view();
  assert.equal(v.login, null);
  assert.deepEqual(
    v.accounts.map((a: any) => [a.id, a.email, a.loggedIn]),
    [
      ['default', 'me@example.com', true],
      [r.id, 'new@example.com', true],
    ],
  );
  assert.equal(v.accounts[1].subscriptionType, 'max');
  assert.equal(events.at(-1).type, 'changed');
  // saved for the next start
  assert.equal(JSON.parse(fs.readFileSync(m.file, 'utf8')).accounts[0].email, 'new@example.com');
});

test('a sign-in that never lands is given up after ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { m } = make();
  const r = m.startLogin('claude');
  t.mock.timers.tick(10 * 60_000 + 3000);
  await flush();
  assert.equal(m.pending, null);
  assert.deepEqual(m.state.accounts, []);
  t.mock.timers.tick(0);
  await until(() => !fs.existsSync(path.join(m.root, r.id)));
});

test('a login cancelled while its status is being read is not added', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (s: Status) => void;
  const { m, notices } = make({ status: () => new Promise<Status>((r) => (answer = r)) });
  m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(m.cancelLogin().login, null);
  answer({ loggedIn: true, email: 'late@example.com' });
  await flush();
  assert.deepEqual(notices(), []);
  assert.deepEqual(m.state.accounts, []);
});

for (const action of ['cancel', 'remove', 'replace'] as const) {
  test(`a sign-in retired by ${action} during the default-account read cannot finish`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let answer!: (value: Status) => void;
    const { m, notices } = make({
      status: (id) =>
        id === 'default'
          ? new Promise<Status>((resolve) => {
              answer = resolve;
            })
          : { loggedIn: true, email: 'obsolete@example.com' },
    });
    const first = m.startLogin('claude');
    const before = { ...m.defaultInfo };
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(typeof answer, 'function', 'the candidate status landed and the default read is pending');
    let next: any;
    if (action === 'cancel') m.cancelLogin();
    else if (action === 'remove') m.remove('claude', first.id);
    else next = m.startLogin('claude');
    answer({ loggedIn: true, email: 'default@example.com' });
    await flush();
    assert.deepEqual(notices(), []);
    assert.equal(m.get(first.id), null);
    assert.deepEqual(m.defaultInfo, before, 'the retired validation cannot update shared default status');
    if (next) {
      assert.equal(m.pending?.id, next.id);
      assert.deepEqual(
        m.state.accounts.map((account: any) => account.id),
        [next.id],
      );
      t.mock.timers.tick(3000);
      await flush();
      answer({ loggedIn: false });
      await flush();
      assert.equal(m.pending, null);
      assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: next.id, email: 'obsolete@example.com' }]);
    } else {
      assert.equal(m.pending, null);
      assert.deepEqual(m.state.accounts, []);
    }
  });
}

test('removing a sign-in during its first status read retires the pending poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: Status) => void;
  const { m, notices } = make({
    status: () =>
      new Promise<Status>((resolve) => {
        answer = resolve;
      }),
  });
  const first = m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  m.remove('claude', first.id);
  answer({ loggedIn: false });
  await flush();
  assert.equal(m.pending, null);
  assert.deepEqual(notices(), []);
  assert.deepEqual(m.state.accounts, []);
});

test('removing another account preserves the current sign-in and lets it finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, notices } = make({
    state: { accounts: [{ id: 'old', email: 'old@example.com', loggedIn: true }] },
    status: (id) => (id === 'default' ? { loggedIn: false } : { loggedIn: true, email: 'new@example.com' }),
  });
  const next = m.startLogin('claude');
  m.remove('claude', 'old');
  assert.equal(m.pending?.id, next.id);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(m.pending, null);
  assert.equal(m.get(next.id)?.loggedIn, true);
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: next.id, email: 'new@example.com' }]);
});

test('starting another sign-in replaces the first; cancelling keeps an account that already signed in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make();
  assert.equal(m.cancelLogin().login, null);
  const first = m.startLogin('claude');
  const second = m.startLogin('claude');
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    [second.id],
  );
  assert.notEqual(first.id, second.id);
  m.state.accounts[0].loggedIn = true;
  m.cancelLogin();
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    [second.id],
  );
  // a sign-in whose record was removed meanwhile just ends
  const third = m.startLogin('claude');
  m.remove('claude', third.id);
  assert.equal(m.cancelLogin().login, null);
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    [second.id],
  );
});

test('remove, switch and auto-switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, runs } = make({
    state: {
      active: 'b1',
      accounts: [
        { id: 'b1', email: 'b@example.com', loggedIn: true },
        { id: 'c1', email: 'c@example.com', loggedIn: true },
      ],
    },
  });
  assert.throws(() => m.remove('claude', 'default'), /claude auth logout/);
  assert.throws(() => m.setActive('nope'), /Unknown account/);
  assert.equal(m.setActive('c1').active, 'c1');
  assert.equal(m.setAutoSwitch(0).autoSwitch, false);
  const dir = m.prepare('b1');
  fs.writeFileSync(path.join(dir, 'own.txt'), 'x');
  m.setActive('b1');
  const v = m.remove('claude', 'b1');
  assert.equal(v.active, 'default');
  assert.deepEqual(
    v.accounts.map((a: any) => a.id),
    ['default', 'c1'],
  );
  assert.ok(runs.some((x) => x.join(' ') === 'claude auth logout b1'));
  t.mock.timers.tick(5000);
  await until(() => !fs.existsSync(dir));
  // removing an account that never had a folder is fine too
  m.remove('claude', 'c1');
  t.mock.timers.tick(5000);
  assert.deepEqual(m.state.accounts, []);
});

test('re-signing in: the CLI login in place, an added account in its folder', () => {
  const { m } = make({ state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] } });
  assert.deepEqual(m.reloginCommand('claude', 'default'), ['claude', 'auth', 'login']);
  assert.deepEqual(m.reloginCommand('claude', 'b1'), loginCommand('claude', m.dir('b1')));
});

for (const reply of [
  [],
  {},
  true,
  3,
  'status',
  { loggedIn: 'false' },
  { loggedIn: 1 },
  { loggedIn: null },
  { loggedIn: true, email: {} },
  { loggedIn: true, authMethod: [] },
  { loggedIn: true, subscriptionType: false },
  { loggedIn: true, apiProvider: {} },
]) {
  test(`malformed Claude status preserves a saved account and permits recovery: ${JSON.stringify(reply)}`, async () => {
    const account = { id: 'b1', email: 'kept@example.com', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
    let response: any = reply;
    const { m, userData } = make({ state: { accounts: [account], active: 'b1' }, status: () => response });
    assert.equal(await m.status('claude', 'b1'), null);
    await m.refresh('claude');
    // a record saved before configDir is adopted at its folder (identity/contract/accountDirs.cjs); nothing else changes
    const kept = { ...account, configDir: path.join(userData, 'claude-accounts', 'b1'), unconfirmed: true };
    assert.deepEqual(m.state.accounts, [kept]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'claude-accounts.json'), 'utf8')).accounts, [kept]);
    response = { loggedIn: true, email: 'updated@example.com', authMethod: null, subscriptionType: null, apiProvider: null };
    await m.refresh('claude');
    assert.equal(m.state.accounts[0].email, 'updated@example.com');
  });
}

test("status falls back to the cached plan email; a failing CLI can't say (null), which is recorded", async () => {
  const { m } = make({
    state: { accounts: [{ id: 'b1', email: null, loggedIn: true }] },
    status: (id) => (id === 'b1' ? { loggedIn: true } : new Error('no cli')),
  });
  const dir = m.prepare('b1');
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'cached@example.com', userRateLimitTier: 'tier-2' } }),
  );
  assert.deepEqual(await m.status('claude', 'b1'), {
    loggedIn: true,
    email: 'cached@example.com',
    subscriptionType: null,
    authMethod: null,
  });
  clearIgnored();
  assert.equal(await m.status('claude', 'default'), null);
  assert.deepEqual(ignored(), [['read a Claude Code login', 'no cli']]);
  // the view shows the cached plan for a record without its own email
  const row = m.view().accounts[1];
  assert.deepEqual(
    [row.email, row.rateLimitTier, row.organizationType, row.subscriptionType, row.authMethod],
    ['cached@example.com', 'tier-2', null, null, null],
  );
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
  assert.deepEqual(m.cachedPlan('b1'), { email: null, organizationType: null, rateLimitTier: null });
  assert.equal(m.view().accounts[1].email, null);
});

test('a newer refresh retires an older default read and its remaining account reads', async () => {
  let answer!: (value: Status) => void;
  let defaults = 0;
  let saved = 0;
  const { m } = make({
    state: { accounts: [{ id: 'b1', email: 'saved@example.com', loggedIn: true }] },
    status: (id) => {
      if (id === 'default')
        return ++defaults === 1
          ? new Promise<Status>((resolve) => {
              answer = resolve;
            })
          : { loggedIn: true, email: 'current-default@example.com' };
      ++saved;
      return { loggedIn: saved === 1, email: saved === 1 ? 'current@example.com' : 'obsolete@example.com' };
    },
  });
  const first = m.refresh('claude');
  await flush();
  await m.refresh('claude');
  answer({ loggedIn: false });
  await first;
  assert.equal(m.defaultInfo.email, 'current-default@example.com');
  assert.equal(m.state.accounts[0].email, 'current@example.com');
  assert.equal(saved, 1, 'an obsolete refresh does not start more reads');
});

test('a newer refresh owns saved-account status even when the old read resolves last', async () => {
  let answer!: (value: Status) => void;
  let saved = 0;
  const { m } = make({
    state: { accounts: [{ id: 'b1', email: 'saved@example.com', loggedIn: true }] },
    status: (id) =>
      id === 'default'
        ? { loggedIn: false }
        : ++saved === 1
          ? new Promise<Status>((resolve) => {
              answer = resolve;
            })
          : { loggedIn: true, email: 'current@example.com' },
  });
  const first = m.refresh('claude');
  await flush();
  await m.refresh('claude');
  answer({ loggedIn: false, email: 'obsolete@example.com' });
  await first;
  assert.equal(m.state.accounts[0].email, 'current@example.com');
  assert.equal(m.state.accounts[0].loggedIn, true);
  assert.equal(JSON.parse(fs.readFileSync(m.file, 'utf8')).accounts[0].email, 'current@example.com');
});

test('an older refresh cannot replace the default status committed by a sign-in poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: Status) => void;
  let defaults = 0;
  const { m } = make({
    status: (id) =>
      id !== 'default'
        ? { loggedIn: true, email: 'new@example.com' }
        : ++defaults === 1
          ? new Promise<Status>((resolve) => {
              answer = resolve;
            })
          : { loggedIn: true, email: 'current-default@example.com' },
  });
  const refresh = m.refresh('claude');
  await flush();
  m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  answer({ loggedIn: false });
  await refresh;
  assert.equal(m.defaultInfo.email, 'current-default@example.com');
  assert.equal(m.defaultInfo.loggedIn, true);
});

test('a poll superseded by refresh retries validation without overwriting the newer default status', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: Status) => void;
  let defaults = 0;
  const { m, notices } = make({
    status: (id) =>
      id !== 'default'
        ? { loggedIn: true, email: 'new@example.com' }
        : ++defaults === 1
          ? new Promise<Status>((resolve) => {
              answer = resolve;
            })
          : { loggedIn: true, email: 'current-default@example.com' },
  });
  const login = m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  await m.refresh('claude');
  answer({ loggedIn: false });
  await flush();
  assert.equal(m.defaultInfo.email, 'current-default@example.com');
  assert.equal(m.pending?.id, login.id);
  assert.deepEqual(notices(), []);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(m.pending, null);
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: login.id, email: 'new@example.com' }]);
});

test('refresh re-reads every login but leaves one still signing in alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked: string[] = [];
  const { m } = make({
    state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] },
    status: (id) => (asked.push(id), { loggedIn: id !== 'b1', email: `${id}@example.com` }),
  });
  const { id } = m.startLogin('claude');
  const v = await m.refresh('claude');
  assert.deepEqual(asked, ['default', 'b1']);
  assert.equal(v.accounts.find((a: any) => a.id === 'b1').loggedIn, false);
  assert.ok(!asked.includes(id));
  m.cancelLogin();
});

test("a login the CLI can't read keeps what was known, so the account survives the next start", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cli = true;
  const { m, userData } = make({
    state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true, subscriptionType: 'max' }] },
    status: (id) => (cli ? { loggedIn: true, email: `${id}@example.com` } : new Error('Timed out')),
  });
  await m.refresh('claude');
  assert.equal(m.view().accounts[0].email, 'default@example.com');
  cli = false;
  const v = await m.refresh('claude');
  assert.deepEqual(
    v.accounts.map((a: any) => [a.id, a.email, a.loggedIn]),
    [
      ['default', 'default@example.com', true],
      ['b1', 'b1@example.com', true],
    ],
  );
  // before, a failed read saved the account without its email and login, and the next start dropped it
  const next = new ClaudeAccounts({ userData, broadcast: () => {}, run: async () => '' });
  assert.deepEqual(
    next.state.accounts.map((a: any) => [a.id, a.email]),
    [['b1', 'b1@example.com']],
  );
  // a sign-in in progress whose status can't be read keeps waiting
  const r = m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(m.view().login, { id: r.id });
  cli = true;
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(m.view().login, null);
  assert.ok(m.state.accounts.some((a: any) => a.id === r.id && a.loggedIn));
});

test('signing in keeps the known CLI login when it cannot be read at that moment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cliDown = false;
  const { m } = make({
    status: (id) =>
      id === 'default'
        ? cliDown
          ? new Error('busy')
          : { loggedIn: true, email: 'me@example.com' }
        : { loggedIn: true, email: 'n@example.com' },
  });
  await m.refresh('claude');
  cliDown = true;
  m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(
    m.view().accounts.map((a: any) => [a.email, a.loggedIn]),
    [
      ['me@example.com', true],
      ['n@example.com', true],
    ],
  );
});

test("an account folder whose shared links can't all be removed is left in place, never deleted through a link", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make({ state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] } });
  const dir = m.prepare('b1');
  fs.writeFileSync(path.join(shared, 'keep.txt'), 'shared data');
  m.prepare('b1');
  assert.ok(fs.lstatSync(path.join(dir, 'keep.txt')).isSymbolicLink());
  clearIgnored();
  const unlink = t.mock.method(fs, 'unlinkSync', () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  const rm = t.mock.method(fs, 'rm', () => assert.fail('the folder must not be removed while a link is in it'));
  m.remove(null, 'b1');
  t.mock.timers.tick(0);
  unlink.mock.restore();
  rm.mock.restore();
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'shared data');
  assert.deepEqual(ignored(), [["unlink a removed Claude Code account's shared entries", 'EPERM: operation not permitted']]);
  // a folder already gone is nothing to delete, and nothing to record
  clearIgnored();
  fs.rmSync(dir, { recursive: true, force: true });
  m.state.accounts.push({ id: 'b2', email: 'c@example.com', loggedIn: true });
  m.remove(null, 'b2');
  t.mock.timers.tick(0);
  assert.deepEqual(ignored(), []);
  fs.rmSync(path.join(shared, 'keep.txt'));
});

test('an entry the sign-out removed meanwhile does not keep the account folder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make({ state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] } });
  const dir = m.prepare('b1');
  fs.writeFileSync(path.join(dir, 'leftover'), '');
  clearIgnored();
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p: string, o?: any) => {
    if (p === path.join(dir, 'leftover')) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return lstat(p, o);
  });
  m.remove(null, 'b1');
  t.mock.timers.tick(0);
  await until(() => !fs.existsSync(dir));
  assert.deepEqual(ignored(), []);
});

test('a removed account folder that cannot be deleted is recorded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make({ state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] } });
  m.prepare('b1');
  clearIgnored();
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const rm = t.mock.method(fs, 'rm', (_p: string, _o: any, cb: (e: Error) => void) => {
    cb(new Error('EBUSY: resource busy'));
    done();
  });
  m.remove(null, 'b1');
  t.mock.timers.tick(0);
  await finished;
  rm.mock.restore();
  assert.deepEqual(ignored(), [['delete a removed Claude Code account', 'EBUSY: resource busy']]);
});

test('an unreadable accounts file is kept aside and recorded, and the app starts from the defaults', () => {
  const { userData } = make({ state: {} });
  fs.writeFileSync(path.join(userData, 'claude-accounts.json'), '{ torn');
  clearIgnored();
  const m = new ClaudeAccounts({ userData, broadcast: () => {}, run: async () => '' });
  assert.deepEqual(m.state.accounts, []);
  assert.equal(fs.readFileSync(path.join(userData, 'claude-accounts.json.unreadable'), 'utf8'), '{ torn');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the Claude Code accounts'],
  );
});

test('prepare leaves a real copy alone, replaces a stale link and survives a link it cannot make', (t) => {
  const root = path.join(tmp, 'prep-shared');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => (process.env.CLAUDE_CONFIG_DIR = shared));
  const { m } = make();
  const dir = m.dir('b1');
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'mine'), 'x');
  fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dir, 'settings.json'));
  const real = fs.symlinkSync;
  t.mock.method(fs, 'symlinkSync', (target: string, link: string, type?: string) => {
    if (link.endsWith('plugins')) throw new Error('EPERM');
    return real(target, link, type as any);
  });
  m.prepare('b1');
  assert.ok(!fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(dir, 'settings.json')), path.join(root, 'settings.json'));
  assert.ok(!fs.existsSync(path.join(dir, 'plugins')));
  // a shared root that doesn't exist yet still gets the folders the CLI makes on demand
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'fresh-shared');
  const d2 = m.prepare('c1');
  assert.equal(fs.readlinkSync(path.join(d2, 'projects')), path.join(tmp, 'fresh-shared', 'projects'));
});

test("the CLI's .claude.json is never created, and an unreadable one is left as it is", (t) => {
  const root = path.join(tmp, 'cfg-shared');
  fs.mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => (process.env.CLAUDE_CONFIG_DIR = shared));
  const { m } = make();
  const dir = m.prepare('b1');
  assert.ok(!fs.existsSync(path.join(root, '.claude.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).hasCompletedOnboarding, true);
  fs.writeFileSync(path.join(root, '.claude.json'), '{ broken');
  m.syncBack('b1');
  assert.equal(fs.readFileSync(path.join(root, '.claude.json'), 'utf8'), '{ broken');
  m.syncBack(null);
  m.syncBack('default');
  m.syncBack('never-prepared');
  assert.ok(!fs.existsSync(m.dir('never-prepared')));
});

test("a .claude.json whose real path can't be resolved is written where it is", (t) => {
  const root = path.join(tmp, 'rp-shared');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => (process.env.CLAUDE_CONFIG_DIR = shared));
  const { m } = make();
  const dir = m.prepare('b1');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ theme: 'light' }));
  t.mock.method(fs.realpathSync, 'native', () => {
    throw new Error('ENOENT');
  });
  m.syncBack('b1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude.json'), 'utf8')).theme, 'light');
});

test('merge3 without an object base, and syncable of nothing', () => {
  assert.deepEqual(merge3(null, { a: 1, b: 1 }, { a: 2 }), { a: 2, b: 1 });
  assert.equal(merge3(undefined, 'x', { a: 1 }).a, 1);
  assert.deepEqual(syncable(null), {});
});

test("without CLAUDE_CONFIG_DIR the CLI's own files are in the home folder", (t) => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'home@example.com', organizationType: 'team' } }),
  );
  const was = process.env.HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = was;
    process.env.CLAUDE_CONFIG_DIR = shared;
  });
  const { m } = make();
  assert.deepEqual(m.cachedPlan('default'), { email: 'home@example.com', organizationType: 'team', rateLimitTier: null });
});

test('removing an account whose CLI sign-out fails still forgets it and deletes its folder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, runs } = make({ state: { accounts: [{ id: 'b1', email: 'b@example.com', loggedIn: true }] }, failLogout: true });
  const dir = m.prepare('b1');
  const v = m.remove('claude', 'b1');
  await flush();
  assert.ok(runs.some((x) => x.join(' ') === 'claude auth logout b1'));
  assert.deepEqual(
    v.accounts.map((a: any) => a.id),
    ['default'],
  );
  t.mock.timers.tick(5000);
  await until(() => !fs.existsSync(dir));
});

test('config sync preserves all three files when an existing input cannot be read', (t) => {
  const root = path.join(tmp, 'strict-sync-shared');
  fs.mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => (process.env.CLAUDE_CONFIG_DIR = shared));
  const { m } = make();
  const dir = m.prepare('b1');
  const files = [path.join(dir, '.claude.json'), path.join(root, '.claude.json'), path.join(dir, '.sage-config-base.json')];
  const texts = [
    JSON.stringify({ oauthAccount: { emailAddress: 'saved@example.com' }, theme: 'light' }),
    '{"theme":"dark"}',
    '{"theme":"dark"}',
  ];
  for (const blocked of files) {
    files.forEach((file, i) => fs.writeFileSync(file, texts[i], { mode: 0o600 }));
    fs.chmodSync(blocked, 0o200);
    try {
      m.syncConfig(dir);
    } finally {
      fs.chmodSync(blocked, 0o600);
    }
    files.forEach((file, i) =>
      assert.equal(fs.readFileSync(file, 'utf8'), texts[i], `must preserve ${file} after failing to read ${blocked}`),
    );
  }
});

test('config sync leaves malformed merge inputs intact rather than treating them as empty', (t) => {
  const root = path.join(tmp, 'invalid-sync-shared');
  fs.mkdirSync(root, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => (process.env.CLAUDE_CONFIG_DIR = shared));
  const { m } = make();
  const dir = m.prepare('b1');
  const files = [path.join(dir, '.claude.json'), path.join(root, '.claude.json'), path.join(dir, '.sage-config-base.json')];
  for (const file of files) {
    for (const invalid of ['{ torn', 'null', '[]', '42']) {
      const texts = ['{"theme":"light"}', '{"theme":"dark"}', '{"theme":"dark"}'];
      texts[files.indexOf(file)] = invalid;
      files.forEach((input, i) => fs.writeFileSync(input, texts[i]));
      m.syncConfig(dir);
      files.forEach((input, i) => assert.equal(fs.readFileSync(input, 'utf8'), texts[i]));
    }
  }
});

test('config sync also preserves its inputs when a reader throws without an error object', (t) => {
  const { m } = make();
  const dir = m.prepare('b1');
  const file = path.join(dir, '.claude.json');
  const before = fs.readFileSync(file, 'utf8');
  const readFile = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', (...args: any[]) => {
    if (args[0] === file) throw undefined;
    return (readFile as any)(...args);
  });
  m.syncConfig(dir);
  mocked.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Claude account saves stay private when a permissive PID temp file was left behind', { skip: process.platform === 'win32' }, (t) => {
  const { m, userData } = make();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.mkdirSync(userData, { recursive: true });
  const stale = `${m.file}.${process.pid}.tmp`;
  fs.writeFileSync(stale, 'stale');
  fs.chmodSync(stale, 0o644);
  m.save();
  assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')), m.state);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'stale', 'a stale file is not owned by this save');
});

test('Claude account saves never follow a stale PID temp symlink', (t) => {
  const { m, userData } = make();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.mkdirSync(userData, { recursive: true });
  const outside = path.join(userData, 'untouched.json');
  fs.writeFileSync(outside, 'keep');
  const stale = `${m.file}.${process.pid}.tmp`;
  fs.symlinkSync(outside, stale);
  m.save();
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(stale).isSymbolicLink());
  assert.ok(fs.lstatSync(m.file).isFile());
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')), m.state);
});

test('a failed Claude account replacement retains the saved state and removes its temporary data', (t) => {
  const { m, userData } = make();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  m.save();
  const original = fs.readFileSync(m.file, 'utf8');
  m.state.autoSwitch = false;
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('rename failed');
  });
  assert.throws(() => m.save(), /rename failed/);
  assert.equal(fs.readFileSync(m.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(userData).sort(), ['claude-accounts', 'claude-accounts.json']);
});
