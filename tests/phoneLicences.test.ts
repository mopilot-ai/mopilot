// The data for the phone's Licences screen (plan R10): every entry names its holder, licence and full notice, and the Orca entry matches the notice kept beside the vendored files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Entry = { id: string; name: string; holder: string; licence: string; source: string; notice: string };
const data = JSON.parse(readFileSync(resolve('mobile/src/licences.json'), 'utf8')) as { entries: Entry[] };

test('every licence entry has an id, name, holder, licence, source and notice, and ids are unique', () => {
  assert.ok(data.entries.length > 0);
  for (const e of data.entries) {
    for (const key of ['id', 'name', 'holder', 'licence', 'source', 'notice'] as const) assert.ok(e[key]?.trim(), `${e.id}: ${key}`);
  }
  assert.equal(new Set(data.entries.map((e) => e.id)).size, data.entries.length);
});

test('the Orca entry carries the same copyright line as the notice beside the vendored files', () => {
  const orca = data.entries.find((e) => e.id === 'orca');
  assert.ok(orca);
  assert.equal(orca.licence, 'MIT');
  const file = readFileSync(resolve('mobile/vendor/orca/LICENSE-ORCA.md'), 'utf8');
  const line = 'Copyright (c) 2026 Lovecast Inc.';
  assert.ok(orca.notice.includes(line) && file.includes(line));
  const terms = (s: string) => s.replace(/\s+/g, ' ');
  const permission = terms(orca.notice).slice(terms(orca.notice).indexOf('Permission is hereby'));
  assert.ok(terms(file).includes(permission));
});
