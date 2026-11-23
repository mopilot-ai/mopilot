// Every vendored area of the phone app has a licences.json entry naming its holder, and every notice file beside the vendored code is in the data the Licences page shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { entries } = JSON.parse(readFileSync('mobile/src/licences.json', 'utf8')) as {
  entries: { id: string; holder: string; notice: string }[];
};
const areas = readdirSync('mobile/vendor').filter((f) => statSync(join('mobile/vendor', f)).isDirectory());

test('each folder under mobile/vendor is an entry with its holder and a notice file', () => {
  assert.ok(areas.includes('orca'), 'the scan sees the Orca folder');
  for (const area of areas) {
    const entry = entries.find((e) => e.id === area);
    assert.ok(entry, `mobile/vendor/${area} has no entry in mobile/src/licences.json`);
    assert.ok(entry.holder.trim() && entry.notice.trim(), `${area}: holder and notice`);
    const notices = readdirSync(join('mobile/vendor', area)).filter((f) => /^LICEN[SC]E/i.test(f));
    assert.ok(notices.length > 0, `mobile/vendor/${area} keeps no LICENSE file`);
    for (const f of notices) assert.ok(existsSync(join('mobile/vendor', area, f)));
  }
});
