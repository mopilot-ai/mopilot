// The usage windows a Codex chat shows are its own login's (identity/accounts/limits.cjs servingLogin, drivers/codex.cjs chatLimits): the login the app-server holds without the relay, the thread's pin behind it, and none, never another login's, when that cannot be told: the held login moving, an unpinned thread in a pool (B9, the Chrome panel's "approaching" banner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, sub, flush } from './support/electron-accounts.ts';
import { codexLimitWarning } from '../shared/chatSignals.mjs';

const require = createRequire(import.meta.url);
const { CodexDriver } = require('../electron/identity/drivers/codex.cjs');

const homes = { b: 'b@example.com', c: 'c@example.com' };
const reading = (primary: object) => ({
  method: 'account/rateLimits/updated',
  params: { rateLimits: { limitId: 'codex', primary, secondary: null } },
});
const window = (usedPercent: number) => ({ usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
const headers = (used: number) => ({
  'x-codex-primary-used-percent': String(used),
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-after-seconds': '3600',
});
const warned = (a: any, thread: string) => codexLimitWarning(new CodexDriver(a).chatLimits(thread), Date.now())?.window ?? null;

test('without the relay a chat shows the held login’s windows; after a failover the new login’s, with none of the old login’s', async (t) => {
  const { a } = setup(t, { state: { active: 'default', accounts: [sub('b'), sub('c')] }, homes });
  a.applied = 'default';
  a.onMainMessage(reading(window(90)));
  assert.equal(a.get('default').limits.primary.usedPercent, 90);
  assert.equal(a.servingLogin('t1').id, 'default');
  assert.equal(warned(a, 't1'), '5h');
  // the app-server moves to b (a failover through Accounts.applyNow): while it moves, the chat shows nothing
  a.server.reply = (m: any) => (m.method === 'account/login/start' ? undefined : { result: {} });
  const moving = a.switchTo('b');
  await flush();
  assert.equal(a.pendingApply, true);
  assert.equal(a.servingLogin('t1'), null);
  assert.equal(warned(a, 't1'), null);
  const [login] = a.mainPending.keys();
  a.onMainMessage({ id: login, result: {} });
  await moving;
  // b is held now, and has no reading of its own: the warning does not follow the chat to it
  assert.equal(a.servingLogin('t1').id, 'b');
  assert.equal(warned(a, 't1'), null);
  assert.equal(a.get('default').limits.primary.usedPercent, 90, 'the old login keeps its own reading');
  // b's own reading is what shows
  a.onMainMessage(reading(window(80)));
  assert.equal(a.get('b').limits.primary.usedPercent, 80);
  assert.equal(warned(a, 't1'), '5h');
  assert.equal(new CodexDriver(a).chatLimits('t1').primary.usedPercent, 80);
});

test('behind the relay a chat shows its pinned login’s windows, not the last reading of another login', (t) => {
  const { a } = setup(t, { state: { active: 'default', accounts: [sub('b'), sub('c')] }, homes });
  a.relay = { stop() {}, dropSession() {} };
  a.applied = 'default';
  // the last reading came from the default login, at 90%; the relay serves chat X from b, which has not been read
  a.noteUsageHeaders(a.get('default'), headers(90));
  a.pins.set('x', { id: 'b', at: Date.now() });
  a.pins.set('y', { id: 'default', at: Date.now() });
  assert.equal(a.servingLogin('x').id, 'b');
  assert.equal(warned(a, 'x'), null, 'chat X is not on the login that was read');
  assert.equal(warned(a, 'y'), '5h');
  a.noteUsageHeaders(a.get('b'), headers(30));
  assert.equal(warned(a, 'x'), null, 'a reading below the step warns of nothing');
  a.noteUsageHeaders(a.get('b'), headers(95));
  assert.equal(warned(a, 'x'), '5h');
  // a thread nothing has placed yet, in a pool of three: which login serves it cannot be told
  assert.equal(a.servingLogin('new'), null);
  assert.equal(warned(a, 'new'), null);
  assert.equal(a.servingLogin(null), null);
  // a pin to an account that is gone is no pin
  a.pins.set('gone', { id: 'removed', at: Date.now() });
  assert.equal(a.servingLogin('gone'), null);
});

test('behind the relay with one subscription, requests pass through to the held login, so an unpinned thread is its', (t) => {
  const { a } = setup(t, { state: { active: 'default', accounts: [] }, homes: {} });
  a.relay = { stop() {}, dropSession() {} };
  a.applied = 'default';
  assert.equal(a.subscriptions().length, 1);
  a.onMainMessage(reading(window(90)));
  // the relay is on, so the app-server's own push is ignored (each pinned thread has its own login); the header reading counts
  assert.equal(a.get('default').limits, undefined);
  a.noteUsageHeaders(a.get('default'), headers(90));
  assert.equal(a.servingLogin('t1').id, 'default');
  assert.equal(warned(a, 't1'), '5h');
});

test('a login with no reading, or one the pool cannot say, gives no windows', (t) => {
  const { a } = setup(t, { state: { active: 'default', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  a.applied = 'default';
  assert.equal(new CodexDriver(a).chatLimits('t1'), null);
  a.mainMode = 'external';
  a.applied = null;
  assert.equal(a.heldLogin(), null);
  assert.equal(new CodexDriver(a).chatLimits('t1'), null);
});
