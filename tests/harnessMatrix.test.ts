// The generated harness matrices (scripts/gen-matrix.mjs, WP10-2) and the registry's versions (WP10-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const GUARDS = [
  'conformance/',
  'docs/harness-matrix.md',
  'electron/harness/',
  'shared/',
  'src/harness/',
  'tests/conformance/results/',
];

const require = createRequire(import.meta.url);
const { compareVersions } = require('../electron/harness/versions.cjs');
const gen = await import('../scripts/gen-matrix.mjs');
const { loadAdmission } = await import('../scripts/harness-admission-records.mjs');
const { REGISTRY } = await import('../src/harness/registry.ts');

test('the committed matrices are what the generator produces (run npm run harness-matrix)', async () => {
  const m = await gen.buildMatrix();
  assert.equal(fs.readFileSync(gen.OUT_MD, 'utf8'), gen.renderMarkdown(m), 'docs/harness-matrix.md is stale');
  assert.equal(fs.readFileSync(gen.OUT_JSON, 'utf8'), gen.renderJson(m), 'src/harness/matrix.generated.json is stale');
});

test('every first-class harness has a clean result for each version it lists as tested, and min is the oldest', () => {
  const results = gen.loadResults();
  for (const kind of ['codex', 'claude']) {
    const want = gen.deriveVersions(results, kind, compareVersions, REGISTRY[kind].versions.knownBad);
    assert.deepEqual(REGISTRY[kind].versions, want, `${kind}: StaticInfo.versions differs from conformance/results`);
    for (const bad of REGISTRY[kind].versions.knownBad)
      assert.ok(!want.tested.includes(bad), `${kind} ${bad} is both tested and known bad`);
  }
});

test('basic harnesses stay unverified until native evidence exists; an unprobed entry ships disabled', async () => {
  const m = await gen.buildMatrix();
  const basic = Object.values(REGISTRY).filter((h) => h.tier === 'basic');
  assert.deepEqual(
    m.basic.map((b) => `acp:${b.id}`),
    basic.map((h) => h.kind),
  );
  for (const b of m.basic) {
    if (b.admission === 'not probed') {
      const { ACP_CATALOG } = await import('../shared/harnessCatalog.mjs');
      assert.equal(ACP_CATALOG[b.id].enabled, false, `${b.id}: an unprobed harness cannot ship enabled`);
    }
    assert.equal(b.verified, REGISTRY[`acp:${b.id}`].versions.tested.join(', ') || 'unverified');
  }
});

test('a basic harness lists as tested exactly the versions the admission results admitted', () => {
  const adm = loadAdmission();
  const quirks = require('../electron/harness/quirks/index.cjs');
  for (const [id, a] of Object.entries<any>(adm.harnesses)) {
    const want = a.probeWithQuirksFixes?.state === 'admitted' ? [a.version] : [];
    assert.deepEqual(REGISTRY[`acp:${id}`].versions.tested, want, `${id}: StaticInfo.versions.tested differs from acp-admission.json`);
    // the registry's resume command is the one the quirks file declares
    const q = quirks.quirks(id);
    assert.equal(
      REGISTRY[`acp:${id}`].resumeCommand('s1'),
      q.resumeCommand ? q.resumeCommand('s1') : null,
      `${id}: resumeCommand differs from its quirks file`,
    );
  }
});

test('every check named for a semantic exists in the results', () => {
  const results = gen.loadResults();
  for (const kind of ['codex', 'claude']) {
    const checks = results.filter((r) => r.kind === kind).at(-1)!.checks;
    for (const [semantic, ids] of Object.entries(gen.CHECKS_FOR[kind] as Record<string, string[]>))
      for (const id of ids) assert.ok(checks[id], `${kind} ${semantic}: no check ${id}`);
  }
});

test('Source names the controlling side: the harness for native bindings, MoPilot for polyfills', async () => {
  const m = await gen.buildMatrix();
  const row = (s: string) => m.semantics.find((x: any) => x.semantic === s);
  assert.equal(row('goal').codex.source, 'Codex');
  assert.equal(row('goal').claude.source, 'Claude Code');
  for (const s of ['computerUse', 'browser', 'dictation']) for (const k of ['codex', 'claude']) assert.equal(row(s)[k].source, 'MoPilot');
  assert.equal(row('shell').claude.source, 'MoPilot');
  assert.equal(row('voiceChat').claude.via, 'none');
  assert.equal(row('workflows').codex.via, 'none');
  assert.match(row('workflows').codex.why, /Codex/);
});
