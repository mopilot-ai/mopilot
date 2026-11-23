// The dev host answers the same phone usage route and parser as a Mac, with explicitly simulated account windows and a refreshable clock.
import './support/phone/register.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
const require = createRequire(import.meta.url);
const { RemoteService } = require('../electron/remote/service.cjs');
const usagePath = '../mobile/src/remote/usage.ts';
const { parseUsage } = await import(usagePath);

test('dev host usage passes the actual remote route and phone parser for both harnesses; refresh dates the new reading', async () => {
  let at = 5000000;
  const app = createFakeApp({ repo: '/repo', now: () => at, log: () => {}, sleep: async () => {}, status: async () => '' });
  const service = new RemoteService({ ops: app.ops });
  const phone = { kind: 'phone', pairId: 'demo', follows: new Set() };
  const read = () => service.call(phone, 'usage.get', { refresh: true });
  const before = await read();
  assert.equal(before.scope, 'local');
  const rows = parseUsage(before);
  // each harness offers the same four stand-in logins: one in use, one more signed in, one signed out, one at its limit
  for (const harness of ['claude', 'codex']) {
    const mine = rows.filter((row: any) => row.harness === harness);
    assert.deepEqual(
      mine.map((row: any) => [row.account, row.active, row.state]),
      [
        ['work', true, 'available'],
        ['personal', false, 'available'],
        ['old', false, 'signin'],
        ['spare', false, 'available'],
      ],
    );
    assert.deepEqual(
      mine[0].windows.map((w: any) => [w.label, w.usedPercent, w.at, w.stale, w.resetsAt]),
      [
        ['5h', 42, at, false, at / 1000 + 3600],
        ['Weekly', 10, at, false, at / 1000 + 86400],
      ],
    );
    assert.deepEqual(mine[2].windows, []);
    assert.equal(mine[3].windows[0].usedPercent, 100, 'the login at its limit has nothing left');
  }
  at += 60000;
  const after = parseUsage(await read());
  assert.equal(after[0].windows[0].at, at);
  assert.equal(rows[0].windows[0].at, at - 60000, 'a later fixture read cannot mutate the previous result');
});
