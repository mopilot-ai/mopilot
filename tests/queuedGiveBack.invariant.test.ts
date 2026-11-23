// Whole-repository rule: a queued item goes back to the composer as the user's text only through isUserQueued (src/lib/queued.ts),
// so an item another session sent or no human wrote is never handed back as the user's words (#3201).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('every place that gives queued items back to the composer filters them with the shared helper', () => {
  // Edit message (QueuedList), the harness switch (applySwitch via userQueued) and its sheets' counts
  assert.match(read('src/components/composer/QueuedList.tsx'), /onEdit && isUserQueued\(q\)/);
  assert.match(read('src/components/harnessPicker/applySwitch.ts'), /userQueued\(session\.queue\)/);
  assert.match(read('src/components/harnessPicker/AcpSwitchSheet.tsx'), /userQueued\(session\.queue\)/);
  assert.match(read('src/harness/switchPlan.ts'), /queue\.filter\(isUserQueued\)/);
});

test('no component decides "the user wrote it" from a loaded record or the marker alone', () => {
  for (const f of ['src/components/composer/QueuedList.tsx', 'src/components/harnessPicker/applySwitch.ts'])
    assert.doesNotMatch(read(f), /!q\.sideSession|!q\.authored|!shown && !side/, f);
});
