// The claude:usage IPC: an unpersisted /usage query run on main's schedule (electron/harness/claude/usageSchedule.cjs), its
// failures and backoff, and when the figures it returns were fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, home, tmp, lastQuery } from './support/electron-claude.ts';
import { waitFor } from './support/waitFor.ts';

const text = 'Current session: 12% used';
const cfg = path.join(home, '.claude.json');
const fetchedAt = (fetchedAtMs: number | null) =>
  fetchedAtMs == null
    ? fs.rmSync(cfg, { force: true })
    : fs.writeFileSync(cfg, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs } }));

test('usage IPC returns structured output from an unpersisted usage-only query and closes it', async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  fakes.onQuery = (q: any) => q.push({ type: 'result', result: text });
  const r = await t.call('claude:usage', bin, 'default', 'now');
  assert.deepEqual({ ...r, measuredAt: 0 }, { state: 'success', text, measuredAt: 0, account: null, cached: false });
  const q = lastQuery();
  assert.equal(q.prompt, '/usage');
  assert.equal(q.options.persistSession, false);
  assert.equal(q.options.maxTurns, 1);
  assert.equal(q.closed, true);
});

// main's turn code hears what a login has left and when the CLI measured it, through the harness's turn API
test("a login's own read tells the turn API what is left and when the CLI measured it", async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  fakes.onQuery = (q: any) => q.push({ type: 'result', result: 'Current session: 100% used' });
  const heard: unknown[][] = [];
  t.claude.turnApi.onLoginLeft((...args: unknown[]) => heard.push(args));
  const fetchedAtMs = Date.now() - 60_000;
  fetchedAt(fetchedAtMs);
  try {
    await t.call('claude:usage', bin, 'default', 'now');
    assert.deepEqual(heard, [['default', 0, fetchedAtMs, null]]);
  } finally {
    fetchedAt(null);
  }
});

// main's turn code can have the CLI's own login read, with the configured binary and no window (#3157)
test('the turn API reads the CLI login once, whatever the CLI answers', async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  const unread = () => t.claude.turnApi.accounts().accounts.find((a: any) => a.id === 'default')?.checked;
  assert.equal(unread(), false);
  await t.claude.turnApi.readCliLogin(bin);
  assert.equal(unread(), true);
  // already read: nothing asks the CLI again
  await t.claude.turnApi.readCliLogin(bin);
  assert.equal(unread(), true);
});

test('usage IPC exposes failures instead of silently returning an empty string', async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  fakes.onQuery = (q: any) => q.end(new Error('Usage endpoint unavailable'));
  const r = await t.call('claude:usage', bin, 'default', 'now');
  assert.equal(r.state, 'error');
  assert.equal(r.error, 'Usage endpoint unavailable');
});

// The CLI answers /usage from its cache when its usage endpoint refuses: the answer is as old as that fetch.
test("usage IPC dates a reading by the CLI's last usage fetch, and an answer from an old cache backs the login off", async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  fakes.onQuery = (q: any) => q.push({ type: 'result', result: text });
  const fetchedAtMs = Date.now() - 47 * 60_000;
  fetchedAt(fetchedAtMs);
  try {
    const r = await t.call('claude:usage', bin, null, 'now');
    assert.equal(r.measuredAt, fetchedAtMs);
    assert.equal(r.cached, false);
    assert.ok(r.retryAt > Date.now(), 'the CLI was refused: the login waits before asking again');
    const queries = fakes.queries.length;
    assert.deepEqual(await t.call('claude:usage', bin, null, 'now'), { ...r, cached: true });
    assert.equal(fakes.queries.length, queries);
  } finally {
    fetchedAt(null);
  }
});

