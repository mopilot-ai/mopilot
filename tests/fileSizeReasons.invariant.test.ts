// File-size exceptions explain the current responsibility instead of accumulating per-change line-count histories.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

export const GUARDS = ['lint/file-size-exceptions/', 'lint/file-size-exceptions.json'];

const history =
  /(?:^|[.!?]\s+)(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|thirteen|\d+) (?:more )?lines?\b|this entry moved|its earlier reason|plus one line/iu;
const folder = new URL('../lint/file-size-exceptions/', import.meta.url);

test('the wording guard distinguishes change history from a responsibility justification', () => {
  assert.ok(history.test('Two more lines wire the callback.'));
  assert.ok(history.test('One line requires the clock port.'));
  assert.ok(!history.test('The serialized page closure must remain self-contained.'));
  assert.ok(!history.test('A 44-line operation and its error paths share this fixture.'));
});

test('every file-size reason describes the current exception without amendment history', () => {
  const files = readdirSync(folder).filter((name) => name.endsWith('.json'));
  const sources = files.map((name) => new URL(name, folder));
  sources.push(new URL('../file-size-exceptions.json', folder));
  const found: string[] = [];
  for (const source of sources) {
    const { exceptions } = JSON.parse(readFileSync(source, 'utf8'));
    for (const [owner, entry] of Object.entries(exceptions ?? {})) {
      if (history.test((entry as { reason: string }).reason)) found.push(owner);
    }
  }
  assert.deepEqual(found, [], `Rewrite amendment histories as current justifications: ${found.join(', ')}`);
});
