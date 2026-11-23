// IPC for MoMo's audit log and remembered approvals in Settings (electron/app/ipc/momoTrust.cjs, #2290, #2292), over a real
// audit log and sentinel file storage: the state (checks out, can't go on and why, no encryption), Export to a file the
// user picks (0600, exactly the log), Start a new log only when the log can't go on, Set aside only when the approvals
// can't be read, and every call refused while MoMo is off or before its services are made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act, fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { register, exportName } = require('../electron/app/ipc/momoTrust.cjs');
const { AuditLog, CURRENT, KEY_FILE } = require('../electron/momo/audit.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { sentinelFileStorage } = require('../electron/momo/sentinelStore.cjs');
const { SiteList } = require('../electron/momo/sentinelSites.cjs');
const { riskyUnasked } = require('../electron/app/momoSiteRisk.cjs');

function setup(o: { allowed?: boolean; started?: boolean } = {}) {
  const dir = scratch();
  const safe = fakeSafe();
  const audit = new AuditLog({ dir: path.join(dir, 'audit'), safeStorage: safe });
  const storage = sentinelFileStorage({ file: path.join(dir, 'approvals.bin'), safeStorage: safe });
  const sentinel = new Sentinel({ askUser: async () => null, allowed: () => true, storage, sites: new SiteList({ risky: riskyUnasked }) });
  const handlers = new Map<string, any>();
  const gate = { on: o.allowed ?? true };
  const live: any = o.started === false ? {} : { momo: { audit, sentinel } };
  const saves: any[] = [];
  const t: any = { dialog: { canceled: false, filePath: path.join(dir, 'export.jsonl') } };
  register(
    { handle: (ch: string, fn: any) => void handlers.set(ch, fn) },
    {
      live,
      dialog: { showSaveDialog: async (win: any, opts: any) => (saves.push([win, opts]), t.dialog) },
      BrowserWindow: { fromWebContents: (wc: any) => (wc === 'app' ? { id: 1 } : null) },
    },
    { allowed: () => gate.on, now: () => Date.UTC(2026, 9, 24, 12) },
  );
  const call = (ch: string, sender = 'app', arg?: unknown) => handlers.get(ch)({ sender }, arg);
  return Object.assign(t, { dir, safe, audit, sentinel, storage, handlers, gate, live, saves, call });
}

test('every call is refused while MoMo is off, and before its services are made', async () => {
  const off = setup({ allowed: false });
  assert.deepEqual(
    [...off.handlers.keys()],
    ['momoTrust:status', 'momoTrust:removeSite', 'momoTrust:exportAudit', 'momoTrust:startOverAudit', 'momoTrust:setAsideApprovals'],
  );
  for (const ch of off.handlers.keys()) assert.equal((await off.call(ch)).error.code, 'not_allowed', ch);
  const early = setup({ started: false });
  assert.deepEqual(await early.call('momoTrust:status'), { error: { message: "MoMo hasn't started yet.", code: 'not_started' } });
});

test('status: a log that checks out and readable approvals; nothing to start over or set aside then', async () => {
  const s = setup();
  await s.audit.intent(act);
  assert.deepEqual((await s.call('momoTrust:status')).value, { audit: { state: 'ok', entries: 1 }, approvals: { state: 'ok' }, sites: [] });
  assert.equal((await s.call('momoTrust:startOverAudit')).error.code, 'not_needed');
  assert.equal((await s.call('momoTrust:setAsideApprovals')).error.code, 'not_needed');
  assert.equal(
    fs.readdirSync(path.join(s.dir, 'audit')).some((n: string) => n.startsWith('set-aside-')),
    false,
    'nothing set aside',
  );
  await s.audit.close();
});

test('#3655: status lists the always-allowed sites; Remove forgets one; a bad site is refused', async () => {
  const s = setup();
  // a site the user chose Always allow for, through a tainted chat's open card
  s.sentinel.askUser = async () => ({ allow: true, scope: 'site' });
  s.sentinel.setSource('files', { level: 'read', private: true });
  s.sentinel.setSource('browser', { level: 'read' });
  await s.sentinel.decide({ chatId: 'a', tool: 'momo_files_read', source: 'files', kind: 'read' });
  const url = 'https://www.ycombinator.com/';
  const nav = {
    chatId: 'a',
    tool: 'chrome_navigate',
    source: 'browser',
    kind: 'read',
    args: { url },
    egress: { hosts: ['www.ycombinator.com'] },
    repeatable: true,
    opens: url,
  };
  assert.equal((await s.sentinel.decide(nav)).scope, 'site');
  assert.deepEqual((await s.call('momoTrust:status')).value.sites, ['www.ycombinator.com']);
  assert.equal((await s.call('momoTrust:removeSite', 'app', 3)).error.code, 'invalid');
  assert.equal((await s.call('momoTrust:removeSite', 'app', '')).error.code, 'invalid');
  assert.deepEqual((await s.call('momoTrust:removeSite', 'app', 'www.ycombinator.com')).value, { removed: true });
  assert.deepEqual((await s.call('momoTrust:removeSite', 'app', 'www.ycombinator.com')).value, { removed: false });
  assert.deepEqual((await s.call('momoTrust:status')).value.sites, []);
  await s.sentinel.close();
  await s.audit.close();
});

test('Export writes the log exactly as written, owner-only, to the file picked over the asking window', async () => {
  const s = setup();
  await s.audit.intent(act);
  assert.equal((await s.call('momoTrust:exportAudit', 'nope')).error.code, 'not_window');
  const r = await s.call('momoTrust:exportAudit');
  assert.deepEqual(r.value, { saved: 'export.jsonl' });
  assert.deepEqual(s.saves[0][0], { id: 1 });
  assert.equal(s.saves[0][1].defaultPath, 'MoMo audit log 2026-10-24.jsonl');
  const out = path.join(s.dir, 'export.jsonl');
  fs.chmodSync(out, 0o644);
  await s.call('momoTrust:exportAudit');
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(s.dir, 'audit', CURRENT), 'utf8'));
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  s.dialog = { canceled: true, filePath: undefined };
  assert.deepEqual((await s.call('momoTrust:exportAudit')).value, { saved: null });
  s.dialog = { canceled: false, filePath: '' };
  assert.deepEqual((await s.call('momoTrust:exportAudit')).value, { saved: null });
  assert.equal(exportName(0), 'MoMo audit log 1970-01-01.jsonl');
  await s.audit.close();
});

