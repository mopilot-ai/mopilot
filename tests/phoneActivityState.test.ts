// The widget's state and wording, run for real: ActivityState.swift (Foundation only, in the app's Live Activity module and compiled into the widget too) is compiled with a driver on a Mac and its answers are checked. Skipped where there is no Swift compiler.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hasSwift = (() => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Compiles the state source with the driver (as main.swift: top-level code is only allowed there) and returns what the driver printed. */
function drive(): any {
  const dir = mkdtempSync(join(tmpdir(), 'activity-state-'));
  try {
    copyFileSync(new URL('./fixtures/mobile/ActivityStateDriver.swift', import.meta.url).pathname, join(dir, 'main.swift'));
    const state = new URL('../mobile/modules/mopilot-live-activity/ios/ActivityState.swift', import.meta.url).pathname;
    execFileSync('swiftc', ['-o', join(dir, 'drv'), state, join(dir, 'main.swift')], { stdio: 'pipe', timeout: 240_000 });
    return JSON.parse(execFileSync(join(dir, 'drv'), { encoding: 'utf8' }));
  } finally {
    rmSync(dir, { recursive: true });
  }
}

const skip = hasSwift ? false : 'needs swiftc on macOS';
const out = hasSwift ? drive() : null;

test('a push with a field the widget does not know is decoded and the field ignored; missing rows read as none', { skip }, () => {
  assert.equal(out.unknownDecoded, true);
  assert.equal(out.unknownRows, 1);
  assert.equal(out.unknownRowSt, true);
  assert.equal(out.bareRows, 0);
  assert.equal(out.roundTrip, true);
});

test('a push missing a required field or with a wrong type is not decoded, so the system keeps the previous frame', { skip }, () => {
  assert.equal(out.missingNeeds, true);
  assert.equal(out.wrongType, true);
});

test('rows read as fixed text unless titles are allowed and a key opens the sealed label; with the key removed they fall back', {
  skip,
}, () => {
  assert.equal(out.labelOff, 'A chat needs you');
  // with the switch off nothing is even attempted
  assert.equal(out.callsAfterOff, 0);
  assert.equal(out.labelOpened, 'Clean up generated files');
  assert.equal(out.labelKeyRemoved, 'A chat needs you');
  assert.equal(out.labelNoBlob, 'A chat is running');
  assert.deepEqual(out.labelKinds, ['A chat needs you', 'A chat is running', 'A chat finished', 'A chat is running']);
});

test('the headline, footer and rows: counts and kinds only, three rows at most, a Finished frame when nothing is left', { skip }, () => {
  assert.deepEqual(out.headlines, ['1 needs you · 2 running', '3 need you', '4 running', 'Finished']);
  assert.deepEqual(out.footers, ['Open MoPilot to answer', 'Open MoPilot', 'Open MoPilot to review']);
  assert.deepEqual(out.derivedRows, ['needs:100', 'running:100']);
  assert.deepEqual(out.derivedDone, ['done']);
  assert.equal(out.rowCap, 3);
  assert.deepEqual(out.finished, [false, true]);
  // the island shows what needs the person, else what runs, and a check mark when nothing is left: never a bare 0
  assert.deepEqual(out.islandCounts, ['1', '3', '4', '✓']);
});
