// The raw-internal-text lint guard (lint/rules/raw-internal-text.grit) through the production Biome configuration: a
// failure's raw message, stderr or code in a toast, an error setter, main's toast event or an error/reason field warns, in
// the windows, main and shared code; userError, a reason table and wire error objects do not (#1863).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const RULE = '[raw-internal-text]';
/** Line numbers of the rule's warnings in a fixture file. */
const hits = (name: string, input: string) =>
  lintFixtures({ [name]: input })
    .diagnostics.filter((d) => d.message.includes(RULE))
    .map((d) => d.location?.start?.line);

const wrap = (body: string) => `export const f = (p, toast, set, setError, emit, r, run, error, reason, userError) =>\n  ${body};\n`;

test('raw messages, stderr, codes and reasons in a UI sink warn, in the windows, main and shared code', () => {
  for (const input of [
    "toast(`Your bug report wasn't sent: ${r.message}`, 'error')",
    "toast(r.stderr.split('\\n')[0] || 'Commit failed', 'error')",
    "toast(`Couldn't load plugins: ${error}`, 'error')",
    'setError(`Blocked: ${reason}`)',
    '({ ok: false, error: String(r.message) })',
    '({ state: "unsupported", reason: `${r.message} · tail` })',
    "({ result: 'failed', configError: `exit code ${run.code}` })",
    "emit({ kind: 'toast', level: 'error', text: `Native control cleanup failed: ${r.message}` })",
  ])
    for (const name of ['src/view.tsx', 'electron/sink.cjs', 'shared/sink.mjs'])
      assert.deepEqual(hits(name, wrap(input)), [2], `${name}: ${input}`);
});

test('userError, reason tables, wire error objects and text that is not a failure do not warn', () => {
  for (const input of [
    "toast(`Couldn't save: ${userError(r)}`, 'error')",
    "toast(userError(r.message), 'error')",
    "toast('Saved', 'info')",
    '({ ok: false, error: userError(error) })',
    '({ error: { code: -32603, message: String(r.message) } })',
    '({ reason: peerReasonText(r.code) })',
    "emit({ kind: 'progress', text: r.message })",
    '({ title: r.message })',
    'set({ error: null })',
  ])
    assert.deepEqual(hits('electron/sink.cjs', wrap(input)), [], input);
});

test('model-facing tool code and refusals are outside the rule', () => {
  const input = wrap('({ ok: false, error: String(r.message) })');
  assert.deepEqual(hits('electron/capabilities/tools/result.cjs', input), []);
  const config = JSON.parse(fs.readFileSync('biome.json', 'utf8'));
  const override = config.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes('./lint/rules/raw-internal-text.grit'));
  assert.deepEqual(override.includes, [
    'src/**',
    'electron/**',
    'shared/**',
    '!electron/capabilities/tools/**',
    '!electron/chrome-extension/**',
    '!electron/capabilities/contract/controlRefusals.cjs',
    '!electron/capabilities/contract/peerMessages.cjs',
    '!electron/capabilities/browser/refusals.cjs',
  ]);
});
