// The sources hub's decide and audit over MoMo's trust layer (electron/momo/sourceTrust.cjs): the sentinel decides
// each read at the hub's level, as private data; the audit log records a refusal, or an intent and its outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog, fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { sourceDecide, sourceAudit } = require('../electron/momo/sourceTrust.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');
const { SourcesHub } = require('../electron/momo/sources/hub.cjs');

const entries = (dir: string) =>
  fs
    .readFileSync(path.join(dir, CURRENT), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('a read is decided by the sentinel at the level the hub holds, and taints the chat', async () => {
  const s = new Sentinel({ askUser: async () => null, allowed: () => true });
  const decide = sourceDecide(s);
  const call = { kind: 'source.read', source: 'calendar', action: 'events', chatId: 'c1', summary: 'today', private: true };
  assert.deepEqual(await decide({ ...call, level: 'read' }), { allow: true });
  assert.deepEqual(s.taintOf('c1'), ['calendar']);
  assert.equal(s.sources.get('calendar').name, 'Calendar');
  assert.deepEqual(await decide({ ...call, level: 'blocked' }), { allow: false, reason: 'blocked' });
});

test('the audit log gets a refusal, or an intent and its outcome', async () => {
  const log: any[] = [];
  const audit = sourceAudit({
    refusal: async (f: any) => log.push(['refusal', f]),
    intent: async (f: any) => (log.push(['intent', f]), { id: 'i1' }),
    outcome: async (id: string, o: any) => log.push(['outcome', id, o]),
  });
  const e = { source: 'files', action: 'read', chatId: 'c1', summary: 's' };
  // no identity given, and an entry without arguments: still named, with empty arguments for the digest
  const plain = { action: 'files.read', chatId: 'c1', args: { action: 'read', args: null } };
  await audit.append({ ...e, decision: 'refused', result: 'refused', reason: 'blocked' });
  await audit.append({ ...e, decision: 'refused', result: 'refused' });
  await audit.append({ ...e, decision: 'allowed', result: 'done', count: 2 });
  await audit.append({ ...e, decision: 'allowed', result: 'failed', reason: 'outside' });
  await audit.append({ ...e, decision: 'allowed', result: 'failed' });
  assert.deepEqual(log, [
    ['refusal', { ...plain, decision: 'blocked' }],
    ['refusal', { ...plain, decision: 'refused' }],
    ['intent', { ...plain, decision: 'allowed' }],
    ['outcome', 'i1', { result: 'done', note: '' }],
    ['intent', { ...plain, decision: 'allowed' }],
    ['outcome', 'i1', { result: 'not sent', note: 'outside' }],
    ['intent', { ...plain, decision: 'allowed' }],
    ['outcome', 'i1', { result: 'not sent', note: 'failed' }],
  ]);
});

test("#2284: each entry names the chat's harness and account, and digests what the read named, so two reads differ", async () => {
  const t = auditLog();
  const identity = (chatId: string) => (chatId === 'c1' ? { harness: 'acp:opencode', account: 'work' } : {});
  const audit = sourceAudit(t.log, identity);
  const e = { source: 'files', action: 'files.read', chatId: 'c1', summary: 'read one file', decision: 'allowed', result: 'done' };
  await audit.append({ ...e, args: { path: '~/bb-files/budget.txt' } });
  await audit.append({ ...e, args: { path: '~/bb-files/other.txt' } });
  await audit.append({ ...e, decision: 'refused', result: 'refused', reason: 'blocked', args: { path: '~/bb-files/budget.txt' } });
  const [first, , second, , refusal] = entries(t.dir);
  for (const x of [first, second, refusal]) assert.deepEqual([x.harness, x.account], ['acp:opencode', 'work']);
  assert.notEqual(first.args, second.args, 'two files, two digests');
  assert.equal(first.args, refusal.args, 'the same read, the same digest');
  assert.doesNotMatch(fs.readFileSync(path.join(t.dir, CURRENT), 'utf8'), /budget\.txt/, 'the path is kept as a digest only');
  // the sentinel sees the read's harness, account and arguments too: two reads are two actions
  const s = new Sentinel({ askUser: async () => null, allowed: () => true });
  const seen: any[] = [];
  const spy = { setSource: s.setSource.bind(s), decide: async (c: any) => (seen.push(c), s.decide(c)) };
  await sourceDecide(spy, identity)({ ...e, level: 'read', args: { path: 'a' } });
  assert.deepEqual(
    [seen[0].harness, seen[0].account, seen[0].args],
    ['acp:opencode', 'work', { action: 'files.read', args: { path: 'a' } }],
  );
});

test('#2284: the sources hub hands each read its arguments for the audit entry', async () => {
  const appended: any[] = [];
  const hub = new SourcesHub({
    dir: scratch(),
    safeStorage: fakeSafe(),
    allowed: () => true,
    decide: () => ({ allow: true }),
    audit: { append: (x: any) => appended.push(x) },
  });
  hub.connect('files');
  await hub.read({ source: 'files', action: 'files.read', chatId: 'c1', summary: 'read one file', args: { path: 'p' } }, async () => ({
    count: 1,
  }));
  await hub.read({ source: 'files', action: 'files.list', chatId: 'c1', summary: 'list' }, async () => ({ count: 0 }));
  assert.deepEqual(
    appended.map((x) => x.args),
    [{ path: 'p' }, undefined],
  );
});
