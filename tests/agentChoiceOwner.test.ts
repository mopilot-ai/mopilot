// Whole-repository rule (#2084): an agent tool that offers a harness, model or effort choice honors it only when the
// user's own words name it (electron/session/userWords.cjs userChoice), so no tool lets an agent move work to another
// harness or a pricier model on its own. Every tool module in electron/ is scanned for such a schema property; its
// module, or the one listed as enforcing it, must call userChoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/'];

const ROOT = path.resolve(import.meta.dirname, '..');

/** A schema property an agent fills to choose where or on what a piece of work runs. */
const CHOICE = /\b(harness|model|effort|reasoning_effort)\s*:\s*(\{\s*type\b|string\(|string\s*,)/;
/** A module that defines agent tools: it registers them with a schema. */
const TOOL_MODULE = /\.register\(\s*\{[\s\S]*?\bschema\b/;

/** Tool modules whose choice another module enforces, with that module. */
const ENFORCED_BY: Record<string, string> = {
  // start_session's harness: Orchestrator.start through ownHarness
  'electron/capabilities/tools/sessions.cjs': 'electron/session/orchestration/ownHarness.cjs',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(cjs|js|mjs)$/.test(name) ? [p] : [];
  });
}

/** The tool modules in `sources` (relative path → text) that offer an agent a harness, model or effort choice. */
function choosers(sources: Record<string, string>) {
  return Object.keys(sources).filter((f) => TOOL_MODULE.test(sources[f]) && CHOICE.test(sources[f]));
}

const enforces = (text: string) => /require\([^)]*userWords\.cjs'\)/.test(text) && /\buserChoice\(/.test(text);

test('the scan finds a tool schema’s choice, and only in a tool module', () => {
  const tool = "registry.register({ name: 'x', schema: { properties: { harness: { type: 'string' } } } })";
  assert.deepEqual(
    choosers({ a: tool, b: "const o = { harness: { type: 'x' } }", c: "registry.register({ schema: { name: string('n') } })" }),
    ['a'],
  );
  assert.deepEqual(choosers({ d: "registry.register({ schema: {} }); const p = { model: string('m') }" }), ['d']);
  assert.equal(enforces("const { userChoice } = require('../userWords.cjs'); userChoice({})"), true);
  assert.equal(enforces('userChoice({})'), false);
});

test('every agent tool that offers a harness, model or effort choice honors only what the user named', () => {
  const sources: Record<string, string> = {};
  for (const f of files(path.join(ROOT, 'electron'))) sources[path.relative(ROOT, f)] = readFileSync(f, 'utf8');
  const found = choosers(sources);
  // the scan sees the tools it guards
  for (const known of ['electron/capabilities/tools/sessions.cjs', 'electron/capabilities/tools/scheduledTasks.cjs'])
    assert.ok(found.includes(known), `${known} is scanned`);
  for (const f of found) {
    const owner = ENFORCED_BY[f] ?? f;
    assert.ok(
      enforces(sources[owner]),
      `${f} lets an agent choose a harness, model or effort: honor it only when the user named it (userChoice in session/userWords.cjs), in it or in the module listed for it`,
    );
  }
});
