// The text formatters in src/lib/format.ts: durations, ages, token counts, labels, diffs and shortcuts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  comboFromEvent,
  effortLabel,
  formatDuration,
  formatTokens,
  compactCount,
  linkMark,
  modelLabel,
  parseDelegation,
  parseUserText,
  pluralize,
  relativeTime,
  stripInjectedContext,
} from '../src/lib/format.ts';
import { installNative } from '../src/lib/native.ts';

test('durations round to seconds, minutes and hours', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(Infinity), '');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(59_400), '59s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(3_725_000), '1h 2m');
});

test('relative times step through now, minutes, hours, days, weeks, months and years', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    const now = Date.now() / 1000;
    assert.equal(relativeTime(0), '');
    assert.deepEqual(
      [10, 120, 7200, 2 * 86400, 14 * 86400, 60 * 86400, 800 * 86400].map((ago) => relativeTime(now - ago)),
      ['now', '2m', '2h', '2d', '2w', '2mo', '2y'],
    );
  } finally {
    mock.timers.reset();
  }
});

test('token counts abbreviate thousands and millions', () => {
  assert.deepEqual([999, 1000, 1500, 12_345, 1_000_000, 2_500_000].map(formatTokens), ['999', '1k', '1.5k', '12k', '1M', '2.5M']);
  // the unit follows the rounding: just under a million is 1M, not 1000k
  assert.deepEqual([999_499, 999_500, 999_950, 9_999].map(formatTokens), ['999k', '1M', '1M', '10k']);
  assert.deepEqual(
    [999_949, 999_950, 1_049_999].map((n) => compactCount(n)),
    ['999.9k', '1M', '1M'],
  );
});

test('model and effort labels', () => {
  assert.equal(modelLabel(null), 'Model');
  assert.equal(modelLabel('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(modelLabel('claude-opus'), 'Claude Opus');
  assert.equal(effortLabel(undefined), '');
  assert.equal(effortLabel('xhigh'), 'Extra high');
  assert.equal(effortLabel('turbo'), 'Turbo');
});

test('pluralize and stripped user text', () => {
  assert.equal(pluralize(1, 'file'), '1 file');
  assert.equal(pluralize(2, 'file'), '2 files');
  assert.equal(pluralize(3, 'child', 'children'), '3 children');
  assert.equal(stripInjectedContext('hello'), 'hello');
});

test('link marks use the host name without www, and reject other schemes', () => {
  assert.equal(linkMark('https://www.example.com/x')?.letter, 'E');
  assert.equal(linkMark('https://-.io')?.letter, 'I');
  assert.equal(linkMark('https://-/')?.letter, '?');
  assert.equal(linkMark('ftp://example.com'), null);
  assert.equal(linkMark('not a url'), null);
});

test('voice delegations recover the input and whether it flushes the transcript', () => {
  assert.equal(parseDelegation('hello'), null);
  assert.deepEqual(parseDelegation('  <realtime_delegation><source> transcript_tail_flush </source><input> do it </input>'), {
    flush: true,
    input: 'do it',
  });
  assert.deepEqual(parseDelegation('<realtime_delegation>'), { flush: false, input: '' });
});

const ev = (over: Partial<KeyboardEvent>) => ({
  key: 'a',
  code: 'KeyA',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

test('shortcut combos name the physical key and order modifiers per platform', () => {
  assert.equal(comboFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), true), null);
  assert.equal(comboFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true, metaKey: true }), true), '⇧⌘1');
  assert.equal(comboFromEvent(ev({ key: ':', code: 'Semicolon', ctrlKey: true, altKey: true }), true), '⌃⌥;');
  assert.equal(comboFromEvent(ev({ key: 'é', code: 'IntlRo' }), true), 'É');
  assert.equal(comboFromEvent(ev({ key: 'ArrowUp', code: 'ArrowUp' }), true), 'ArrowUp');
  assert.equal(comboFromEvent(ev({ ctrlKey: true, altKey: true, shiftKey: true }), false), '⌥⇧⌘A');
  assert.equal(comboFromEvent(ev({}), false), 'A');
});

test('the platform defaults to macOS unless the bridge says otherwise', () => {
  assert.equal(comboFromEvent(ev({ metaKey: true })), '⌘A'); // no bridge in this process
  installNative({ platform: 'win32' } as any);
  try {
    assert.equal(comboFromEvent(ev({ ctrlKey: true })), '⌘A');
    installNative(null);
    assert.equal(comboFromEvent(ev({ ctrlKey: true })), '⌃A');
  } finally {
    installNative(null);
  }
});

test('a message text is parsed once and its result shared, the oldest of 512 going first', () => {
  const first = parseUserText('# Files mentioned by the user:\n\n## a.ts: /p/a.ts\n\n## My request:\n\nhello');
  assert.equal(first.text, 'hello');
  assert.equal(parseUserText('# Files mentioned by the user:\n\n## a.ts: /p/a.ts\n\n## My request:\n\nhello'), first);
  assert.equal(stripInjectedContext('# Files mentioned by the user:\n\n## a.ts: /p/a.ts\n\n## My request:\n\nhello'), 'hello');
  for (let i = 0; i < 512; i++) parseUserText(`message ${i}`);
  // 512 newer messages pushed the first out: it parses again, to an equal but new result
  const again = parseUserText('# Files mentioned by the user:\n\n## a.ts: /p/a.ts\n\n## My request:\n\nhello');
  assert.notEqual(again, first);
  assert.deepEqual(again, first);
});

test('a message over 16000 characters is parsed each time and not held', () => {
  const long = 'x'.repeat(16_001);
  assert.notEqual(parseUserText(long), parseUserText(long));
  assert.equal(parseUserText(long).text, long);
  const edge = 'y'.repeat(16_000);
  assert.equal(parseUserText(edge), parseUserText(edge));
});
