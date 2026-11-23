// The real-machine acceptance scripts find processes by pattern over ssh, where `bash -c '<command>'` has the pattern in its own command line: a `pgrep -f` or `pkill -f` pattern must start with a bracketed letter ('[m]opilot-host') or it matches that shell (and `kill -9 $(pgrep …)` kills it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []));

test('I: every pgrep/pkill -f pattern in the Host acceptance scripts starts with a bracketed letter', () => {
  const sources = [
    'scripts/host-accept.mjs',
    'scripts/host-accept-app.mjs',
    ...files(path.join(ROOT, 'scripts/host-accept')),
    ...files(path.join(ROOT, 'scripts/host-accept-app')),
  ]
    .map((f) => path.resolve(ROOT, f))
    .filter((f) => fs.existsSync(f));
  assert.ok(sources.length >= 4, 'the scripts were found');
  let seen = 0;
  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\bp(?:grep|kill)\s+(?:-\w+\s+)*-f\s+(?:-\w+\s+)*(['"]?)([^\s'"]+)/g)) {
      seen++;
      assert.match(m[2], /^\[[A-Za-z]\]/, `${path.relative(ROOT, file)}: pattern ${m[2]} matches the shell that runs it`);
    }
  }
  assert.ok(seen >= 3, 'the patterns were found');
});
