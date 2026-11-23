// Edge cases of small main-process helpers: diagnostics text, Quick Chat state and
// readiness, Claude transcript tails, and the per-install id.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDiagnostics } = require('../electron/support/diagnostics.cjs');
const { QuickChatState, QuickChatRequests, rendererReadiness } = require('../electron/session/quickChat.cjs');
const { tail, tipOf, ownTipOf, cliUserLine } = require('../electron/harness/claude/transcriptStep.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grpd-'));

test('diagnostics: optional fields are omitted, a captured shell and unset variables read plainly', () => {
  const minimal = buildDiagnostics({ version: '1.0.0', platform: 'linux' });
  assert.equal(minimal, 'MoPilot 1.0.0\nlinux\n\nHarnesses\n\nEnvironment');
  const text = buildDiagnostics({
    version: '1',
    platform: 'darwin',
    versions: {},
    envStatus: { captured: true, error: null },
    env: { EMPTY: undefined, B: 'x' },
  });
  assert.match(text, /Login shell environment: captured/);
  assert.match(text, /\n {2}B=x\n {2}EMPTY=$/);
  assert.match(
    buildDiagnostics({ version: '1', platform: 'p', envStatus: { captured: false, error: null } }),
    /environment: not captured\n/,
  );
});

test('Quick Chat state: unknown threads and non-string text read as empty; invalid saves throw', () => {
  const file = path.join(tmp(), 'qc.json');
  const chats = new Set(['t1']);
  const s = new QuickChatState(file, (id: string) => chats.has(id));
  assert.deepEqual(s.read(), { threadId: null, text: '' });
  fs.writeFileSync(file, JSON.stringify({ threadId: 'gone', text: 5 }));
  assert.deepEqual(s.read(), { threadId: null, text: '' });
  assert.deepEqual(s.save({ threadId: 't1', text: 'hi' }), { threadId: 't1', text: 'hi' });
  assert.deepEqual(s.read(), { threadId: 't1', text: 'hi' });
  assert.equal(s.owns('t1'), true);
  assert.equal(s.owns(1), false);
  assert.deepEqual(s.save({ threadId: null, text: '' }), { threadId: null, text: '' });
  for (const bad of [
    null,
    { threadId: null, text: 1 },
    { threadId: 'nope', text: '' },
    { threadId: 3, text: '' },
    { threadId: null, text: 'x'.repeat(1_000_001) },
  ]) {
    assert.throws(() => s.save(bad), /Invalid Quick Chat state/);
  }
});

test('renderer readiness: marking an id nobody waits for, waits that resolve, and a wait that times out', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rendererReadiness();
    r.mark('a');
    await r.wait('a');
    r.forget('a');
    const both = Promise.all([r.wait('a'), r.wait('a')]);
    r.mark('a');
    await both;
    const late = r.wait('b');
    const other = r.wait('b');
    mock.timers.tick(30_000);
    await assert.rejects(late, /still starting/);
    await assert.rejects(other, /still starting/);
    r.mark('b'); // nothing pending any more
  } finally {
    mock.timers.reset();
  }
});

test('Quick Chat requests: invalid items throw, retries reuse the result, the cache keeps the newest 256', async () => {
  const q = new QuickChatRequests();
  for (const bad of [null, { id: '', text: '' }, { id: 'x'.repeat(129), text: '' }, { id: 'a', text: 1 }, { id: 1, text: '' }]) {
    assert.throws(() => q.send('c', bad, () => 1), /Invalid Quick Chat request/);
  }
  let n = 0;
  const receipt = () => ({ action: 'started', id: String(++n) });
  assert.equal((await q.send('c', { id: 'r0', text: '' }, receipt)).id, '1');
  assert.equal((await q.send('c', { id: 'r0', text: '' }, receipt)).id, '1');
  for (let i = 1; i <= 256; i++) await q.send('c', { id: `r${i}`, text: '' }, receipt);
  assert.equal(q.once.sends.size, 256);
  assert.equal(q.once.sends.has('c:r0'), false);
  assert.equal((await q.send('c', { id: 'r0', text: '' }, () => ({ action: 'started', id: 'again' }))).id, 'again');
});