test('a lost key: the log can’t go on, Start a new log sets it aside, and the new one checks out', async () => {
  const s = setup();
  await s.audit.intent(act);
  await s.audit.close();
  fs.rmSync(path.join(s.dir, 'audit', KEY_FILE));
  const stuck = (await s.call('momoTrust:status')).value.audit;
  assert.equal(stuck.state, 'stuck');
  assert.deepEqual(stuck, { state: 'stuck', reason: "Its key is missing or can't be read, so it can't go on.", exportable: false });
  const { aside } = (await s.call('momoTrust:startOverAudit')).value;
  assert.match(aside, /^set-aside-\d+$/);
  assert.ok(fs.existsSync(path.join(s.dir, 'audit', aside, CURRENT)), 'the old log kept, untouched');
  assert.deepEqual((await s.call('momoTrust:status')).value.audit, { state: 'ok', entries: 1 });
  await s.audit.close();
});

test('a log that doesn’t check out says from which entry; no encryption says so and offers nothing', async () => {
  const s = setup();
  await s.audit.intent(act);
  await s.audit.intent(act);
  const file = path.join(s.dir, 'audit', CURRENT);
  const [first, second] = fs.readFileSync(file, 'utf8').split('\n');
  fs.writeFileSync(file, `${first.replace('"intent"', '"refusal"')}\n${second}\n`);
  assert.deepEqual((await s.call('momoTrust:status')).value.audit, { state: 'stuck', reason: "It doesn't check out.", exportable: true });
  s.safe.available = false;
  const noKeychain = { state: 'unavailable', reason: "Needs encryption, which this Mac can't offer now." };
  assert.deepEqual((await s.call('momoTrust:status')).value.audit, noKeychain);
  // the check itself finds encryption gone
  const gone = setup();
  gone.live.momo.audit = {
    available: () => true,
    verify: async () => Promise.reject(Object.assign(new Error('no'), { code: 'unavailable' })),
  };
  assert.deepEqual((await gone.call('momoTrust:status')).value.audit, noKeychain);
  const rejecting = (code: string) => ({
    available: () => true,
    verify: async () => Promise.reject(Object.assign(new Error('x'), { code })),
  });
  gone.live.momo.audit = rejecting('locked');
  assert.deepEqual((await gone.call('momoTrust:status')).value.audit, {
    state: 'unavailable',
    reason: 'Another MoPilot is using it.',
  });
  assert.equal((await gone.call('momoTrust:startOverAudit')).error.code, 'not_needed', 'a log another MoPilot holds is never set aside');
  gone.live.momo.audit = { available: () => true, verify: async () => ({ ok: false, entries: 9, reason: 'cut' }) };
  assert.deepEqual((await gone.call('momoTrust:status')).value.audit, {
    state: 'stuck',
    reason: 'Entries were cut from its end.',
    exportable: true,
  });
  gone.live.momo.audit = { available: () => true, verify: async () => Promise.reject('disk') };
  gone.live.momo.audit = { available: () => true, verify: async () => Promise.reject(Object.assign(new Error('x'), { code: 'corrupt' })) };
  assert.deepEqual((await gone.call('momoTrust:status')).value.audit, {
    state: 'stuck',
    reason: "Its end is damaged, so it can't go on.",
    exportable: true,
  });
  gone.live.momo.audit = { available: () => true, verify: async () => Promise.reject('disk') };
  const other = (await gone.call('momoTrust:status')).value.audit;
  assert.equal(other.state, 'unavailable', 'a read that failed now is said, and never offers a new log');
  assert.ok(!other.reason.includes('disk'), 'said in plain words, never the raw text');
  assert.equal((await gone.call('momoTrust:startOverAudit')).error.code, 'not_needed');
  await s.audit.close();
});

