// Native XCTest failures retain the fake app's multiline UI tree while excluding unrelated process output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneSendDiagnostics } from './e2e/fixtures/phone-send-diagnostics.mjs';

test('native failure retains marked multiline UI roles, labels and frames, excluding surrounding build output', () => {
  const result = phoneSendDiagnostics(
    'environment should stay private\nfile:47: error: missing composer\nPHONE_SEND_UI_TREE_BEGIN\nApplication MoPilot\n  TextView label=Task frame=(0, 300, 200, 40)\nPHONE_SEND_UI_TREE_END\nunrelated output',
  );
  assert.match(result, /file:47: error: missing composer/);
  assert.match(result, /Application MoPilot\n  TextView label=Task frame=\(0, 300, 200, 40\)/);
  assert.doesNotMatch(result, /private|unrelated/);
});

test('absent or incomplete UI markers never publish unscoped output and compiler errors remain capped', () => {
  assert.equal(phoneSendDiagnostics('ordinary output'), '');
  assert.equal(phoneSendDiagnostics('PHONE_SEND_UI_TREE_BEGIN\nunclosed'), '');
  assert.equal(phoneSendDiagnostics('PHONE_SEND_UI_TREE_END'), '');
  assert.equal(phoneSendDiagnostics('PHONE_SEND_UI_TREE_BEGIN\r\nPHONE_SEND_UI_TREE_END'), '');
  const result = phoneSendDiagnostics(Array.from({ length: 25 }, (_, i) => `file: error: ${i}`).join('\n'));
  assert.equal(result.split('\n').length, 20);
  assert.doesNotMatch(result, /error: 20/);
});

test('two XCTest UI trees are retained with a bounded size even when the native logger repeats them', () => {
  const tree = (text: string) => `PHONE_SEND_UI_TREE_BEGIN\n${text}\nPHONE_SEND_UI_TREE_END\n`;
  const result = phoneSendDiagnostics(tree('x'.repeat(20_000)) + tree('second') + tree('third'));
  assert.match(result, /truncated/);
  assert.match(result, /second/);
  assert.doesNotMatch(result, /third/);
  assert.ok(result.length < 16_100);
});

test('a truncated tree is discarded when another begins, without publishing intervening build output', () => {
  const result = phoneSendDiagnostics(
    'PHONE_SEND_UI_TREE_BEGIN\ntruncated first\nUNRELATED_BUILD_OUTPUT\nPHONE_SEND_UI_TREE_BEGIN\ncomplete second\nPHONE_SEND_UI_TREE_END',
  );
  assert.match(result, /complete second/);
  assert.doesNotMatch(result, /truncated first|UNRELATED_BUILD_OUTPUT/);
});

test('error-like UI text cannot escape the tree bound through compiler diagnostics', () => {
  const result = phoneSendDiagnostics(
    `PHONE_SEND_UI_TREE_BEGIN\nText label: Failed with error: ${'x'.repeat(30_000)}\nPHONE_SEND_UI_TREE_END`,
  );
  assert.ok(result.length < 16_100);
  assert.match(result, /truncated/);
});

test('XCTest step lines are kept to the last 60 so a hang shows where it stopped, and nothing else leaks', () => {
  const lines = Array.from({ length: 70 }, (_, i) => `    t = ${i}.00s Tap "Step ${i}"`);
  const result = phoneSendDiagnostics(['secret build output', "Test Case '-[PhoneSendUITests testA]' started.", ...lines].join('\n'));
  assert.match(result, /XCTest last steps:/);
  assert.match(result, /Step 69/);
  assert.doesNotMatch(result, /Step 9"|secret/);
  assert.doesNotMatch(result, /testA/, 'the oldest lines scroll out of the 60-line window');
});

test('a run killed by its timeout also keeps a bounded log tail; an ordinary failure does not', () => {
  const log = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(300)}`).join('\n');
  const killed = phoneSendDiagnostics(log, { tail: true });
  assert.match(killed, /Log tail:/);
  assert.match(killed, /line 49/);
  assert.doesNotMatch(killed, /line 19 /);
  assert.ok(killed.split('\n').every((line) => line.length <= 200));
  assert.equal(phoneSendDiagnostics(log), '');
});
