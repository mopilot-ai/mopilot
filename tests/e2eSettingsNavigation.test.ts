// Settings E2E navigation uses the production labels and the search path for hidden setup pages, with failures propagated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV } from '../src/lib/settingsNav.ts';
import { searchSettings } from '../src/lib/settingsSearch.ts';
import { relatedSpecs, reverseGraph } from '../scripts/related-tests.mjs';
import { fileURLToPath } from 'node:url';
import { openSettingsSection, settingsLabel } from './e2e/fixtures/settings.ts';

function pageWithHiddenSections(fail?: 'search' | 'click' | 'clear') {
  const calls: unknown[][] = [];
  let query = '';
  const nav = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(options.exact, true);
      if (role === 'textbox') {
        assert.equal(options.name, 'Search settings');
        return {
          fill: async (value: string) => {
            calls.push(['search', value]);
            if (fail === (value ? 'search' : 'clear')) throw new Error('search unavailable');
            query = value;
          },
        };
      }
      assert.fail(`Use visible labels rather than icon-bearing ${role} accessible names`);
    },
    locator(selector: string) {
      assert.equal(selector, '.side-row:not(.has-hint)');
      return {
        filter({ has }: { has: { label: string } }) {
          return {
            click: async () => {
              calls.push(['click', has.label]);
              // Missing first-class harnesses and the legacy basic index have no default sidebar row.
              assert.equal(query, has.label, 'hidden setup pages must be found through search');
              if (fail === 'click') throw new Error('navigation refused');
            },
          };
        },
      };
    },
  };
  const page = {
    getByText(label: string, options: { exact: boolean }) {
      assert.equal(options.exact, true);
      return { label };
    },
    locator(selector: string) {
      assert.equal(selector, '.settings-nav');
      return nav;
    },
  };
  return { page: page as any, calls };
}

for (const section of ['other-harnesses', 'codex', 'claude', 'harnesses']) {
  test(`Settings lookup finds ${section} even when its default sidebar row is hidden`, async () => {
    const { page, calls } = pageWithHiddenSections();
    const label = NAV.find((item) => item.id === section)!.label;
    assert.equal(settingsLabel(section), label);
    assert.equal(searchSettings(NAV, label).find((hit) => hit.item.id === section)?.hint, null);
    await openSettingsSection(page, section);
    assert.deepEqual(calls, [
      ['search', label],
      ['click', label],
      ['search', ''],
    ]);
  });
}

test('production Settings navigation changes select every journey using the shared lookup', () => {
  const graph = reverseGraph(fileURLToPath(new URL('../', import.meta.url)));
  const selected = relatedSpecs(['src/lib/settingsNav.ts'], graph);
  for (const spec of ['acp-admission', 'cuj-acp-harness-daily-loop', 'claude-only', 'settings-ia'])
    assert.ok(selected.includes(`tests/e2e/${spec}.spec.ts`), spec);
});

test('unknown Settings sections fail before any page interaction', async () => {
  const { page, calls } = pageWithHiddenSections();
  assert.throws(() => settingsLabel('missing-section'), /Unknown Settings section/);
  await assert.rejects(openSettingsSection(page, 'missing-section'), /Unknown Settings section/);
  assert.deepEqual(calls, []);
});

for (const fail of ['search', 'click', 'clear'] as const) {
  test(`Settings ${fail} failure remains a failed journey`, async () => {
    const { page, calls } = pageWithHiddenSections(fail);
    await assert.rejects(openSettingsSection(page, 'codex'), /unavailable|refused/);
    assert.equal(calls.length, { search: 1, click: 2, clear: 3 }[fail]);
  });
}
