// Ownership comes from the segment record (electron/session/contract/route.cjs): ids never decide who a chat goes to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { familyOf, byFamily, parseAcpKey } = require('../electron/session/contract/route.cjs');
const { assertCodexRef } = require('../electron/harness/codexRef.cjs');

test('kinds: codex, claude and acp:<harness> are known, anything else is an error', () => {
  assert.equal(familyOf('codex'), 'codex');
  assert.equal(familyOf('claude'), 'claude');
  assert.equal(familyOf('acp:kimi'), 'acp');
  for (const bad of ['acp', 'acp:', 'acp:a:b', 'gemini', '', undefined, null])
    assert.throws(() => familyOf(bad as any), /Unknown harness kind/);
});

test("a per-family table answers for a segment kind's family, and an unknown kind is an error", () => {
  const table = { codex: 'c', claude: 'l', acp: null };
  assert.equal(byFamily(table, 'codex'), 'c');
  assert.equal(byFamily(table, 'claude'), 'l');
  assert.equal(byFamily(table, 'acp:kimi'), null);
  assert.throws(() => byFamily(table, 'acp:kimi:s1'), /Unknown harness kind/);
});

test('acp keys are acp:<harness>:<id> and the id may hold colons', () => {
  assert.deepEqual(parseAcpKey('acp:kimi:s:1'), { harness: 'kimi', id: 's:1' });
  assert.equal(parseAcpKey('claude:abc'), null);
  assert.equal(parseAcpKey('019a-bare'), null);
});

test('the rpc layer refuses a ref that is not Codex, or whose id belongs to another harness', () => {
  assert.doesNotThrow(() => assertCodexRef({ kind: 'codex', id: '019a-b' }));
  assert.throws(() => assertCodexRef({ kind: 'claude', id: 's1' }), /Not a Codex session/);
  assert.throws(() => assertCodexRef({ kind: 'acp:kimi', id: 's1' }), /Not a Codex session/);
  assert.throws(() => assertCodexRef({ kind: 'codex', id: 'claude:s1' }), /Refusing/);
  assert.throws(() => assertCodexRef({ kind: 'codex', id: 'acp:kimi:s1' }), /Refusing/);
  assert.throws(() => assertCodexRef(null), /Not a Codex session/);
});
