// What a Calendar or Reminders row says in its needs-OK and stalled phases (src/components/momo/sourceConnect.ts, #2999): each names its own pane in System Settings, the chat's connect card and Settings share these lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

installNativeStub({});
const { needsLine, stalledLine } = await import('../src/components/momo/sourceConnect.ts');

test('the needs-OK and stalled lines send the user to the source’s own Privacy pane', () => {
  assert.equal(needsLine('calendar'), 'Turn on MoPilot under Privacy & Security › Calendars.');
  assert.equal(needsLine('reminders'), 'Turn on MoPilot under Privacy & Security › Reminders.');
  assert.equal(stalledLine('calendar'), 'Still off. Turn on MoPilot under Privacy & Security › Calendars, then come back.');
  assert.equal(stalledLine('reminders'), 'Still off. Turn on MoPilot under Privacy & Security › Reminders, then come back.');
});
