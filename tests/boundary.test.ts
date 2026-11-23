// Components read capability keys, not harness names. These counts may only go down; when one does,
// lower its ceiling here. components/harness/<kind>/* is exempt (pages that belong to one harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['src/components/', 'src/store/'];

const ROOT = join(import.meta.dirname, '..', 'src', 'components');
const EXEMPT = join(ROOT, 'harness');

const CEILING = {
  /** lines comparing against a harness literal: === 'claude', 'codex' !==, case 'claude': … */
  harnessLiterals: 0,
  /** harnessOfThread(...) calls */
  harnessOfThread: 0,
  /** CLAUDE_PREFIX uses */
  claudePrefix: 0,
  /** component files that import rpc (the app-server connection is main's: electron/harness/codex.cjs) */
  rpcImports: 0,
  /** component lines that call an app-server method by name through the adapter proxy (WP7: runSemantic) */
  codexRequests: 0,
};

const LITERAL = String.raw`['"\x60](?:codex|claude|acp:[^'"\x60]*)['"\x60]`;
const COMPARE = new RegExp(String.raw`[!=]==?\s*${LITERAL}|${LITERAL}\s*[!=]==?|\bcase\s+${LITERAL}`);
const IMPORT_RPC = /\bimport\s*\{[^}]*\brpc\b[^}]*\}\s*from\b|\bimport\s+rpc\b/;

const files = (dir: string): string[] => treeFiles(dir, /\.(tsx?|jsx?)$/, { skip: (p) => p === EXEMPT });

function count() {
  const hits: Record<keyof typeof CEILING, string[]> = {
    harnessLiterals: [],
    harnessOfThread: [],
    claudePrefix: [],
    rpcImports: [],
    codexRequests: [],
  };
  for (const f of files(ROOT)) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f);
    if (IMPORT_RPC.test(src)) hits.rpcImports.push(rel);
    src.split('\n').forEach((line, i) => {
      if (/^\s*import\b/.test(line)) return;
      const at = `${rel}:${i + 1}`;
      if (COMPARE.test(line)) hits.harnessLiterals.push(at);
      for (const _ of line.matchAll(/\bharnessOfThread\s*\(/g)) hits.harnessOfThread.push(at);
      for (const _ of line.matchAll(/\bCLAUDE_PREFIX\b/g)) hits.claudePrefix.push(at);
      if (/\bcodexRequest\s*\(/.test(line)) hits.codexRequests.push(at);
    });
  }
  return hits;
}

const hits = count();
for (const key of Object.keys(CEILING) as (keyof typeof CEILING)[]) {
  test(`src/components boundary: ${key}`, () => {
    const n = hits[key].length;
    const max = CEILING[key];
    assert.ok(n <= max, `${key} went up to ${n} (ceiling ${max}). Read caps instead of naming a harness:\n  ${hits[key].join('\n  ')}`);
    assert.ok(n >= max, `${key} went down to ${n}. Lower its ceiling in tests/boundary.test.ts from ${max} to ${n}.`);
  });
}

// The store and the harness modules name what they want from Codex (src/harness/adapters/codexApi.ts,
// methods of the adapter in main), not an app-server method by string. Only the generic passthrough
// `codexRequest` takes a method name, and these files don't use it.
const SRC = join(ROOT, '..');
const STORE_MODULES = readdirSync(join(SRC, 'store'))
  .filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'))
  .map((f) => `store/${f}`);
const NAMED_ONLY = [...STORE_MODULES, 'harness/codexCatalog.ts', 'session/harness/switch.ts', 'session/harness/mcpRows.ts'];

test('src/store and the harness modules call Codex by name, not by app-server method', () => {
  const hits: string[] = [];
  for (const f of NAMED_ONLY)
    readFileSync(join(SRC, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/^\s*import\b/.test(line) && /\bcodexRequest\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      });
  assert.deepEqual(
    hits,
    [],
    `codexRequest( came back in:\n  ${hits.join('\n  ')}\nAdd a named call to CodexAdapter (electron/harness/codex.cjs, CODEX_API) and codexApi instead.`,
  );
});

test('the boundary scan sees the components tree', () => {
  assert.ok(STORE_MODULES.includes('store/core.ts') && STORE_MODULES.includes('store/send.ts'));
  assert.ok(files(ROOT).some((f) => f.endsWith('Composer.tsx')));
  assert.ok(COMPARE.test(`if (h === 'claude') x();`));
  assert.ok(COMPARE.test(`'codex' !== kind`));
  assert.ok(COMPARE.test(`case "acp:kimi":`));
  assert.ok(!COMPARE.test(`const label = 'claude';`));
  assert.ok(IMPORT_RPC.test(`import { rpc } from '../lib/rpc';`));
  assert.ok(IMPORT_RPC.test(`import { request, rpc as r } from "../../lib/rpc";`));
});
