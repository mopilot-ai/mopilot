// E2E default-harness assertions read the real persisted preference and never turn missing or damaged state into Codex.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chats from '../electron/platform/chats.cjs';
import { savedDefaultHarness } from './e2e/fixtures/defaultHarness.ts';

const { patchPrefs, migrateDefaultHarness, flushPendingWrites } = chats;
// main writes the state behind: read the file once what it holds is on the disk
const saved = (h: Parameters<typeof savedDefaultHarness>[0]) => (flushPendingWrites(), savedDefaultHarness(h));

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-default-harness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);
  return { dir, file: path.join(userData, 'ui-state.json') };
}

test('E2E assertions observe the real preference writer for Codex, Claude and ACP without using legacy values', (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.file, JSON.stringify({ prefs: { harness: 'claude', basicHarness: 'kimi' }, sidebarOpen: false }));
  for (const defaultHarness of ['codex', 'claude', 'acp:opencode', 'acp:custom_2-cli']) {
    patchPrefs(h.file, { defaultHarness, model: 'unrelated' });
    assert.equal(saved(h), defaultHarness);
  }
  patchPrefs(h.file, {}, ['defaultHarness']);
  assert.throws(() => saved(h), /persisted defaultHarness/);
});

test('legacy migration seeds become assertable only after the real migration persists the canonical preference', (t) => {
  const h = fixture(t);
  for (const [prefs, expected] of [
    [{ harness: 'codex' }, 'codex'],
    [{ harness: 'claude' }, 'claude'],
    [{ harness: 'codex', basicHarness: 'kimi' }, 'acp:kimi'],
  ] as const) {
    fs.writeFileSync(h.file, JSON.stringify({ prefs }));
    assert.throws(() => saved(h), /persisted defaultHarness/);
    migrateDefaultHarness(h.file);
    assert.equal(saved(h), expected);
  }
});

test('missing, malformed and unreadable state never becomes a successful Codex persistence assertion; a later read can recover', (t) => {
  const h = fixture(t);
  assert.throws(() => saved(h), { code: 'ENOENT' });
  for (const raw of ['', '{', '{"prefs":{"defaultHarness":"codex"']) {
    fs.writeFileSync(h.file, raw);
    assert.throws(() => saved(h), SyntaxError);
    assert.equal(fs.readFileSync(h.file, 'utf8'), raw, 'the reader never rewrites corrupt state');
  }
  const failure = Object.assign(new Error('cannot read saved preferences'), { code: 'EACCES' });
  const read = t.mock.method(fs, 'readFileSync', () => {
    throw failure;
  });
  assert.throws(
    () => saved(h),
    (error) => error === failure,
  );
  read.mock.restore();
  fs.writeFileSync(h.file, JSON.stringify({ prefs: { defaultHarness: 'codex' } }));
  assert.equal(saved(h), 'codex');
});

test('missing, null, wrong-shaped and invalid preference values fail without changing the snapshot', (t) => {
  const h = fixture(t);
  const malformed = [
    null,
    [],
    1,
    true,
    'codex',
    {},
    ...[null, [], 1, true, 'codex', {}].map((prefs) => ({ prefs })),
    ...[null, [], {}, 0, true, '', 'unknown', 'acp:'].map((defaultHarness) => ({ prefs: { defaultHarness } })),
  ];
  for (const state of malformed) {
    const raw = JSON.stringify(state);
    fs.writeFileSync(h.file, raw);
    assert.throws(() => saved(h), /persisted defaultHarness/, raw);
    assert.equal(fs.readFileSync(h.file, 'utf8'), raw);
  }
});

test('each read uses its own harness directory and current snapshot, retaining extra fields and accepted JSON formatting', (t) => {
  const a = fixture(t);
  const b = fixture(t);
  fs.writeFileSync(a.file, ' { "prefs" : { "defaultHarness" : "co\\u0064ex" }, "future" : [] } \n');
  patchPrefs(b.file, { defaultHarness: 'claude' });
  assert.equal(saved(a), 'codex');
  assert.equal(saved(b), 'claude');
  patchPrefs(a.file, { defaultHarness: 'acp:kimi' });
  assert.equal(saved(a), 'acp:kimi');
  assert.equal(saved(b), 'claude');
});
