// The tools that return an image tell a Codex exec script how to read it (#3810): image(c) per content item, since text(r) prints the base64 into the context for every later step. The sentence is on the screenshot and batch tools of each surface and in the computer-use skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { browserToolSpecs, desktopToolSpecs, appToolSpecs } from './support/tool-specs.ts';

const require = createRequire(import.meta.url);
const { TOOLS } = require('../electron/capabilities/browser/chromeTools.cjs');
const HINT = /image\(c\) per content item; text\(r\) prints its bytes/;
const description = (list: any[], name: string) => list.find((s: any) => s.name === name).description;

test('screenshot and batch tools of the built-in browser, Chrome, desktop and app surfaces say to read an image with image(c)', () => {
  for (const n of ['browser_computer', 'browser_batch']) assert.match(description(browserToolSpecs(), n), HINT, n);
  for (const n of ['computer', 'browser_batch']) assert.match(TOOLS[n].description, HINT, `chrome ${n}`);
  assert.match(description(desktopToolSpecs(), 'desktop_screenshot'), HINT);
  assert.match(description(appToolSpecs(), 'desktop_app_screenshot'), HINT);
});

test('the computer-use skill says it too', () => {
  const skill = fs.readFileSync(new URL('../electron/plugins/builtin/mopilot/skills/computer-use/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /read an image result with `image\(c\)` per content item; `text\(r\)` prints its bytes/);
});
