// E2E specs open Settings through settingsEntry (tests/e2e/fixtures/settings.ts), never by the word "Settings" anywhere
// on the page: a chat's reply can say it too, and the click then fails on two matches (#2698).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A page-wide text lookup of "Settings" (page.getByText('Settings'…), by line. */
export function pageWideSettings(source: string): number[] {
  return source.split('\n').flatMap((line, i) => (/\b(?:page|p|win|window)\.getByText\(\s*['"`]Settings['"`]/.test(line) ? [i + 1] : []));
}

test('the matcher flags a page-wide Settings text lookup, and nothing scoped', () => {
  assert.deepEqual(pageWideSettings("await page.getByText('Settings', { exact: true }).click();"), [1]);
  assert.deepEqual(pageWideSettings('x\nawait p.getByText("Settings").click();'), [2]);
  assert.deepEqual(pageWideSettings('await settingsEntry(page).click();'), []);
  assert.deepEqual(pageWideSettings("await nav.getByText('Settings', { exact: true }).click();"), []);
  assert.deepEqual(pageWideSettings("await page.getByText('Settings saved').click();"), [], 'a longer text is not the entry');
});

test('no E2E spec looks up Settings by its text across the whole page', () => {
  const files = execFileSync('git', ['ls-files', 'tests/e2e'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 100, `${files.length} E2E files`);
  const found = files.flatMap((f) => pageWideSettings(readFileSync(f, 'utf8')).map((line) => `${f}:${line}`));
  assert.deepEqual(found, []);
});