test('every window shares one schedule: overlapping reads of a login run one query, and a fresh one is not read again', async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  let release!: () => void;
  fakes.onQuery = (q: any) => (release = () => q.push({ type: 'result', result: text }));
  // an added login: one query per read (the CLI's own login may read twice, harness/claude/loginIdentity.cjs)
  try {
    const before = fakes.queries.length;
    const one = t.call('claude:usage', bin, 'acct', 'background');
    const two = t.call('claude:usage', bin, 'acct', 'surface');
    await waitFor(() => release, 'the usage query to start');
    release();
    const [a, b] = await Promise.all([one, two]);
    assert.equal(fakes.queries.length - before, 1);
    assert.deepEqual(a, b);
    assert.equal(a.cached, false);
    // just read: a timer tick and a surface opening answer from that read
    assert.equal((await t.call('claude:usage', bin, 'acct', 'background')).cached, true);
    assert.equal((await t.call('claude:usage', bin, 'acct', 'whatever')).cached, true);
    assert.equal(fakes.queries.length - before, 1);
  } finally {
    fakes.onQuery = () => {};
  }
});

test('a failed login backs off: even "now" gets its failure without a query, and another login is not held up', async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  fakes.onQuery = (q: any) => q.end('broken pipe');
  const broken = await t.call('claude:usage', bin, 'acct', 'now');
  assert.deepEqual({ ...broken, retryAt: 0 }, { state: 'error', error: 'broken pipe', account: null, cached: false, retryAt: 0 });
  assert.ok(broken.retryAt > Date.now());
  const queries = fakes.queries.length;
  fakes.onQuery = (q: any) => q.end(new Error('boom'));
  assert.deepEqual(await t.call('claude:usage', bin, 'acct', 'now'), { ...broken, cached: true });
  assert.equal(fakes.queries.length, queries);
  assert.equal((await t.call('claude:usage', bin, 'acct2', 'now')).error, 'boom');
  // a sign-in for the login ended: it is read at once, its backoff gone (#1582); anything but ids is ignored
  await t.call('claude:signInEnded', ['acct', 7]);
  await t.call('claude:signInEnded', 'acct');
  fakes.onQuery = (q: any) => q.end('broken again');
  assert.equal((await t.call('claude:usage', bin, 'acct', 'now')).error, 'broken again');
  assert.equal(fakes.queries.length, queries + 2);
});

test('the identity layer reads the installed CLI through the same schedule; a failure reaches it as a rejection', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'usage-id-'));
  process.env.HOME = dir;
  try {
    fakeBin(path.relative(tmp, path.join(dir, '.local/bin/claude')));
    const t = load();
    fakes.onQuery = (q: any) => q.end(new Error('429 Too Many Requests'));
    await assert.rejects(t.claude.identity.readUsage('other'), /429 Too Many Requests/);
  } finally {
    process.env.HOME = home;
  }
});

// #1294: ~/.claude.json names whichever account another client last fetched; the reading names its token's account.
test("the CLI login's usage is read in MoPilot's folder and names the account the server says its token is", async () => {
  const t = load();
  const bin = fakeBin('usage-ipc/claude');
  const cfg = path.join(home, '.claude.json');
  fs.writeFileSync(cfg, JSON.stringify({ oauthAccount: { accountUuid: 'u-desktop', emailAddress: 'desktop@example.com' } }));
  const fetchedAtMs = Date.now() - 60_000;
  fakes.onQuery = (q: any) => {
    const dir = q.options.env.CLAUDE_CONFIG_DIR;
    // the CLI fetches its token's profile at start and keeps a usage cache keyed by that account
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'u-token', emailAddress: 'token@example.com', profileFetchedAt: Date.now() + 1 },
        cachedUsageUtilization: { fetchedAtMs, accountUuid: 'u-token' },
      }),
    );
    q.push({ type: 'result', result: text });
  };
  try {
    const before = fakes.queries.length;
    assert.deepEqual(await t.call('claude:usage', bin, 'default', 'now'), {
      state: 'success',
      text,
      measuredAt: fetchedAtMs,
      // the server named the token's account in the folder: the reading is that account's
      account: 'u-token',
      cached: false,
    });
    assert.equal(fakes.queries.length - before, 1, 'the folder reached the login: no second, plain read');
    const env = lastQuery().options.env;
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(t.userData, 'claude-cli-login'));
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
    const row = (await t.call('claude:accounts')).accounts.find((a: any) => a.id === 'default');
    assert.deepEqual([row.email, row.identity], ['token@example.com', 'verified']);
    // the model probe's account (the harness status, the chat's /status) names it the same way, not as the CLI's config does
    fakes.onQuery = (q: any) => {
      q.initializationResult = async () => ({ models: [], account: { email: 'desktop@example.com', subscriptionType: 'max' } });
    };
    assert.equal((await t.call('claude:probe', bin, null)).account.email, 'token@example.com');
    assert.equal((await t.call('claude:probe', bin, 'acct')).account.email, 'desktop@example.com');
    // what a parent process says about a login (Claude Desktop's host account, a gateway) never reaches the read
    const inherited = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
      CLAUDE_CODE_ACCOUNT_UUID: 'u-desktop',
      CLAUDE_CODE_USER_EMAIL: 'desktop@example.com',
      CLAUDE_CODE_ORGANIZATION_UUID: 'o-desktop',
    };
    Object.assign(process.env, inherited);
    try {
      fakes.onQuery = (q: any) => q.push({ type: 'result', result: text });
      await t.call('claude:usage', bin, 'default', 'now');
      const sent = lastQuery().options.env;
      for (const k of Object.keys(inherited)) assert.equal(sent[k], undefined, k);
      assert.equal(sent.CLAUDE_CONFIG_DIR, path.join(t.userData, 'claude-cli-login'));
    } finally {
      for (const k of Object.keys(inherited)) delete process.env[k];
    }
    // an added login runs on its own folder as before
    fakes.onQuery = (q: any) => q.push({ type: 'result', result: text });
    await t.call('claude:usage', bin, 'acct', 'now');
    assert.equal(lastQuery().options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  } finally {
    fs.rmSync(cfg, { force: true });
  }
});