test('approvals that can’t be read are offered to be set aside; after it they start empty and read fine', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.dir, 'approvals.bin'), 'not sealed\n');
  assert.deepEqual((await s.call('momoTrust:status')).value.approvals, { state: 'unreadable' });
  const { keptAs } = (await s.call('momoTrust:setAsideApprovals')).value;
  assert.match(keptAs, /^approvals\.bin\.unreadable-\d+$/);
  assert.ok(fs.existsSync(path.join(s.dir, keptAs)), 'kept for the user');
  assert.deepEqual((await s.call('momoTrust:status')).value.approvals, { state: 'ok' });
  // storage with no set-aside
  s.live.momo.sentinel = {
    load: async () => undefined,
    loadError: new Error('remembered approvals in an unknown format'),
    setAsideStored: async () => null,
  };
  assert.deepEqual((await s.call('momoTrust:setAsideApprovals')).value, { keptAs: null });
  // not usable now (no encryption, or another MoPilot holds them): said, never offered to be set aside
  s.live.momo.sentinel = {
    load: async () => undefined,
    loadError: Object.assign(new Error('held by another MoPilot'), { code: 'locked' }),
  };
  assert.deepEqual((await s.call('momoTrust:status')).value.approvals, {
    state: 'unavailable',
    reason: 'Another MoPilot is using them.',
  });
  assert.equal((await s.call('momoTrust:setAsideApprovals')).error.code, 'not_needed');
  await s.storage.close();
  await s.audit.close();
});

test('a failure that is not an Error still comes back as a message, with no code', async () => {
  const s = setup();
  s.live.momo.sentinel = { load: async () => Promise.reject('disk') };
  s.live.momo.audit = { available: () => false };
  assert.deepEqual(await s.call('momoTrust:status'), { error: { message: 'disk', code: null } });
});
