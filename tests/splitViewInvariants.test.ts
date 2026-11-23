// Split view guards over the whole renderer: "the current chat" comes from the focused pane (src/store/split.ts), not
// from the route, and every untargeted composer event reaches one composer, the focused pane's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const GUARDS = ['src/'];

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'protocol' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}
const files = sources(SRC).map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/**
 * The places that may read the route's chat id, each with why: the primary pane itself, and pages that are not chats.
 * Anything else that wants "the current chat" reads focusedChat(s); "is it on screen" reads visibleChats(s).
 */
const ROUTE_ID_READERS: Record<string, string> = {
  'src/store/split.ts': 'primaryChat: the one definition of the primary pane',
  'src/store/panes.ts': 'navigate and history move the primary pane, and keep one chat in one pane',
  'src/App.tsx': 'mounts the primary pane and the cloud task page',
  'src/components/mini/Mini.tsx': 'Quick Chat is its own window with no split panes',
  'src/store/route.ts': 'the active Cloud task is a page outside the chat panes',
};

test("only the primary pane and pages that are not chats read the route's id; the rest read the focused or visible chats", () => {
  const readers = files.filter(({ text }) => /\broute\??\.id\b/.test(text)).map(({ file }) => file);
  assert.deepEqual(
    readers.filter((file) => !(file in ROUTE_ID_READERS)),
    [],
    'read focusedChat(s) or visibleChats(s) from src/store/split.ts',
  );
  // an entry nobody needs any more goes, so the list stays the reasons it gives
  assert.deepEqual(
    Object.keys(ROUTE_ID_READERS).filter((file) => !readers.includes(file)),
    [],
  );
});

/** Composer events a window-wide dispatch can send with no chat named. */
const COMPOSER_EVENTS = [
  'focus-composer',
  'composer-insert',
  'open-sketch',
  'open-permission-picker',
  'open-model-picker',
  'open-project-menu',
  'start-voice',
];
/** The checks that pick one composer for such an event: the focused pane's (data-composer-main), or the one it bubbled from. */
const OWNERSHIP = /\b(ownsComposerCommand|focusComposer|receiveComposerText)\(/;

test('every listener of an untargeted composer event goes through the check that picks one composer', () => {
  const listeners = files.filter(({ text }) => COMPOSER_EVENTS.some((name) => text.includes(`addEventListener('${name}'`)));
  assert.ok(listeners.length >= 5, 'the listeners are found');
  assert.deepEqual(
    listeners.filter(({ text }) => !OWNERSHIP.test(text)).map(({ file }) => file),
    [],
    'check ownsComposerCommand(event, anchor) (src/lib/shortcutFocus.ts) or the composerEvents helpers',
  );
});
