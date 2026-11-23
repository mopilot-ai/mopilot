// Invariant: MoPilot draws no phantom cursor for an action Codex Computer Use (Sky) governs. Sky runs the program itself and
// draws its own cursor; MoPilot only holds the lock, the overlay and Esc (nativeDesktopHold.cjs). The cursor belongs to the
// desktop_app_* tools, which Sky programs never call.
import fs from 'node:fs';
import path from 'node:path';
import { test, assert, governed, js, turn, NOTES, settle, mock } from './support/sky-matrix/fixture.ts';

export const GUARDS = ['electron/capabilities/'];

test('a native Sky program holding the desktop never reaches the phantom cursor or the app visibility that drives it', async () => {
  const g = governed();
  const { cursor, visibility } = g.runtime;
  const spies = [
    ...['approach', 'show', 'finish', 'cancel', 'hide'].map((m) => mock.method(cursor, m)),
    ...['approach', 'acted'].map((m) => mock.method(visibility, m)),
  ];
  g.notify('turn/started', turn('nat-a', 't1', 'inProgress'));
  g.notify('item/started', js('nat-a', 't1', NOTES, 'j1'));
  await settle();
  g.notify('item/completed', js('nat-a', 't1', NOTES, 'j1', 'completed'));
  await settle();
  assert.equal(g.cu.controlling, 'chat-a', 'MoPilot holds the desktop for the native program');
  assert.equal(g.runtime.indicator.chatId, 'chat-a', 'and shows its overlay');
  assert.deepEqual(
    spies.map((s) => s.mock.callCount()),
    spies.map(() => 0),
    'but draws no cursor: Sky draws its own',
  );
  assert.equal(cursor.active, null);
  assert.equal(cursor.window, null, 'no overlay window was ever made');
});

test('the native hold code does not import the phantom cursor or the app visibility', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../electron/capabilities/nativeDesktopHold.cjs'), 'utf8');
  assert.doesNotMatch(src, /phantomCursor|appVisibility|PhantomCursor/);
});
