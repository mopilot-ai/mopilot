// One Claude account is one row (#1312): when the CLI's own login and an added login are the same server account
// (the CLI login signed in again outside MoPilot), electron/harness/claude/accounts.cjs lists the added one and names the
// fold in `same`; the switch policy (identity/contract/switch.cjs) and the driver count them as one quota. An identity the
// server didn't confirm is never folded, and the same email is not the same account. The CLI is faked under a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-same-'));
const shared = path.join(tmp, 'shared');
fs.mkdirSync(shared, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = shared;
const req = createRequire(import.meta.url);
const { ClaudeAccounts } = req('../electron/harness/claude/accounts.cjs');
const { claudeLoginFor, decideClaudeSwitch } = req('../electron/identity/contract/switch.cjs');
const { claudeInstances } = req('../electron/identity/drivers/claude.cjs');
const { LoginMarks } = req('../electron/identity/contract/loginMarks.cjs');

const profile = (accountUuid: string, emailAddress: string, profileFetchedAt?: number) => ({
  oauthAccount: { accountUuid, emailAddress, ...(profileFetchedAt ? { profileFetchedAt } : {}) },
});
let n = 0;
const ON = { loggedIn: true, email: null, subscriptionType: null, authMethod: null };
function make(state: object) {
  const userData = path.join(tmp, `ud-${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify(state));
  const m = new ClaudeAccounts({ userData, broadcast: () => {}, run: async () => '' });
  m.cliLogin.waitMs = 0;
  m.takeDefault(ON);
  return m;
}
/** An added login whose token the server named `uuid` (an earlier read), with its own folder naming it too. */
function names(m: any, id: string, uuid: string, email = 'dz@example.com') {
  fs.mkdirSync(m.dir(id), { recursive: true });
  fs.writeFileSync(path.join(m.dir(id), '.claude.json'), JSON.stringify(profile(uuid, email)));
  m.state.accounts.find((a: any) => a.id === id).serverAccount = { accountUuid: uuid, email };
}
/** A usage read of the CLI's own login whose CLI fetched the profile of `uuid` into MoPilot's folder. */
const readAs = (m: any, uuid: string | null, email = 'dz@example.com') =>
  m.cliLogin.read(
    async () => {
      if (uuid) fs.writeFileSync(m.cliLogin.file, JSON.stringify(profile(uuid, email, Date.now() + 1)));
      return 'Current session: 5% used';
    },
    async () => {
      throw new Error('no folder');
    },
  );
const ids = (m: any) => m.view().accounts.map((a: any) => a.id);
const dz = (extra: object = {}) => ({ id: 'x', email: 'dz@example.com', loggedIn: true, ...extra });

test('the CLI login signed in again as an added account shows once, as the added login, with usage read once', async () => {
  const m = make({ active: 'x', accounts: [dz(), { id: 'y', email: 'other@example.com', loggedIn: true }] });
  names(m, 'x', 'u-dz');
  names(m, 'y', 'u-other', 'other@example.com');
  // the CLI login is another account: both listed
  await readAs(m, 'u-meggie', 'meggie@example.com');
  assert.deepEqual(ids(m), ['default', 'x', 'y']);
  assert.deepEqual(m.view().same, {});
  // signed in again outside MoPilot as dz, which is already added
  await readAs(m, 'u-dz');
  assert.deepEqual(ids(m), ['x', 'y']);
  assert.deepEqual(m.view().same, { default: 'x' });
  assert.equal(m.view().active, 'x');
  // the CLI login in use is named by the login shown for its account
  m.setActive('default');
  assert.equal(m.view().active, 'x');
  // signed in again as someone else: listed again by itself
  await readAs(m, 'u-meggie', 'meggie@example.com');
  assert.deepEqual(ids(m), ['default', 'x', 'y']);
  assert.equal(m.view().active, 'default');
});

test('a CLI login the server did not confirm, a lapsed login, or the same email of another account is never folded', async () => {
  const m = make({ active: 'x', accounts: [dz()] });
  names(m, 'x', 'u-dz');
  // no answer yet: the shared config may name dz, but that is not the server's word
  fs.writeFileSync(path.join(shared, '.claude.json'), JSON.stringify(profile('u-dz', 'dz@example.com', 1)));
  assert.deepEqual(ids(m), ['default', 'x']);
  // a failed read keeps the last answer unconfirmed
  await readAs(m, 'u-dz');
  m.cliLogin.retire();
  assert.equal(m.cliLogin.last.read, 'failed');
  assert.deepEqual(ids(m), ['default', 'x']);
  // confirmed: folded
  await readAs(m, 'u-dz');
  assert.deepEqual(ids(m), ['x']);
  // the added login lapsed, or the CLI login signed out: each is its own row again (to sign in or remove)
  m.state.accounts[0].loggedIn = false;
  assert.deepEqual(ids(m), ['default', 'x']);
  m.state.accounts[0].loggedIn = true;
  assert.deepEqual(ids(m), ['x']);
  m.takeDefault({ ...ON, loggedIn: false });
  assert.deepEqual(ids(m), ['default', 'x']);
  // the same email on another server account (a team and a personal org) stays two rows
  const two = make({ active: 'x', accounts: [dz()] });
  names(two, 'x', 'u-team');
  await readAs(two, 'u-personal');
  assert.deepEqual(ids(two), ['default', 'x']);
});

test('two added logins of one account (one signed in again as the other) show once, the one in use', () => {
  const m = make({
    active: 'b',
    accounts: [
      { ...dz(), id: 'a' },
      { ...dz(), id: 'b' },
    ],
  });
  names(m, 'a', 'u-dz');
  names(m, 'b', 'u-dz');
  assert.deepEqual(ids(m), ['default', 'b']);
  assert.deepEqual(m.view().same, { a: 'b' });
});

test("a chat on the folded login keeps running on it; the shown login's lapse or limit moves it within the lane", () => {
  const view = {
    active: 'x',
    same: { default: 'x' },
    accounts: [dz(), { id: 'y', loggedIn: true }],
  };
  // the same quota: no move, no restart
  assert.equal(claudeLoginFor('default', view), 'default');
  assert.equal(claudeLoginFor('x', view), 'x');
  assert.equal(claudeLoginFor(null, view), 'x');
  // the account's login lapsed with auto-switch on: another login of the lane takes over
  const lapsed = { ...view, accounts: [dz({ loggedIn: false }), { id: 'y', loggedIn: true }] };
  assert.equal(claudeLoginFor('default', lapsed), 'y');
  assert.equal(claudeLoginFor('default', { ...lapsed, autoSwitch: false }), 'default');
  // a limit seen on the folded login holds the shown one too: no login left in the lane
  const marks = new LoginMarks();
  marks.limited({ login: true }, 'default', 1000, 60_000);
  const out = { active: 'y', same: { default: 'x' }, accounts: [dz(), { id: 'y', loggedIn: false }] };
  assert.equal(claudeLoginFor('y', out, marks, 2000), 'y');
  assert.equal(claudeLoginFor('y', out, new Map(), 2000), 'x');
});

test('a limit on the folded login is a limit on its account: the shown login is no way out, another one is', () => {
  const view = {
    active: 'x',
    autoSwitch: true,
    same: { default: 'x' },
    accounts: [dz(), { id: 'y', email: 'y@example.com', loggedIn: true }],
  };
  const d = decideClaudeSwitch({ account: 'default', view, marks: new Map(), now: 1000 });
  assert.deepEqual([d.action, d.from, d.to], ['switch', 'default', 'y']);
  // with only the account itself, nothing is left to move to
  const alone = { ...view, accounts: [dz()] };
  assert.equal(decideClaudeSwitch({ account: 'default', view: alone, marks: new Map(), now: 1000 }).action, 'none');
  // a limit on the shown login holds the folded one too: it is no candidate (it is not even listed)
  assert.equal(decideClaudeSwitch({ account: 'x', view: alone, marks: new Map(), now: 1000 }).action, 'none');
  // a lapse is the folded login's own sign-in: the shown login of the same account takes the chat over
  const e = decideClaudeSwitch({ account: 'default', reason: 'expired', view: alone, marks: new Map(), now: 1000 });
  assert.deepEqual([e.action, e.to], ['switch', 'x']);
});

test("the driver's instances list the account once, held back by a limit seen on either login", () => {
  const marks = new LoginMarks();
  marks.limited({ login: true }, 'default', 1000, 60_000);
  const view = { active: 'x', same: { default: 'x' }, accounts: [dz()] };
  const key = { set: false, mode: 'subscription', baseUrl: null };
  const [x, ...rest] = claudeInstances(view, key, false, marks, 2000);
  assert.deepEqual([x.account, x.limited, x.active, rest.length], ['x', true, true, 0]);
  // marks without a snapshot (an older caller) are read as they are
  const plain = claudeInstances(view, key, false, { get: () => undefined }, 2000);
  assert.equal(plain[0].limited, false);
  assert.equal(claudeInstances({ active: 'x', accounts: [dz()] }, key, false, marks, 2000)[0].limited, false);
});
