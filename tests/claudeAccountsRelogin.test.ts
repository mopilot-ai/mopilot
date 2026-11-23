// Signing a Claude Code login in again (electron/harness/claude/accounts.cjs): a login that lapsed is replaced by a new
// sign-in of the same server account instead of being refused as "already signed in", a login still signed in as that
// account is a duplicate, the same email alone never matches (#1312), and a login that reads signed in again is
// reported so main forgets its lapse. The CLI is faked under a temp dir; each login's folder names its account, and a
// lapsed login is the account it was added as (it can no longer be read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-relogin-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'shared');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const { ClaudeAccounts } = createRequire(import.meta.url)('../electron/harness/claude/accounts.cjs');

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
let n = 0;
type Status = { loggedIn: boolean; email?: string };
function make(state: object, status: (id: string) => Status, folders: Record<string, [string, string?]> = {}) {
  const userData = path.join(tmp, `ud-${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  // folders written before MoPilot starts: each login was added as the account its folder names
  for (const [id, [uuid, email]] of Object.entries(folders)) names({ root: path.join(userData, 'claude-accounts') }, id, uuid, email);
  fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify(state));
  const events: any[] = [];
  const runs: string[][] = [];
  const signedIn: string[] = [];
  const run = async (bin: string, args: string[], id: string) => {
    runs.push([bin, ...args, id]);
    return args[1] === 'status' ? JSON.stringify(status(id)) : '';
  };
  const m = new ClaudeAccounts({ userData, broadcast: (e: any) => events.push(e), run, signedIn: (id: string) => signedIn.push(id) });
  return { m, runs, signedIn, notices: () => events.filter((e) => e.type === 'notice') };
}
/** The account a login's own folder names, as the CLI writes it when it signs in. */
function names(m: any, id: string, accountUuid: string, emailAddress = 'me@example.com') {
  fs.mkdirSync(path.join(m.root, id), { recursive: true });
  fs.writeFileSync(path.join(m.root, id, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid, emailAddress } }));
}

test('a new sign-in of a login that lapsed takes its place, and the login in use with it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let added = false;
  // the CLI's own login is signed in with no email: it is never the same login
  const { m, runs, notices } = make(
    { active: 'old', accounts: [{ id: 'old', email: 'Me@Example.com', loggedIn: false }] },
    (id) =>
      id === 'default' ? { loggedIn: true } : id === 'old' || !added ? { loggedIn: false } : { loggedIn: true, email: 'me@example.com' },
    { old: ['u-me', 'Me@Example.com'] },
  );
  const r = m.startLogin('claude');
  names(m, r.id, 'u-me');
  added = true;
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: r.id, email: 'me@example.com' }]);
  assert.deepEqual(
    m.state.accounts.map((a: any) => [a.id, a.loggedIn]),
    [[r.id, true]],
  );
  assert.equal(m.state.active, r.id);
  // the lapsed login's folder is signed out and removed, never the new one's
  assert.ok(runs.some((x) => x.join(' ') === 'claude auth logout old'));
  assert.ok(!runs.some((x) => x.join(' ') === `claude auth logout ${r.id}`));
});

test('a lapsed login that is not in use is replaced without changing the login in use', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make(
    { active: 'default', accounts: [{ id: 'old', email: 'me@example.com', loggedIn: false }] },
    (id) =>
      id === 'default'
        ? { loggedIn: true, email: 'cli@example.com' }
        : id === 'old'
          ? { loggedIn: false }
          : { loggedIn: true, email: 'me@example.com' },
    { old: ['u-me'] },
  );
  const r = m.startLogin('claude');
  names(m, r.id, 'u-me');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    [r.id],
  );
  assert.equal(m.state.active, 'default');
});

test('a login still signed in as the same server account is a duplicate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // the server named its token's account in an earlier run
  const serverAccount = { accountUuid: 'u-me', email: 'ME@example.com' };
  const { m, notices } = make(
    { active: 'default', accounts: [{ id: 'kept', email: 'ME@example.com', loggedIn: true, serverAccount }] },
    (id) => (id === 'default' ? { loggedIn: false } : { loggedIn: true, email: 'me@example.com' }),
  );
  names(m, 'kept', 'u-me', 'ME@example.com');
  const r = m.startLogin('claude');
  names(m, r.id, 'u-me');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'duplicate', email: 'me@example.com' }]);
  assert.deepEqual(
    m.state.accounts.map((a: any) => a.id),
    ['kept'],
  );
});

test('a sign-in with no email is never matched to another login', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m } = make({ active: 'default', accounts: [{ id: 'old', email: 'me@example.com', loggedIn: false }] }, (id) =>
    id === 'default' ? { loggedIn: false } : id === 'old' ? { loggedIn: false } : { loggedIn: true },
  );
  const r = m.startLogin('claude');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(m.state.accounts.map((a: any) => a.id).sort(), ['old', r.id].sort());
});

test('a refresh reports each login that reads signed in again, once', async () => {
  let on = false;
  const { m, signedIn } = make(
    {
      active: 'default',
      accounts: [
        { id: 'a', email: 'a@example.com', loggedIn: false },
        { id: 'b', email: 'b@example.com', loggedIn: true },
      ],
    },
    (id) => ({ loggedIn: id === 'b' || on, email: `${id}@example.com` }),
  );
  await m.refresh('claude');
  assert.deepEqual(signedIn, []);
  on = true;
  await m.refresh('claude');
  assert.deepEqual(signedIn, ['default', 'a']);
  await m.refresh('claude');
  assert.deepEqual(signedIn, ['default', 'a']);
});

test('without a listener a login signing in again is simply taken', async () => {
  const userData = path.join(tmp, `ud-${n++}`);
  const m = new ClaudeAccounts({ userData, broadcast: () => {}, run: async () => JSON.stringify({ loggedIn: true }) });
  await m.refresh('claude');
  assert.equal(m.defaultInfo.loggedIn, true);
});

test('the same email as another server account is a login of its own, signed in or lapsed (#1312)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, notices } = make(
    {
      active: 'default',
      accounts: [
        { id: 'on', email: 'me@example.com', loggedIn: true },
        { id: 'off', email: 'me@example.com', loggedIn: false },
      ],
    },
    (id) => (id === 'off' ? { loggedIn: false } : { loggedIn: true, email: 'me@example.com' }),
  );
  names(m, 'on', 'u-team');
  names(m, 'off', 'u-team');
  const r = m.startLogin('claude');
  names(m, r.id, 'u-personal');
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(notices(), [{ type: 'notice', kind: 'signedIn', id: r.id, email: 'me@example.com' }]);
  assert.deepEqual(m.state.accounts.map((a: any) => a.id).sort(), ['off', 'on', r.id].sort());
  // two server accounts: both listed
  assert.deepEqual(m.view().same, {});
});
