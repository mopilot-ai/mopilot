// Claude account folders: everything shared with the CLI's own config except the login (data is made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-accts-'));
const shared = path.join(tmp, 'shared');
fs.mkdirSync(path.join(shared, 'skills'), { recursive: true });
fs.writeFileSync(path.join(shared, 'settings.json'), '{}');
fs.writeFileSync(path.join(shared, '.credentials.json'), '{"secret":true}');
fs.writeFileSync(
  path.join(shared, '.claude.json'),
  JSON.stringify({
    mcpServers: { x: {} },
    theme: 'dark',
    oauthAccount: { emailAddress: 'a@example.com' },
    cachedUsageUtilization: 5,
    userID: 'u1',
  }),
);
process.env.CLAUDE_CONFIG_DIR = shared;
const { ClaudeAccounts, merge3 } = createRequire(import.meta.url)('../electron/harness/claude/accounts.cjs');

const make = () => new ClaudeAccounts({ userData: path.join(tmp, 'ud'), broadcast: () => {}, run: async () => '{}' });

test('an account folder links the shared entries but not the login', () => {
  const m = make();
  m.state.accounts.push({ id: 'b1', email: 'b@example.com', loggedIn: true });
  const dir = m.prepare('b1');
  assert.equal(fs.readlinkSync(path.join(dir, 'skills')), path.join(shared, 'skills'));
  assert.equal(fs.readlinkSync(path.join(dir, 'settings.json')), path.join(shared, 'settings.json'));
  assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(shared, 'projects'));
  assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers, { x: {} });
  assert.equal(cfg.theme, 'dark');
  assert.equal(cfg.oauthAccount, undefined);
  assert.equal(cfg.cachedUsageUtilization, undefined);
  assert.equal(cfg.userID, undefined);
});

test("refreshing keeps the account's own login fields and picks up shared changes", () => {
  const m = make();
  m.state.accounts.push({ id: 'b1', email: 'b@example.com', loggedIn: true });
  const dir = m.prepare('b1');
  const f = path.join(dir, '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), oauthAccount: { emailAddress: 'b@example.com' } }));
  const base = JSON.parse(fs.readFileSync(path.join(shared, '.claude.json'), 'utf8'));
  fs.writeFileSync(path.join(shared, '.claude.json'), JSON.stringify({ ...base, theme: 'light' }));
  m.prepare('b1');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(cfg.oauthAccount.emailAddress, 'b@example.com');
  assert.equal(cfg.theme, 'light');
  assert.equal(m.cachedPlan('b1')?.email, 'b@example.com');
  assert.equal(m.cachedPlan('default')?.email, 'a@example.com');
});

test('the CLI login runs with no extra environment; an added account gets its folder', () => {
  const m = make();
  m.state.accounts.push({ id: 'b1', email: 'b@example.com', loggedIn: true });
  assert.deepEqual(m.env('default'), {});
  assert.deepEqual(m.env('gone'), {});
  assert.equal(m.env('b1').CLAUDE_CONFIG_DIR, path.join(tmp, 'ud', 'claude-accounts', 'b1'));
  assert.equal(m.view().accounts[0].id, 'default');
});

test('merge3: the side that changed wins, objects merge key by key, mine wins a clash', () => {
  const base = { a: 1, projects: { p: { trust: false }, q: { trust: true } }, gone: 1 };
  const theirs = { a: 2, projects: { p: { trust: false }, q: { trust: true }, r: { trust: true } }, gone: 1 };
  const mine = { a: 1, projects: { p: { trust: true }, q: { trust: true } } };
  assert.deepEqual(merge3(base, theirs, mine), { a: 2, projects: { p: { trust: true }, q: { trust: true }, r: { trust: true } } });
  assert.equal(merge3({ x: 1 }, { x: 2 }, { x: 3 }).x, 3);
});

test('what the CLI saves on an account reaches the shared config, and shared changes come back', () => {
  const sharedFile = path.join(shared, '.claude.json');
  const m = make();
  m.state.accounts.push({ id: 'c1', email: 'c@example.com', loggedIn: true });
  const dir = m.prepare('c1');
  const f = path.join(dir, '.claude.json');
  // the CLI trusts a project and adds an MCP server on this account, and writes its login
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(
    f,
    JSON.stringify({
      ...cfg,
      projects: { '/p': { hasTrustDialogAccepted: true } },
      mcpServers: { ...cfg.mcpServers, y: {} },
      oauthAccount: { emailAddress: 'c@example.com' },
    }),
  );
  // meanwhile the CLI's own config changed elsewhere
  fs.writeFileSync(sharedFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sharedFile, 'utf8')), theme: 'light' }));
  m.syncBack('c1');
  const back = JSON.parse(fs.readFileSync(sharedFile, 'utf8'));
  assert.deepEqual(back.projects, { '/p': { hasTrustDialogAccepted: true } });
  assert.deepEqual(back.mcpServers, { x: {}, y: {} });
  assert.equal(back.theme, 'light');
  assert.equal(back.oauthAccount.emailAddress, 'a@example.com'); // the CLI's own login is untouched
  assert.equal(back.hasCompletedOnboarding, undefined);
  const mine = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(mine.theme, 'light');
  assert.equal(mine.oauthAccount.emailAddress, 'c@example.com');
  assert.equal(mine.hasCompletedOnboarding, true);
  // another account picks the trust up
  m.state.accounts.push({ id: 'c2', email: 'd@example.com', loggedIn: true });
  const other = JSON.parse(fs.readFileSync(path.join(m.prepare('c2'), '.claude.json'), 'utf8'));
  assert.deepEqual(other.projects, { '/p': { hasTrustDialogAccepted: true } });
});

