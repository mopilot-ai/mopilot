// MOPILOT_FLAGS=@dev: every toggle flag in development on, in an unpackaged build only (electron/platform/flags.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withDevFlags } from './e2e/fixtures/devFlags.ts';
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

const require = createRequire(import.meta.url);
const { devPreset, localOverride, parseOverride } = require('../electron/platform/flags.cjs');

const def = (key: string, mode: string, remove: string) => ({ key, default: false, owner: 'momo', remove, mode, description: 'x' });
// known keys, defined here as flags in development so the preset has something to turn on
const DEFS = [
  def('shared.perf.probe', 'toggle', '2026-12-01'),
  def('shared.browser.chromeExtension', 'toggle', '2026-12-01'),
  def('shared.browser.chromeRelay', 'toggle', '2026-11-02'),
  def('shared.browser.siteRiskRemote', 'kill', 'permanent'),
];
const o = { now: Date.UTC(2026, 10, 3), defs: DEFS };

test('B1: @dev turns on every toggle flag before its removal date, and nothing else', () => {
  assert.deepEqual(parseOverride('@dev', o), { 'shared.perf.probe': true, 'shared.browser.chromeExtension': true });
  assert.deepEqual(devPreset(DEFS, '2026-12-01'), { 'shared.perf.probe': true, 'shared.browser.chromeExtension': true });
  assert.deepEqual(devPreset(DEFS, '2026-12-02'), {}, 'expired flags are not turned on');
});

test('B1: a key named beside @dev wins wherever it stands', () => {
  const pinned = { 'shared.perf.probe': true, 'shared.browser.chromeExtension': false };
  assert.deepEqual(parseOverride('@dev,shared.browser.chromeExtension=0', o), pinned);
  assert.deepEqual(parseOverride('shared.browser.chromeExtension=0, @dev', o), pinned);
  assert.deepEqual(parseOverride('@dev,harness.claude.enabled=0', o), {
    'shared.perf.probe': true,
    'shared.browser.chromeExtension': true,
    'harness.claude.enabled': false,
  });
  assert.deepEqual(parseOverride('{"@dev": true}', o), {}, 'JSON has no preset');
  assert.deepEqual(parseOverride('shared.perf.probe=1', o), { 'shared.perf.probe': true }, 'no preset unless asked');
});

test('B1: @dev in a packaged build is ignored', () => {
  assert.deepEqual(localOverride(true, '@dev,harness.claude.enabled=0', o), {});
  assert.deepEqual(localOverride(false, '@dev', o), { 'shared.perf.probe': true, 'shared.browser.chromeExtension': true });
});

test("@dev turns on today's flags in development: the turn trace (#3571 G5), and only real toggle flags", () => {
  const on = parseOverride('@dev', { now: Date.UTC(2026, 10, 3) });
  assert.equal(on['shared.browser.turnTrace'], true);
  // a new flag in development joins the preset without this test naming it: what is on is exactly the toggles not past their date
  const toggles = new Set(FLAG_DEFS.filter((d) => d.mode === 'toggle').map((d) => d.key));
  assert.ok(Object.keys(on).every((k) => toggles.has(k) && on[k] === true));
});

test('the E2E fixtures launch with @dev, and a spec pins a flag off or opts out', () => {
  assert.equal(withDevFlags(undefined), '@dev');
  assert.equal(withDevFlags(' '), '@dev');
  assert.equal(withDevFlags('x=0'), '@dev,x=0');
  assert.equal(withDevFlags('x=0,@dev'), 'x=0,@dev');
  assert.equal(withDevFlags('{}'), '{}');
});
