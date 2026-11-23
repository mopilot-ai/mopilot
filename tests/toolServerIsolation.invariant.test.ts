// Whole-repository rule (#2311, #2302): a chat holds its own process unless its harness's quirks claim `mcpScope: 'session'` with a proof, and every
// place that authorizes an ACP tool call against a chat's server goes through the one foreign-call check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

test('no harness claims per-session MCP servers without a test on the fake agent; the rest hold a process per chat', () => {
  const dir = path.join(root, 'electron/harness/quirks');
  const proof = read('tests/acpToolServerIsolation.test.ts');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.cjs') && n !== 'index.cjs')) {
    const q = require(path.join(dir, f));
    if (q.mcpScope === undefined) continue;
    assert.equal(q.mcpScope, 'session', f);
    assert.ok(proof.includes(f.replace(/\.cjs$/, '')), `${f} claims session-scoped MCP servers without a proof`);
  }
  assert.equal(require('../electron/harness/quirks/opencode.cjs').mcpScope, undefined, 'opencode shares MCP servers per folder');
});

test('every ACP path that lets a tool call through checks the caller’s own server first', () => {
  // the permission answer and the live update both call isForeignSageCall with the chat's own serverName
  for (const f of ['electron/harness/acp/permission.cjs', 'electron/harness/acp/sessionUpdates.cjs']) {
    assert.match(read(f), /isForeignSageCall\([^)]*chat\.serverName\)/, f);
  }
  // the permission check for an own call comes after the foreign refusal
  const perm = read('electron/harness/acp/permission.cjs');
  assert.ok(perm.indexOf('isForeignSageCall(') < perm.indexOf('isSageToolCall(params'));
});

test('a chat holds a process alone exactly when it is kept apart or its harness shares MCP servers per folder', () => {
  const src = read('electron/harness/acp.cjs');
  assert.match(src, /chat\.own = chat\.isolated \|\| this\.quirksOf\(chat\.harness\)\?\.mcpScope !== 'session'/);
  assert.match(src, /if \(chat\.own\) releaseOwn\(this, key\)/);
});
