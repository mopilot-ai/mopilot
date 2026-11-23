// Every Codex Stop goes through the adapter's request('turn/interrupt'), where the stopped turn's running commands end
// with it (#1940, electron/harness/codexConnection.cjs interruptTurn). A raw call('turn/interrupt', ...) elsewhere would
// stop the turn and leave its command running again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const OWNER = 'electron/harness/codexConnection.cjs';
const RAW = /\bcall\(\s*['"`]turn\/interrupt['"`]/;

/** Files that send turn/interrupt past request(): none but the owner. */
function rawInterrupts(files: { path: string; text: string }[]): string[] {
  return files.filter((f) => f.path !== OWNER && RAW.test(f.text)).map((f) => f.path);
}

test('only the Codex connection sends turn/interrupt without request()', () => {
  const paths = execFileSync('git', ['ls-files', 'electron', 'src', 'shared'], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => /\.(c?js|mjs|tsx?)$/.test(p) && fs.existsSync(p));
  assert.deepEqual(rawInterrupts(paths.map((path) => ({ path, text: fs.readFileSync(path, 'utf8') }))), []);
  assert.ok(RAW.test(fs.readFileSync(OWNER, 'utf8')), 'the owner still sends it');
});

test('the scan finds a raw call outside the owner', () => {
  assert.deepEqual(
    rawInterrupts([
      { path: 'electron/x.cjs', text: "this.call('turn/interrupt', p)" },
      { path: 'electron/y.cjs', text: "this.request('turn/interrupt', p)" },
      { path: OWNER, text: "this.call('turn/interrupt', p)" },
    ]),
    ['electron/x.cjs'],
  );
});
