// Side pane guard over the whole renderer: only the chat on screen changes what its side pane shows. Every write that
// opens the pane is listed here with why it may: a user's own action, or a check that the tab belongs to the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const GUARDS = ['src/'];

const ROOT = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'protocol' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** `open: true` in a file that handles the side pane (`diffPanel`), however the object is built: it may open the pane. */
const OPENS = /\bopen:\s*true\b/g;

/**
 * The files that open the side pane, how many times, and why each may. A background chat's agent, a page's popup or
 * an async step that finishes after the user moved on must check that its tab is in the view first.
 */
const PANE_OPENERS: Record<string, { count: number; why: string }> = {
  'src/store/panes.ts': {
    count: 7,
    why: 'openPaneTab/openChanges/togglePaneTab are user actions; agent and popup tabs open it only when in the view (agentChatInView, inView), or for a <webview> that needs it (behind)',
  },
  'src/store/actions.ts': { count: 2, why: "focusPane and openSubThread: the user picks a side chat or a sub-agent in this chat's view" },
  'src/session/appShortcuts.ts': { count: 2, why: 'keyboard shortcuts the user presses' },
  'src/store/windowPanes.ts': {
    count: 1,
    why: "show_pane's terminal tab: answerPane acts only for the chat whose side pane this is (on screen, focused in split view)",
  },
  'src/store/chatPanes.ts': { count: 1, why: "parkChatPane writes the source chat's saved pane, not the pane on screen" },
  'src/store/artifactPanes.ts': {
    count: 1,
    why: "openArtifactTab: the user's Open or link, show_pane for the chat on screen, or a publish only when its chat is the focused one (onArtifactPublished)",
  },
  'src/lib/browserDuplicate.ts': {
    count: 1,
    why: "Duplicate fronts its copy only while the view shows it (deps.shows), checked after the history copy's await",
  },
};

test('every write that opens the side pane is listed with why it may, so none opens it for a chat not on screen', () => {
  const found: Record<string, number> = {};
  for (const path of sources(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8');
    const count = text.includes('diffPanel') ? (text.match(OPENS)?.length ?? 0) : 0;
    if (count) found[relative(ROOT, path)] = count;
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(PANE_OPENERS).map(([file, { count }]) => [file, count])),
    'a new or moved pane opener: check it against the view (inView) unless the user asked for it, then list it here with why',
  );
  for (const { why } of Object.values(PANE_OPENERS)) assert.ok(why.length > 20);
});