test('keys Sage holds run in a folder of their own', () => {
  const m = make();
  const e = m.keyEnv('mopilot');
  assert.equal(e.CLAUDE_CONFIG_DIR, path.join(tmp, 'ud', 'claude-accounts', 'key-mopilot'));
  assert.notEqual(e.CLAUDE_CONFIG_DIR, m.keyEnv('apiKey').CLAUDE_CONFIG_DIR);
  assert.ok(fs.existsSync(path.join(e.CLAUDE_CONFIG_DIR, '.claude.json')));
  assert.equal(m.view().accounts.length, 1); // not listed as an account
});

test("an account's .claude.json caught mid-write is left alone, login and all", () => {
  const m = make();
  m.state.accounts.push({ id: 'b3', email: 'c@example.com', loggedIn: true });
  const dir = m.prepare('b3');
  const f = path.join(dir, '.claude.json');
  for (const torn of ['{"oauthAccount":{"emailAddress":"c@exa', 'null']) {
    fs.writeFileSync(f, torn);
    m.prepare('b3');
    assert.equal(fs.readFileSync(f, 'utf8'), torn, 'not replaced by a merge without its login');
  }
});

test("the CLI's own .claude.json keeps its symlink, and a write the CLI makes meanwhile isn't lost", () => {
  const sharedFile = path.join(shared, '.claude.json');
  const dotfiles = path.join(tmp, 'dotfiles.claude.json');
  fs.renameSync(sharedFile, dotfiles);
  fs.symlinkSync(dotfiles, sharedFile);
  const m = make();
  m.state.accounts.push({ id: 'c3', email: 'e@example.com', loggedIn: true });
  const dir = m.prepare('c3');
  const f = path.join(dir, '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), editorMode: 'vim' }));
  m.syncBack('c3');
  assert.ok(fs.lstatSync(sharedFile).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(dotfiles, 'utf8')).editorMode, 'vim');

  // the CLI writes its file between the merge's read and its write: that write stays, and ours comes on the next sync
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), autoUpdates: false }));
  const read = fs.readFileSync;
  let raced = false;
  (fs as any).readFileSync = function (p: any, ...rest: any[]) {
    const out = read.call(fs, p, ...rest);
    if (!raced && String(p) === sharedFile) {
      raced = true;
      fs.writeFileSync(dotfiles, JSON.stringify({ ...JSON.parse(String(out)), verbose: true }));
    }
    return out;
  };
  try {
    m.syncBack('c3');
  } finally {
    (fs as any).readFileSync = read;
  }
  let cli = JSON.parse(fs.readFileSync(dotfiles, 'utf8'));
  assert.equal(cli.verbose, true);
  assert.equal(cli.autoUpdates, undefined);
  m.syncBack('c3');
  cli = JSON.parse(fs.readFileSync(dotfiles, 'utf8'));
  assert.equal(cli.verbose, true);
  assert.equal(cli.autoUpdates, false);
  assert.ok(fs.lstatSync(sharedFile).isSymbolicLink());
});

