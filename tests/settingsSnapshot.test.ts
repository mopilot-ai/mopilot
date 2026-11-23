// Settings information architecture (WP7-3): the page budget, where old links land, and the inventory
// of "Applies to" badges. The inventory is read from the Settings source, so adding a badge means
// adding a line here and the UI cannot drift from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['src/components/'];

const {
  NAV,
  GROUPS,
  SIDEBAR_BEFORE,
  SIDEBAR_MAX,
  ROWS_BEFORE,
  ROWS_MAX_GROWTH,
  ROWS_ACCEPTED,
  ROWS_BUDGET,
  HARNESS_TABS,
  APPLIES,
  resolveSection,
  splitTab,
  isHarnessTab,
} = await import('../src/lib/settingsNav.ts');
const { PROVIDER_LABEL } = await import('../src/lib/providers.ts');

const ROOT = join(import.meta.dirname, '..', 'src', 'components');
const sources = treeFiles(ROOT, /\.tsx$/).map((f) => ({ rel: relative(ROOT, f), src: readFileSync(f, 'utf8') }));

test('the sidebar has no more items than before, and no more than 21', () => {
  assert.ok(NAV.length <= SIDEBAR_MAX, `${NAV.length} items`);
  assert.ok(NAV.length <= SIDEBAR_BEFORE);
  assert.equal(new Set(NAV.map((n) => n.id)).size, NAV.length);
  for (const n of NAV) assert.ok(GROUPS.includes(n.group), n.id);
});

test('accounts live in one sidebar item; each first-class harness has one page', () => {
  assert.deepEqual(
    NAV.filter((n) => /account|billing|usage/i.test(n.label)).map((n) => n.id),
    ['accounts'],
  );
  assert.deepEqual(
    NAV.filter((n) => n.group === 'Harnesses').map((n) => n.id),
    ['harnesses', 'codex', 'claude', 'other-harnesses'],
  );
  assert.deepEqual(
    NAV.filter((n) => n.group === 'Built-in tools').map((n) => n.label),
    ['Computer use', 'Computer History', 'Computer access', 'Browser', 'Voice & dictation'],
  );
  assert.deepEqual(
    HARNESS_TABS.map((t) => t.label),
    ['Overview', 'Extensions', 'Advanced'],
  );
});

test('settings rows grow by at most 10, plus the additions accepted by PR', () => {
  // The +10 budget is fixed (WP7-3); every row past it is a reviewed ledger line with its PR and reason.
  assert.equal(ROWS_MAX_GROWTH, 10);
  assert.equal(new Set(ROWS_ACCEPTED.map((a) => a.pr)).size, ROWS_ACCEPTED.length);
  for (const a of ROWS_ACCEPTED) {
    assert.ok(Number.isInteger(a.pr) && a.pr > 0, `PR ${a.pr}`);
    assert.ok(Number.isInteger(a.rows) && a.rows > 0, `PR ${a.pr}: ${a.rows} rows`);
    assert.ok(a.why.trim(), `PR ${a.pr}: no reason`);
  }
  assert.equal(ROWS_BUDGET, ROWS_BEFORE + ROWS_MAX_GROWTH + ROWS_ACCEPTED.reduce((n, a) => n + a.rows, 0));
  const rows = sources.reduce((n, f) => n + (f.src.match(/<Row\b/g)?.length ?? 0), 0);
  assert.ok(rows <= ROWS_BUDGET, `${rows} rows, budget ${ROWS_BUDGET}: merge rows, or add a ROWS_ACCEPTED line in src/lib/settingsNav.ts`);
});

test('old section links land on the new pages', () => {
  const to = (s: string, t?: string) => resolveSection(s, t);
  assert.deepEqual(to('account'), { section: 'accounts' });
  assert.deepEqual(to('usage'), { section: 'accounts' });
  assert.deepEqual(to('mopilot'), { section: 'accounts' });
  assert.deepEqual(to('configuration'), { section: 'codex', tab: 'advanced' });
  assert.deepEqual(to('personalization'), { section: 'codex', tab: 'overview' });
  assert.deepEqual(to('cloud'), { section: 'codex', tab: 'advanced' });
  assert.deepEqual(to('features'), { section: 'codex', tab: 'advanced' });
  assert.deepEqual(to('hooks'), { section: 'codex', tab: 'extensions' });
  assert.deepEqual(to('import'), { section: 'codex', tab: 'extensions' });
  assert.deepEqual(to('plugins'), { section: 'codex', tab: 'extensions' });
  assert.deepEqual(to('plugins', 'mcps'), { section: 'codex', tab: 'extensions:mcps' });
  // the tabs the Codex page had before its sections were renamed
  assert.deepEqual(to('codex', 'accounts'), { section: 'accounts' });
  assert.deepEqual(to('codex', 'config'), { section: 'codex', tab: 'advanced' });
  assert.deepEqual(to('codex', 'memory'), { section: 'codex', tab: 'overview' });
  // Models & providers and Instructions & memory were folded into Overview on both harness pages
  assert.deepEqual(to('codex', 'models'), { section: 'codex', tab: 'overview' });
  assert.deepEqual(to('codex', 'instructions'), { section: 'codex', tab: 'overview' });
  assert.deepEqual(to('claude', 'models'), { section: 'claude', tab: 'overview' });
  assert.deepEqual(to('claude', 'instructions'), { section: 'claude', tab: 'overview' });
  assert.deepEqual(to('claude', 'extensions'), { section: 'claude', tab: 'extensions' });
  assert.deepEqual(to('claude'), { section: 'claude', tab: undefined });
  assert.deepEqual(resolveSection(undefined), { section: 'general', tab: undefined });
  // every alias target is a real sidebar item
  for (const old of [
    'account',
    'usage',
    'mopilot',
    'configuration',
    'personalization',
    'cloud',
    'features',
    'hooks',
    'import',
    'plugins',
  ]) {
    assert.ok(
      NAV.some((n) => n.id === to(old).section),
      old,
    );
  }
});

test('a tab can carry a page inside its section', () => {
  assert.deepEqual(splitTab('extensions:mcps'), { tab: 'extensions', sub: 'mcps' });
  assert.deepEqual(splitTab('extensions'), { tab: 'extensions', sub: undefined });
  assert.deepEqual(splitTab(undefined), { tab: undefined, sub: undefined });
  assert.ok(isHarnessTab('advanced'));
  assert.ok(!isHarnessTab('accounts'));
});

test('provider headings name the provider, never a harness', () => {
  assert.deepEqual(PROVIDER_LABEL, { anthropic: 'Anthropic', openai: 'OpenAI', mopilot: 'MoPilot' });
});

// Applies to is shown only when a setting is not for every harness
const INVENTORY = [['pages/settings/Voice.tsx', 'codex', 1]];

test('the Applies to inventory matches the UI', () => {
  const found = new Map<string, number>();
  for (const { rel, src } of sources) {
    for (const m of src.matchAll(/\bapplies="(\w+)"/g)) {
      assert.ok(m[1] in APPLIES, `${rel}: unknown scope ${m[1]}`);
      const k = `${rel}\0${m[1]}`;
      found.set(k, (found.get(k) ?? 0) + 1);
    }
  }
  const got = [...found].map(([k, n]) => [...k.split('\0'), n]).sort();
  assert.deepEqual(got, [...INVENTORY].sort());
});
