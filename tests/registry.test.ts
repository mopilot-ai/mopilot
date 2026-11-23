// Harness registry: two first-tier entries and the basic harnesses over ACP.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { REGISTRY, harnessInfo, harnessesByTier } = await import('../src/harness/registry.ts');
const { isFirstTier, SEMANTICS } = await import('../src/harness/adapter.ts');
const { ACP_PUBLIC_IDS } = await import('../shared/harnessCatalog.mjs');

test('codex and claude are first tier with their own channels', () => {
  assert.deepEqual(
    harnessesByTier('first').map((h) => h.kind),
    ['codex', 'claude'],
  );
  assert.equal(harnessInfo('codex')!.channel, 'app-server');
  assert.equal(harnessInfo('claude')!.channel, 'agent-sdk');
  assert.equal(harnessInfo('claude')!.resumeCommand('abc'), 'claude --resume abc');
  assert.ok(isFirstTier('codex') && isFirstTier('claude') && !isFirstTier('acp:kimi'));
});

test('the supported basic harnesses run over ACP, each with bins and a quirks id', () => {
  const basic = harnessesByTier('basic');
  assert.deepEqual(
    basic.map((h) => h.kind),
    ACP_PUBLIC_IDS.map((id) => `acp:${id}`),
  );
  for (const h of basic) {
    assert.equal(h.channel, 'acp');
    assert.ok(h.detect.bins.length > 0, h.kind);
    assert.equal(`acp:${h.quirks}`, h.kind);
    assert.equal(h.resumeCommand('x'), h.kind === 'acp:opencode' ? 'opencode --session x' : null);
  }
});

test('every entry is keyed by its kind', () => {
  for (const [k, h] of Object.entries(REGISTRY)) assert.equal(h.kind, k);
  assert.equal(harnessInfo('acp:unknown'), null);
});

test('a basic harness declares its privacy defaults and admission check, or has none to offer', () => {
  const declared = (kind: Parameters<typeof harnessInfo>[0]) => {
    const h = harnessInfo(kind)!;
    return !!h.privacyDefaults && !!h.admission && !!h.quirks;
  };
  assert.equal(declared('acp:dsh'), true);
  assert.equal(harnessInfo('acp:dsh')!.admission!.privacyGate, '--dump-config');
  assert.equal(declared('acp:kimi'), true);
});

test('each semantic is listed once', () => {
  assert.equal(new Set(SEMANTICS).size, SEMANTICS.length);
});

test('each basic harness lists the same instruction files in its registry entry and its quirks file', async () => {
  const { createRequire } = await import('node:module');
  const quirks = createRequire(import.meta.url)('../electron/harness/quirks/index.cjs');
  for (const h of harnessesByTier('basic')) assert.deepEqual(h.instructionsFiles, quirks.quirks(h.quirks).instructionsFiles ?? [], h.kind);
});

test('thread project id namespace follows the native session owner on every harness', async () => {
  const { threadProjectIdField } = await import('../src/harness/registry.ts');
  const { noteOwner } = await import('../src/harness/ownership.ts');
  assert.equal(threadProjectIdField('codex-project-thread'), 'codexId');
  noteOwner('local-project-thread', 'claude');
  assert.equal(threadProjectIdField('local-project-thread'), 'id');
  for (const h of harnessesByTier('basic')) assert.equal(threadProjectIdField(`${h.kind}:project-thread`), 'id');
});