const line = (o: any) => JSON.stringify(o);

test('transcript tail: missing file, broken lines, a long file read in growing windows', () => {
  assert.deepEqual(tail(path.join(tmp(), 'none.jsonl')), []);
  assert.equal(tipOf(''), null);
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  const pad = 'x'.repeat(300 * 1024);
  fs.writeFileSync(
    f,
    [
      line({ type: 'user', uuid: 'u1', message: { content: 'hi' } }),
      line({ type: 'assistant', uuid: 'pad', pad }),
      '{"type":"user", broken',
      line({ type: 'assistant', uuid: 'a2', isSidechain: true }),
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    tail(f, 2).map((r: any) => r.uuid),
    ['u1', 'pad'],
  );
});

test('ownTipOf: a chain of CLI-written user lines that never reaches a seen message is behind', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    f,
    [
      line({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text' }] }, parentUuid: 'missing' }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: [{ type: 'tool_result' }] } }),
    ].join('\n'),
  );
  assert.equal(ownTipOf(f, new Set()), false);
  fs.writeFileSync(
    f,
    [
      line({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true }),
    ].join('\n'),
  );
  assert.equal(ownTipOf(f, new Set()), false);
  assert.equal(ownTipOf(f, new Set(['u1'])), 'u2');
  assert.equal(cliUserLine({ message: { content: [{ type: 'text', text: null }] } }), false);
});

test('installId: reuses a valid saved id, replaces a bad one, survives an unwritable folder, and caches', () => {
  const fresh = () => {
    delete require.cache[require.resolve('../electron/platform/install.cjs')];
    return require('../electron/platform/install.cjs');
  };
  const dir = tmp();
  const saved = '0123abcd-0123-4567-89ab-0123456789ab';
  fs.writeFileSync(path.join(dir, 'install-id'), `${saved}\n`);
  const a = fresh();
  assert.equal(a.installId(dir), saved);
  assert.equal(a.installId('/elsewhere'), saved);
  // the MoPilot service's origin where the build has it (electron/platform/mopilotEndpoints.cjs), else none
  assert.equal(a.API_BASE, require('../electron/platform/mopilotEndpoints.cjs').endpoints?.API_BASE ?? null);

  fs.writeFileSync(path.join(dir, 'install-id'), 'garbage');
  const id = fresh().installId(dir);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notEqual(id, saved);
  assert.equal(fs.readFileSync(path.join(dir, 'install-id'), 'utf8'), id);

  const nowhere = path.join(dir, 'missing', 'deeper');
  assert.match(fresh().installId(nowhere), /^[0-9a-f-]{36}$/);
  assert.equal(fs.existsSync(nowhere), false);
});

test('installId: an id file that cannot be read is recorded and replaced; one that cannot be replaced is recorded too', () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  const fresh = () => {
    delete require.cache[require.resolve('../electron/platform/install.cjs')];
    return require('../electron/platform/install.cjs');
  };
  const dir = tmp();
  // a folder where the file should be: EISDIR on read
  fs.mkdirSync(path.join(dir, 'install-id'));
  assert.match(fresh().installId(dir), /^[0-9a-f-]{36}$/);
  assert.ok(recentIgnored().some((e: any) => e.context === 'read the install id' && /EISDIR/.test(e.message)));
  assert.ok(
    recentIgnored().some((e: any) => e.context === 'save the install id'),
    'a folder in its place cannot be replaced',
  );
  // an unreadable file is replaced, so the next launch reads the same id
  const other = tmp();
  const file = path.join(other, 'install-id');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o000);
  const id = fresh().installId(other);
  assert.equal(fresh().installId(other), id);
});