// #1582: an added login's folder can name another account than its token's; its reading names the token's account.
test("an added login's usage is read in MoPilot's folder for it, on the login's own credential store", async () => {
  const t = load({ register: false });
  const own = path.join(t.userData, 'claude-accounts', 'b1');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(
    path.join(own, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: 'u-meg', emailAddress: 'meg@example.com' } }),
  );
  fs.writeFileSync(
    path.join(t.userData, 'claude-accounts.json'),
    JSON.stringify({ active: 'b1', accounts: [{ id: 'b1', email: 'meg@example.com', loggedIn: true }] }),
  );
  const handlers = new Map<string, (...a: any[]) => any>();
  t.claude.register({ handle: (n: string, fn: (...a: any[]) => any) => handlers.set(n, fn) }, () => {});
  const call = (n: string, ...a: any[]) => handlers.get(n)!({}, ...a);
  const bin = fakeBin('usage-ipc-added/claude');
  fakes.onQuery = (q: any) => {
    fs.writeFileSync(
      path.join(q.options.env.CLAUDE_CONFIG_DIR, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u-dz', emailAddress: 'dz@example.com', profileFetchedAt: Date.now() + 1 } }),
    );
    q.push({ type: 'result', result: text });
  };
  assert.equal((await call('claude:usage', bin, 'b1', 'now')).text, text);
  const env = lastQuery().options.env;
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(t.userData, 'claude-login-check', 'b1'));
  // the keychain item the CLI keys by this exact path string: the one the login runs with
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, own);
  const row = (await call('claude:accounts')).accounts.find((a: any) => a.id === 'b1');
  assert.deepEqual([row.email, row.identity, row.addedAs], ['dz@example.com', 'mismatch', 'meg@example.com']);
  // the model probe names it the same way, not as its folder does
  fakes.onQuery = (q: any) => {
    q.initializationResult = async () => ({ models: [], account: { email: 'meg@example.com', subscriptionType: 'max' } });
  };
  assert.equal((await call('claude:probe', bin, 'b1')).account.email, 'dz@example.com');
});

test('the identity usage adapter rejects a retired login read instead of returning undefined', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'usage-retired-'));
  process.env.HOME = dir;
  try {
    fakeBin(path.relative(tmp, path.join(dir, '.local/bin/claude')));
    const t = load();
    let release!: () => void;
    fakes.onQuery = (q: any) => (release = () => q.push({ type: 'result', result: text }));
    const pending = t.claude.identity.readUsage('other');
    await waitFor(() => release, 'the usage query to start');
    await t.call('claude:signInEnded', ['other']);
    release();
    await assert.rejects(pending, /login changed during its usage read/);
  } finally {
    process.env.HOME = home;
  }
});
