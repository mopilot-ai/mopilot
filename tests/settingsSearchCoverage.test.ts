// Every setting a Settings page shows by a fixed name is found by Settings search (#1869): a row's literal title,
// typed into the search box, lists the page that holds it. KEYWORDS (src/lib/settingsSearch.ts) is a hand list, and
// "notifications" and "language" found nothing while General and Voice & dictation showed those rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV } from '../src/lib/settingsNav.ts';
import { searchSettings } from '../src/lib/settingsSearch.ts';

export const GUARDS = ['src/components/', 'src/lib/'];

/** Each page's files: one file can draw rows on several pages (Git and Worktrees, a row every harness page has). */
const FILES: Record<string, string[]> = {
  'src/components/pages/settings/General.tsx': ['general'],
  'src/components/pages/settings/AutoArchiveRow.tsx': ['general'],
  'src/components/pages/settings/LanguageRow.tsx': ['general'],
  'src/components/pages/settings/Appearance.tsx': ['appearance'],
  'src/components/pages/settings/Mini.tsx': ['mini'],
  'src/components/pages/MoPilotSettings.tsx': ['privacy', 'accounts'],
  'src/components/pages/settings/ComputerUse.tsx': ['computer'],
  'src/components/pages/settings/ComputerHistory.tsx': ['computer-history'],
  'src/components/pages/settings/ComputerHistoryDays.tsx': ['computer-history'],
  'src/components/pages/settings/ComputerAccess.tsx': ['computer-access'],
  'src/components/pages/settings/Voice.tsx': ['voice'],
  'src/components/pages/settings/Connections.tsx': ['connections'],
  'src/components/pages/settings/Git.tsx': ['git', 'worktrees'],
  'src/components/pages/settings/About.tsx': ['about', 'codex'],
  'src/components/pages/settings/Browser.tsx': ['browser'],
  'src/components/pages/settings/BrowserUse.tsx': ['browser'],
  'src/components/pages/settings/BrowserStorage.tsx': ['browser'],
  'src/components/pages/settings/NativeControlStatus.tsx': ['browser', 'computer'],
  'src/components/pages/settings/HarnessPage.tsx': ['harnesses', 'codex', 'claude'],
  'src/components/pages/settings/OtherHarnesses.tsx': ['harnesses', 'other-harnesses'],
  'src/components/pages/settings/Rows.tsx': ['codex', 'claude', 'other-harnesses'],
  'src/components/pages/settings/BillingRow.tsx': ['accounts'],
  'src/components/pages/HarnessSettings.tsx': ['accounts', 'harnesses'],
  'src/components/accounts/settings.tsx': ['accounts'],
  'src/components/harness/Usage.tsx': ['accounts'],
  'src/components/harness/ResetCards.tsx': ['accounts'],
  'src/components/harness/AllHarnesses.tsx': ['harnesses'],
  'src/components/harness/OwnMcp.tsx': ['other-harnesses'],
  'src/components/harness/codex/settingsConfig.tsx': ['codex'],
  'src/components/harness/codex/settingsImport.tsx': ['codex'],
  'src/components/harness/claude/parts.tsx': ['claude'],
  'src/components/harness/claude/Extensions.tsx': ['claude'],
};

/** Per file, rows that are a state or one item of a list, not a setting to look for, each with why. */
const NOT_SETTINGS: Record<string, Record<string, string>> = {
  'src/components/pages/settings/ComputerAccess.tsx': {
    "Couldn't read Computer access": 'error state',
    "Computer access settings can't be read": 'error state',
  },
  'src/components/pages/settings/ComputerUse.tsx': {
    'No apps yet': 'empty state',
    'MoPilot Computer Use': "the engine's name",
  },
  'src/components/pages/settings/ComputerHistory.tsx': {
    Status: 'the state line',
    'Add an app': 'add row of a list',
    'Add a site': 'add row of a list',
  },
  'src/components/pages/settings/ComputerHistoryDays.tsx': { 'No memories yet': 'empty state' },
  'src/components/pages/settings/Git.tsx': { Name: 'a field of an environment' },
  'src/components/pages/settings/Connections.tsx': { 'Add another host': 'add row of a list' },
  'src/components/accounts/settings.tsx': {
    'Claude Code isn’t installed': 'missing state',
    'Finish signing in in Terminal': 'a sign-in under way',
  },
  'src/components/harness/ResetCards.tsx': {
    'Could not refresh usage': 'error state',
    'Could not load reset cards': 'error state',
    'Reset card information is not available': 'empty state',
    'Reset result needs confirmation': 'a result to confirm',
    'No resets available': 'empty state',
    'No reset history was returned': 'empty state',
    'More resets available': 'a list footer',
  },
  'src/components/harness/codex/settingsImport.tsx': {
    'Checking for imports': 'loading state',
    'Nothing to import': 'empty state',
  },
  'src/components/harness/claude/parts.tsx': { 'Install Claude Code': 'missing state' },
  'src/components/pages/settings/OtherHarnesses.tsx': { Account: '"account" finds Accounts & billing, where every account is' },
  'src/components/harness/claude/Extensions.tsx': { Available: 'a list heading' },
};

/** The literal titles of the Rows a file draws, single- or multi-line. */
function rowTitles(src: string): string[] {
  return [...src.matchAll(/<Row\b(?:=>|[^>])*?\btitle=(?:"([^"]+)"|\{'([^']+)'\})/gs)].map((m) => m[1] ?? m[2]);
}

test('rowTitles reads literal titles across lines and skips computed ones', () => {
  const src = `<Row title="One" /> <Row\n  onClick={() => go()}\n  title="Two"\n  desc="x"> <Row title={'Three'}> <Row title={name}>`;
  assert.deepEqual(rowTitles(src), ['One', 'Two', 'Three']);
});

test('every Settings row with a fixed name is found by searching for that name (#1869)', () => {
  const missing: string[] = [];
  for (const [file, pages] of Object.entries(FILES)) {
    const titles = rowTitles(readFileSync(file, 'utf8'));
    assert.ok(titles.length, `${file} has rows`);
    for (const t of titles) {
      if (Object.hasOwn(NOT_SETTINGS[file] ?? {}, t)) continue;
      const found = searchSettings(NAV, t).map((h) => h.item.id);
      if (!pages.some((p) => found.includes(p))) missing.push(`${pages[0]}: "${t}" (found ${found.join(', ') || 'nothing'})`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the words people type for General and Voice rows find them', () => {
  const finds = (q: string, page: string) =>
    assert.ok(
      searchSettings(NAV, q).some((h) => h.item.id === page),
      `"${q}" finds ${page}`,
    );
  for (const q of ['notifications', 'scheduled tasks', 'send with', 'follow-up', 'steer', 'reasoning', 'archive inactive'])
    finds(q, 'general');
  finds('language', 'voice');
  finds('request log', 'about');
  finds('branch prefix', 'git');
  finds('update channel', 'about');
  finds('blocked apps', 'computer');
  finds('restart codex', 'codex');
  finds('cloud provider', 'claude');
  finds('full cdp', 'browser');
});

test('an exception names a row that still exists in its file', () => {
  for (const [file, rows] of Object.entries(NOT_SETTINGS)) {
    assert.ok(file in FILES, `${file} is a page file`);
    const titles = new Set(rowTitles(readFileSync(file, 'utf8')));
    for (const t of Object.keys(rows)) assert.ok(titles.has(t), `"${t}" is still a row of ${file}`);
  }
});
