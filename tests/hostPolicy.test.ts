// The Host's policy resolver (host/src/policy.mjs, plan U2): the stored owner layer, a corrupt store, ordering, the managed layer's lock and the ceiling check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { parseOwnerPolicy, policyGeneration } from '../shared/host/policy.mjs';

const doc = (d: object) => parseOwnerPolicy({ version: 1, ...d }, (m: string) => new Error(m));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-'));

test('with nothing stored the defaults apply, and the status has a generation', () => {
  const p = createPolicy({ dataDir: tmp() });
  const s = p.status();
  assert.equal(s.managed, false);
  assert.deepEqual(s.locked, []);
  assert.equal(s.generation, policyGeneration(doc({})));
  assert.equal(p.effective().doc.permissionMax, 'full-access');
  // the ceiling the chat families read at every turn follows the rules in force, from the first call on
  assert.equal(p.ceiling(), 'full-access');
  p.set(doc({ permissionMax: 'read-only' }));
  assert.equal(p.ceiling(), 'read-only');
});

test('an accepted owner document is kept across a restart (0600), and the later one replaces the earlier', () => {
  const dir = tmp();
  const a = createPolicy({ dataDir: dir });
  const first = a.set(doc({ permissionMax: 'auto-review' }));
  const second = a.set(doc({ permissionMax: 'default' }));
  assert.notEqual(first.generation, second.generation);
  assert.equal(fs.statSync(path.join(dir, 'policy.json')).mode & 0o777, 0o600);
  const b = createPolicy({ dataDir: dir });
  assert.equal(b.effective().doc.permissionMax, 'default');
  assert.equal(b.status().generation, second.generation);
});

test('a corrupt stored document is reported and the defaults apply; the next accepted one clears the problem', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'policy.json'), '{nope');
  const seen: string[] = [];
  const p = createPolicy({ dataDir: dir, report: (m: string) => seen.push(m) });
  assert.equal(p.effective().doc.permissionMax, 'full-access');
  assert.match(String(p.status().problem), /defaults apply/);
  assert.equal(seen.length, 1);
  p.set(doc({ permissionMax: 'default' }));
  assert.equal(p.status().problem, undefined);
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ version: 7 }));
  assert.match(String(createPolicy({ dataDir: dir }).status().problem), /defaults apply/, 'a document of another version is not trusted');
});

test('without a data dir the policy lasts for this run', () => {
  const p = createPolicy({});
  p.set(doc({ permissionMax: 'read-only' }));
  assert.equal(p.effective().doc.permissionMax, 'read-only');
});

test('the managed layer is merged, locked and reported', () => {
  let managed: any = null;
  const p = createPolicy({ dataDir: tmp(), managed: () => managed });
  p.set(doc({ permissionMax: 'full-access' }));
  managed = { permissionMax: 'default' };
  const s = p.status();
  assert.equal(s.managed, true);
  assert.deepEqual(s.locked, ['permissionMax']);
  assert.throws(
    () => p.checkMode('full-access', 'desktop'),
    (e: any) => e.code === 'policy_refused' && e.details.max === 'default',
  );
});

test('checkMode: the ceiling for every kind, and the phone cap on top of it', () => {
  const p = createPolicy({ dataDir: tmp() });
  p.checkMode('full-access', 'desktop');
  p.checkMode('full-access', 'cli');
  assert.throws(
    () => p.checkMode('full-access', 'phone'),
    (e: any) => e.code === 'policy_refused' && e.details.key === 'permissionMax' && e.details.max === 'auto-review',
  );
  p.checkMode('auto-review', 'phone');
  p.set(doc({ permissionMax: 'default' }));
  assert.throws(() => p.checkMode('auto-review', 'desktop'), /not allowed on this machine/);
  assert.throws(() => p.checkMode('bogus', 'desktop'), /bogus is not allowed/);
  p.checkMode('read-only', 'phone');
});

test('approvalSettings gives the approval engine the timings and the notification settings', () => {
  const p = createPolicy({});
  p.set(doc({ approvals: { pauseMinutes: 60 }, notify: { done: true } }));
  const s = p.approvalSettings();
  assert.deepEqual(s.approvals, { remindMinutes: 10, pauseMinutes: 60 });
  assert.equal(s.notify.done, true);
});

test('checkRequest looks at chat.start and chat.permit only; replace refuses a phone', () => {
  const p = createPolicy({});
  p.set(doc({ permissionMax: 'default' }));
  p.checkRequest('chat.start', {}, 'phone');
  p.checkRequest('chat.send', { permission: 'full-access' }, 'desktop');
  assert.throws(() => p.checkRequest('chat.start', { permission: 'full-access' }, 'desktop'), /policy_refused|not allowed/);
  assert.throws(() => p.checkRequest('chat.permit', { value: 'full-access' }, 'cli'), /not allowed/);
  assert.throws(
    () => p.replace({ doc: doc({}) }, 'phone'),
    (e: any) => e.code === 'policy_refused' && e.details.key === 'caller',
  );
  assert.equal(p.replace({ doc: doc({ permissionMax: 'read-only' }) }, 'cli').generation.length, 64);
});
