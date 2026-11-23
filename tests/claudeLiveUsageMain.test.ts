// electron/harness/claude/index.cjs: a turn's rate_limit_event reaches the login's usage in main with no window open (#1317), only
// for the login the process ran on, and a refusal with no figures makes the login due at once. Electron, the SDK,
// child_process and fs are fakes (tests/support/electron-claude.ts); events are tests/fixtures/live-usage-events.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, until } from './support/electron-claude.ts';

const { claude: ev } = JSON.parse(fs.readFileSync(new URL('./fixtures/live-usage-events.json', import.meta.url), 'utf8'));
const bin = fakeBin('live-usage/claude');
const user = (text: string) => ({ role: 'user', content: text });
const ended = (t: any, key: string) => () => t.events.some((e: any) => e.key === key && e.kind === 'message' && e.msg.type === 'result');

/** Each query: /usage answers `usage`, a chat turn replies with `turn` then a result. */
function answer(usage: string, turn: () => any[]) {
  fakes.onQuery = (q: any) => {
    if (q.prompt === '/usage') q.push({ type: 'result', result: usage });
    else q.reply = () => [...turn(), { type: 'result' }];
  };
}

test("a turn's report lands on the login it ran on, and a key's never does", async () => {
  const t = load();
  answer('Current session: 3% used', () => [ev.rejectedWeekly]);
  await t.claude.send('claude:login', { bin, sessionId: 'login', ephemeral: true }, user('hi'));
  await until('the login result', ended(t, 'claude:login'));
  await t.call('claude:control', 'claude:login', 'close');
  const live = (await t.call('claude:usage', bin, 'default', 'surface')).live;
  assert.deepEqual(
    live.windows.map((w: any) => [w.label, w.usedPercent]),
    [
      ['5h', 12],
      ['Weekly', 100],
    ],
  );

  // the same kind of report from a process on a key is the key's, not the login's
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-1');
  await t.call('claude:setAuthMode', 'apiKey');
  answer('Current session: 3% used', () => [ev.olderCliRejected]);
  await t.claude.send('claude:keyed', { bin, sessionId: 'keyed', ephemeral: true }, user('hi'));
  await until('the key result', ended(t, 'claude:keyed'));
  await t.call('claude:control', 'claude:keyed', 'close');
  await t.call('claude:setAuthMode', 'subscription');
  assert.deepEqual((await t.call('claude:usage', bin, 'default', 'surface')).live, live);
});

test('a refusal with no figures (an assistant rate_limit error) has the login read at the next tick', async () => {
  const t = load();
  answer('Current session: 3% used', () => [ev.rateLimitError]);
  await t.call('claude:usage', bin, 'acct', 'now');
  assert.equal((await t.call('claude:usage', bin, 'acct', 'background')).cached, true, 'just read');
  await t.claude.send('claude:limited', { bin, sessionId: 'limited', ephemeral: true, account: 'acct' }, user('hi'));
  await until('the limited result', ended(t, 'claude:limited'));
  await t.call('claude:control', 'claude:limited', 'close');
  assert.ok(t.events.some((e: any) => e.key === 'claude:limited' && e.login && e.account === 'acct'));
  assert.equal((await t.call('claude:usage', bin, 'acct', 'background')).cached, false);
});

test('a removed login keeps no report in main', async () => {
  const t = load();
  answer('Current session: 3% used', () => [ev.allowed]);
  await t.claude.send('claude:gone', { bin, sessionId: 'gone', ephemeral: true, account: 'gone' }, user('hi'));
  await until('the result', ended(t, 'claude:gone'));
  await t.call('claude:control', 'claude:gone', 'close');
  assert.equal((await t.call('claude:usage', bin, 'gone', 'surface')).live.windows.length, 2);
  await t.call('claude:removeAccount', bin, 'gone');
  assert.equal((await t.call('claude:usage', bin, 'gone', 'surface')).live, undefined);
});

// #1582: a process keeps the token it started with, so its turns' figures are the account its login was then.
test("a turn's report is the server account its login was when the process started, not whatever it is later", async () => {
  const t = load({ register: false });
  const serverAccount = { accountUuid: 'u-dz', email: 'dz@example.com' };
  fs.writeFileSync(
    path.join(t.userData, 'claude-accounts.json'),
    JSON.stringify({
      active: 'default',
      accounts: [
        { id: 'b1', email: 'dz@example.com', loggedIn: true, serverAccount },
        { id: 'b2', email: 'new@example.com', loggedIn: true },
      ],
    }),
  );
  const handlers = new Map<string, (...a: any[]) => any>();
  const events: any[] = [];
  t.claude.register({ handle: (n: string, fn: (...a: any[]) => any) => handlers.set(n, fn) }, (ch: string, e: any) => {
    if (ch === 'claude:event') events.push(e);
  });
  const call = (n: string, ...a: any[]) => handlers.get(n)!({}, ...a);
  const done = (key: string) => () => events.some((e) => e.key === key && e.kind === 'message' && e.msg.type === 'result');
  answer('Current session: 3% used', () => [ev.allowed]);
  await t.claude.send('claude:b1', { bin, sessionId: 'b1', ephemeral: true, account: 'b1' }, user('hi'));
  await until('the b1 result', done('claude:b1'));
  await call('claude:control', 'claude:b1', 'close');
  assert.ok(events.filter((e) => e.key === 'claude:b1' && e.kind === 'message').every((e) => e.serverAccount === 'u-dz'));
  assert.equal((await call('claude:usage', bin, 'b1', 'surface')).live.windows.length, 2);
  // signed in again: the login is no longer known to be dz, and dz's figures are not its own
  await call('claude:reloginCommand', bin, 'b1');
  assert.equal((await call('claude:usage', bin, 'b1', 'surface')).live, undefined);
  // a login whose account was not known when its process started: its figures are the login's
  await t.claude.send('claude:b2', { bin, sessionId: 'b2', ephemeral: true, account: 'b2' }, user('hi'));
  await until('the b2 result', done('claude:b2'));
  await call('claude:control', 'claude:b2', 'close');
  assert.ok(events.filter((e) => e.key === 'claude:b2' && e.kind === 'message').every((e) => e.serverAccount === null));
  assert.equal((await call('claude:usage', bin, 'b2', 'surface')).live.windows.length, 2);
});
