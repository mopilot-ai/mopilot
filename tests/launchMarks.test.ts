// src/lib/launchMarks.ts: content-free marks on the window's launch timeline.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_PREFIX, launchMark, resetLaunchMarks } from '../src/lib/launchMarks.ts';

const marks = () => performance.getEntriesByType('mark').filter((m) => m.name.startsWith(LAUNCH_PREFIX));
beforeEach(() => {
  performance.clearMarks();
  resetLaunchMarks();
});

test('a mark carries its name under the app prefix and a count as its detail', () => {
  launchMark('chats:claude', 12);
  launchMark('boot:start');
  assert.deepEqual(
    marks().map((m) => [m.name, (m as PerformanceMark).detail]),
    [
      ['mopilot:chats:claude', 12],
      ['mopilot:boot:start', null],
    ],
  );
});

test('a mark made once stays as it was; marks made again each add one', () => {
  launchMark('boot:done', undefined, true);
  launchMark('boot:done', undefined, true);
  launchMark('x');
  launchMark('x');
  assert.deepEqual(
    marks().map((m) => m.name),
    ['mopilot:boot:done', 'mopilot:x', 'mopilot:x'],
  );
  resetLaunchMarks();
  launchMark('boot:done', undefined, true);
  assert.equal(marks().length, 4);
});

test('a timeline that cannot take a mark loses only the measurement', () => {
  const real = performance.mark;
  performance.mark = () => {
    throw new Error('no timeline');
  };
  try {
    assert.doesNotThrow(() => launchMark('boot:start'));
  } finally {
    performance.mark = real;
  }
});
