// Every browser-capable harness sees the managed local-preview lifecycle and its adapter's actual tool name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { surfaceNote, registryNote, claudeNames } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { inAppBrowserNote } = require('../electron/capabilities/channels/codexThreadContracts.cjs');

test('managed Codex, native Codex, Claude Code and ACP use saved launch recipes for live local previews', () => {
  const names = ['browser_navigate', 'browser_more_tools', 'browser_preview_start'];
  const notes = [
    surfaceNote(names, { yourChrome: false }),
    surfaceNote(names, { yourChrome: false, naming: claudeNames('sage') }),
    registryNote({ list: () => names.map((name) => ({ name })) }, null),
    inAppBrowserNote('sage', true, true).value,
    inAppBrowserNote('sage', false, false).value,
  ];
  for (const note of notes) {
    assert.match(note, /saves its approved launch details and restarts it/);
    assert.match(note, /temporary shell process or attaching with url alone cannot be restored/);
  }
  assert.match(notes[1], /mcp__mopilot_browser__preview_start/);
  assert.doesNotMatch(surfaceNote(['chrome_navigate'], { yourChrome: true }), /approved launch/);
  assert.match(surfaceNote(['browser_more_tools'], { yourChrome: false }), /browser_preview_start/);
});
