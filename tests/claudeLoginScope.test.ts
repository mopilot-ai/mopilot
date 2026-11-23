// electron/harness/claude/index.cjs: what a Claude Code login is told about itself. A verified Re-check and a status that
// reads signed in again say the login works; a process on a key says so on each message, so its limits and auth
// errors are never the login's; account changes that can change the login in use re-read the capabilities.
// Electron, the SDK, child_process and fs are fakes (tests/support/electron-claude.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, until } from './support/electron-claude.ts';

const bin = fakeBin('login-scope/claude');
const user = (text: string) => ({ role: 'user', content: text });
const of = (t: any, key: string, kind: string) => t.events.filter((e: any) => e.key === key && e.kind === kind);

test('a verified check says the login works only when the login itself answered', async () => {
  const t = load();
  const works: string[] = [];
  t.claude.turnApi.onLoginWorks((id: string) => works.push(id));
  let probeOut: any = { stdout: 'hi' };
  fakes.run = (_c: string, args: string[]) =>
    args[0] === 'auth' ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) } : probeOut;
  const verify = async () => (await t.call('claude:detect', bin, false, true, null)).state;
  assert.equal(await verify(), 'ready');
  assert.deepEqual(works, ['default']);
  // an authentication error, or a check that could not tell, is no proof
  for (const out of [
    { err: new Error('exit 1'), stdout: 'Failed to authenticate. API Error: 401' },
    { err: new Error('network down') },
    { err: new Error('exit 1'), stdout: 'API Error: Connection error.' },
  ]) {
    probeOut = out;
    await verify();
  }
  assert.deepEqual(works, ['default']);
  // a call on a key proves nothing about the login
  probeOut = { stdout: 'hi' };
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-1');
  await t.call('claude:setAuthMode', 'apiKey');
  assert.equal(await verify(), 'apikey');
  // the billing changed while the call ran: it is not counted either
  await t.call('claude:setAuthMode', 'subscription');
  probeOut = () => (t.call('claude:setAuthMode', 'apiKey'), { stdout: 'hi' });
  const run = fakes.run;
  fakes.run = (c: string, args: string[]) => {
    const r = run(c, args);
    return typeof r === 'function' ? r() : r;
  };
  await verify();
  assert.deepEqual(works, ['default']);
});

test("each message says whether its process ran on the login: a key's limits are not the login's", async () => {
  const t = load();
  fakes.onQuery = (q: any) => (q.reply = () => [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, { type: 'result' }]);
  await t.claude.send('claude:login', { bin, sessionId: 'login', ephemeral: true }, user('hi'));
  await until('the login result', () => of(t, 'claude:login', 'message').some((e: any) => e.msg.type === 'result'));
  assert.ok(of(t, 'claude:login', 'message').every((e: any) => e.login === true && e.account === 'default'));
  await t.call('claude:control', 'claude:login', 'close');

  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-1');
  await t.call('claude:setAuthMode', 'apiKey');
  await t.claude.send('claude:keyed', { bin, sessionId: 'keyed', ephemeral: true }, user('hi'));
  await until('the key result', () => of(t, 'claude:keyed', 'message').some((e: any) => e.msg.type === 'result'));
  assert.ok(of(t, 'claude:keyed', 'message').every((e: any) => e.login === false));
  await t.call('claude:control', 'claude:keyed', 'close');
});

test('refreshing and removing logins re-read the capabilities; a login signed in again is reported', async () => {
  const t = load();
  let told = 0;
  t.claude.setProbeListener(() => told++);
  const works: string[] = [];
  t.claude.turnApi.onLoginWorks((id: string) => works.push(id));
  fakes.run = (_c: string, args: string[]) =>
    args[0] === 'auth' ? { stdout: JSON.stringify({ loggedIn: true, email: 'me@x.y', authMethod: 'claude.ai' }) } : { stdout: '' };
  await t.call('claude:refreshAccounts', bin);
  assert.equal(told, 1);
  // the CLI's own login reads signed in for the first time
  assert.deepEqual(works, ['default']);
  // nothing about the login in use changed: no capability re-read
  await t.call('claude:refreshAccounts', bin);
  assert.deepEqual(works, ['default']);
  assert.equal(told, 1);
  await t.call('claude:removeAccount', bin, 'missing');
  assert.equal(told, 2);
});
