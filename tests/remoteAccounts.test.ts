// A phone reads every login of each harness with its sign-in state and the auto-switch setting, and changes auto-switch through the Mac's own accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { readPhoneAccounts, setPhoneAutoSwitch } = require('../electron/remote/accounts.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const inst = (account: string, o: any = {}) => ({ account, label: null, status: 'ok', billing: 'subscription', active: false, ...o });
function registry(rows: Record<string, any[]>, policy: Record<string, any> = {}) {
  return {
    instances: (h: string) => rows[h] ?? [],
    driver: (h: string) => ({ poolPolicy: policy[h] ?? { pool: 'single', autoSwitch: true } }),
  };
}

test('every login of Claude Code and Codex is listed with its state; a harness with no login and ACP are left out', () => {
  const live = {
    identity: registry(
      {
        claude: [inst('work', { label: 'Work', active: true }), inst('old', { status: 'signedOut' })],
        codex: [inst('a', { label: 'a@x.com', limited: true }), inst('b', { status: 'expired', billing: 'apiKey' })],
        acp: [inst('kimi')],
      },
      { codex: { pool: 'spread', autoSwitch: false } },
    ),
  };
  assert.deepEqual(readPhoneAccounts(live), {
    scope: 'local',
    harnesses: [
      { harness: 'claude', autoSwitch: true, pool: 'single' },
      { harness: 'codex', autoSwitch: false, pool: 'spread' },
    ],
    accounts: [
      { harness: 'claude', account: 'work', label: 'Work', status: 'ok', billing: 'subscription', active: true, limited: false },
      { harness: 'claude', account: 'old', label: 'old', status: 'signedOut', billing: 'subscription', active: false, limited: false },
      { harness: 'codex', account: 'a', label: 'a@x.com', status: 'ok', billing: 'subscription', active: false, limited: true },
      { harness: 'codex', account: 'b', label: 'b', status: 'expired', billing: 'apiKey', active: false, limited: false },
    ],
  });
  assert.deepEqual(readPhoneAccounts({ identity: registry({}) }), { scope: 'local', harnesses: [], accounts: [] });
  assert.throws(() => readPhoneAccounts({}), /not ready/);
});

test('auto-switch is set on the harness’s own accounts; an unknown harness or a Mac without them is refused', () => {
  const calls: any[] = [];
  const pool = (n: string) => ({ setAutoSwitch: (on: boolean) => calls.push([n, on]) });
  const live = { accounts: pool('codex') };
  assert.deepEqual(setPhoneAutoSwitch(live, { accounts: () => pool('claude') }, { harness: 'claude', on: false }), {
    harness: 'claude',
    autoSwitch: false,
  });
  assert.deepEqual(setPhoneAutoSwitch(live, {}, { harness: 'codex', on: true }), { harness: 'codex', autoSwitch: true });
  assert.deepEqual(calls, [
    ['claude', false],
    ['codex', true],
  ]);
  assert.throws(() => setPhoneAutoSwitch(live, {}, { harness: 'claude', on: true }), /not available/);
  assert.throws(() => setPhoneAutoSwitch(live, {}, { harness: 'acp', on: true }), /not available/);
});

test('accounts.get and accounts.autoSwitch run through the service; bad params and an older Mac are refused', async () => {
  const seen: any[] = [];
  const r = rig({
    ops: {
      accounts: () => ({ scope: 'local', accounts: [] }),
      setAutoSwitch: (p: any) => (seen.push(p), { harness: p.harness, autoSwitch: p.on }),
    },
  });
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('accounts.get')), { scope: 'local', accounts: [] });
  assert.deepEqual(ok(await p.ask('accounts.autoSwitch', { harness: 'codex', on: false })), { harness: 'codex', autoSwitch: false });
  assert.deepEqual(seen, [{ harness: 'codex', on: false }]);
  for (const bad of [{ harness: '', on: true }, { on: true }, { harness: 'codex' }]) {
    const res = await p.ask('accounts.autoSwitch', bad);
    assert.equal(res.ok, false);
  }
  const old = rig({ ops: { accounts: () => ({}) } });
  const res = await old.phone('p1').ask('accounts.autoSwitch', { harness: 'codex', on: true });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /Update MoPilot/);
});

test('the dev host’s fake app answers both calls, and a changed auto-switch shows in the next read', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  assert.deepEqual(
    app.ops.accounts().accounts.map((a: any) => a.status),
    ['ok', 'ok', 'signedOut', 'ok', 'ok', 'ok', 'signedOut', 'ok'],
  );
  assert.deepEqual(app.ops.setAutoSwitch({ harness: 'codex', on: false }), { harness: 'codex', autoSwitch: false });
  assert.deepEqual(app.ops.setAutoSwitch({ harness: 'codex', on: true }), { harness: 'codex', autoSwitch: true });
  app.ops.setAutoSwitch({ harness: 'codex', on: false });
  assert.deepEqual(
    app.ops.accounts().harnesses.map((h: any) => h.autoSwitch),
    [true, false],
  );
});
