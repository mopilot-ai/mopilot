// Per-harness admission evidence discovery preserves historical results and rejects conflicting identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './support/scripts-shared-cli.ts';
import { loadAdmission } from '../scripts/harness-admission-records.mjs';

const fixture = () => {
  const root = tempDir();
  const file = path.join(root, 'legacy.json');
  const dir = path.join(root, 'admission');
  const legacy = { platform: 'macOS', how: 'Historic probe.', harnesses: { old: { version: '1', state: 'admitted' } } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  return { file, dir, legacy };
};
const record = (id: string, platform = 'Linux') => ({
  id,
  platform,
  how: `${id} probe.`,
  version: '2',
  probeWithQuirksFixes: { state: 'signin' },
});

test('a missing or empty individual-record directory leaves the historic evidence intact', () => {
  const { file, dir, legacy } = fixture();
  assert.deepEqual(loadAdmission(file, dir), legacy);
  fs.mkdirSync(dir);
  assert.deepEqual(loadAdmission(file, dir), legacy);
});

test('discovers sorted JSON records, combines provenance and preserves each real outcome', () => {
  const { file, dir, legacy } = fixture();
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a record');
  fs.writeFileSync(path.join(dir, 'z.json'), JSON.stringify(record('z')));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(record('a', 'macOS')));
  assert.deepEqual(loadAdmission(file, dir), {
    ...legacy,
    platform: 'macOS; Linux',
    how: 'Historic probe. a probe. z probe.',
    harnesses: { ...legacy.harnesses, a: record('a', 'macOS'), z: record('z') },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy, 'loading never overwrites recorded evidence');
});

test('a mismatched identity or duplicate historic owner fails rather than relabeling or replacing evidence', () => {
  const { file, dir } = fixture();
  fs.mkdirSync(dir);
  const target = path.join(dir, 'old.json');
  fs.writeFileSync(target, JSON.stringify(record('new')));
  assert.throws(() => loadAdmission(file, dir), /admission id must match/);
  fs.writeFileSync(target, JSON.stringify(record('old')));
  assert.throws(() => loadAdmission(file, dir), /duplicate admission id old/);
  fs.writeFileSync(target, '{broken');
  assert.throws(() => loadAdmission(file, dir), SyntaxError);
});