test('shared config sync follows directory links before dot segments in a file-link target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-dots-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'nested', 'real'), { recursive: true });
  fs.symlinkSync('nested/real', path.join(root, 'alias'), 'dir');
  const actual = path.join(root, 'nested', 'config.json');
  const decoy = path.join(root, 'config.json');
  const original = JSON.stringify({ theme: 'dark' });
  fs.writeFileSync(actual, original);
  fs.writeFileSync(decoy, original);
  fs.symlinkSync('alias/../config.json', path.join(root, '.claude.json'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const m = new ClaudeAccounts({ userData: path.join(root, 'ud'), broadcast: () => {}, run: async () => '{}' });
  m.state.accounts.push({ id: 'native-target', email: 'made-up@example.com', loggedIn: true });
  const account = m.prepare('native-target');
  const mine = path.join(account, '.claude.json');
  fs.writeFileSync(mine, JSON.stringify({ ...JSON.parse(fs.readFileSync(mine, 'utf8')), editorMode: 'vim' }));
  m.syncBack('native-target');
  assert.equal(JSON.parse(fs.readFileSync(actual, 'utf8')).editorMode, 'vim');
  assert.equal(fs.readFileSync(decoy, 'utf8'), original);
  assert.ok(fs.lstatSync(path.join(root, '.claude.json')).isSymbolicLink());
});

test("usageFetchedAt reads when the CLI last fetched each login's usage, and only a usable time", () => {
  const m = make();
  m.state.accounts.push({ id: 'u1', email: 'u@example.com', loggedIn: true });
  const f = path.join(m.prepare('u1'), '.claude.json');
  const write = (cachedUsageUtilization: unknown) =>
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), cachedUsageUtilization }));
  const at = Date.now() - 47 * 60_000;
  write({ fetchedAtMs: at, utilization: {} });
  assert.equal(m.usageFetchedAt('u1'), at);
  // a clock ahead of this one never dates a reading in the future
  write({ fetchedAtMs: Date.now() + 3_600_000 });
  assert.ok(m.usageFetchedAt('u1') <= Date.now());
  for (const bad of [{ fetchedAtMs: 'soon' }, { fetchedAtMs: 0 }, { fetchedAtMs: Number.NaN }, null]) {
    write(bad);
    assert.equal(m.usageFetchedAt('u1'), null);
  }
  // the CLI's own login reads the shared config, whose cache here isn't a fetch record
  assert.equal(m.usageFetchedAt('default'), null);
  assert.equal(m.usageFetchedAt(undefined), null);
  assert.equal(m.usageFetchedAt('missing'), null);
});

test("an account folder never links the CLI's lock files, and drops links made to them before (#1582)", () => {
  const m = make();
  m.state.accounts.push({ id: 'lk', email: 'l@example.com', loggedIn: true });
  const locks = ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', '.storage-write.lock', '.design_oauth_refresh.lock'];
  // a lock the CLI held in ~/.claude when the folder was prepared
  for (const n of locks) fs.mkdirSync(path.join(shared, n), { recursive: true });
  const dir = m.prepare('lk');
  for (const n of locks) assert.equal(fs.existsSync(path.join(dir, n)), false, n);
  // links an older version made, dangling once the CLI released its lock
  for (const n of locks) {
    fs.rmSync(path.join(shared, n), { recursive: true });
    fs.symlinkSync(path.join(shared, n), path.join(dir, n));
  }
  m.prepare('lk');
  for (const n of locks) assert.throws(() => fs.lstatSync(path.join(dir, n)), /ENOENT/, n);
  // the CLI's own lock in the folder (a real directory, not a link) is left alone
  fs.mkdirSync(path.join(dir, '.oauth_refresh.lock'));
  m.prepare('lk');
  assert.ok(fs.lstatSync(path.join(dir, '.oauth_refresh.lock')).isDirectory());
  // shared entries still link
  assert.equal(fs.readlinkSync(path.join(dir, 'skills')), path.join(shared, 'skills'));
});

test("an account keeps its own plans folder, so the CLI writes a session's plan without an Edit card (#1933)", () => {
  const m = make();
  m.state.accounts.push({ id: 'pl', email: 'p@example.com', loggedIn: true });
  fs.mkdirSync(path.join(shared, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'plans', 'old-plan.md'), '# old');
  fs.writeFileSync(path.join(shared, 'plans', 'kept.md'), '# shared');
  const dir = m.prepare('pl');
  // a new account never gets a link: the CLI makes the folder itself
  assert.equal(fs.lstatSync(path.join(dir, 'plans'), { throwIfNoEntry: false }), undefined);
  // the link an earlier version made becomes a real folder, holding the plans it reached
  fs.symlinkSync(path.join(shared, 'plans'), path.join(dir, 'plans'));
  m.prepare('pl');
  const plans = path.join(dir, 'plans');
  assert.ok(fs.lstatSync(plans).isDirectory());
  assert.equal(fs.readFileSync(path.join(plans, 'old-plan.md'), 'utf8'), '# old');
  // the shared folder is left as it was; later writes stay the account's own
  fs.writeFileSync(path.join(plans, 'kept.md'), '# own');
  assert.equal(fs.readFileSync(path.join(shared, 'plans', 'kept.md'), 'utf8'), '# shared');
  m.prepare('pl');
  assert.equal(fs.readFileSync(path.join(plans, 'kept.md'), 'utf8'), '# own');
  // the other entries still link
  assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(shared, 'projects'));
});
