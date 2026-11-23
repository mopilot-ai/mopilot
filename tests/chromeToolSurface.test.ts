// What a model reads about the Chrome tools before it calls one (#3810 BU first action: 33 s of discovery in a recorded run): the surface note names where to start, and the tab id description is one short line instead of repeating the group sentence on every tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { surfaceNote } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');

test('the note says to start with chrome_tabs_context_mcp, then chrome_navigate, when both are listed; otherwise it names no start', () => {
  const both = surfaceNote(['chrome_tabs_context_mcp', 'chrome_navigate', 'chrome_computer'], { yourChrome: false });
  assert.match(both, /the chrome_\* tools \(start with chrome_tabs_context_mcp, then chrome_navigate\)\. Use them only when/);
  assert.doesNotMatch(surfaceNote(['chrome_navigate'], { yourChrome: false }), /start with/);
  assert.doesNotMatch(surfaceNote(['chrome_tabs_context_mcp'], { yourChrome: false }), /start with/);
  // the in-app browser's own start line is unchanged, and the Chrome one is not added to it
  assert.match(surfaceNote(['browser_navigate'], { yourChrome: true }), /browser/);
});

test('every Chrome tool takes tabId described in one short line', () => {
  const tools = createChromeTools({ tabs: { state: () => '' }, grants: {}, confirm: async () => true });
  const described = tools.map((t: any) => t.schema.properties?.tabId?.description).filter(Boolean);
  assert.ok(described.length > 15);
  assert.ok(described.filter((d: string) => d === 'A tab id from tabs_context_mcp.').length > 15);
  for (const d of described) assert.ok(d.length < 60, d);
});
