// A tool name a model guesses is told the tool to use (#1699: Codex called chrome_click four times; the real tool is
// chrome_computer): registry.unknownMessage on every harness's channel (Registry.invoke, Codex's item/tool/call in
// serverRequests.cjs), with the chrome_* tools' hint (chromeTools.cjs guessedTool) while they are registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { codexServerRequests } = require('../electron/capabilities/contract/serverRequests.cjs');
const { guessedTool, registerChromeTools, CHROME_TOOL_NAMES } = require('../electron/capabilities/browser/chromeTools.cjs');

test('guessedTool: a guessed computer action, a guessed tool name, any other chrome_ name; other prefixes are not its business', () => {
  assert.match(
    guessedTool('chrome_click'),
    /^chrome_click is not a tool\. Use chrome_computer with action "left_click"\. The Chrome tools are: chrome_/,
  );
  assert.match(guessedTool('chrome_drag'), /action "left_click_drag"/);
  assert.match(guessedTool('chrome_goto'), /Use chrome_navigate\./);
  assert.match(guessedTool('chrome_evaluate'), /Use chrome_javascript_tool\./);
  const other = guessedTool('chrome_teleport');
  assert.match(other, /^chrome_teleport is not a tool\. The Chrome tools are: /);
  assert.ok(CHROME_TOOL_NAMES.every((n: string) => other.includes(n)));
  // inherited names are not guesses
  assert.doesNotMatch(guessedTool('chrome_toString'), /Use /);
  assert.equal(guessedTool('browser_click'), null);
});

test('registry: an unknown tool is told what a hint knows, else "Unknown tool"; the chrome_* hint goes with its tools', async () => {
  const registry = new Registry();
  assert.equal(registry.unknownMessage('chrome_click'), 'Unknown tool: chrome_click');
  const tabs: any = { list: () => [] };
  const off = registerChromeTools(registry, { tabs, grants: {}, enabled: () => true });
  const res = await registry.invoke('c', 's', 'chrome_click', {});
  assert.equal(res.error.code, 'unknown_tool');
  assert.match(res.error.message, /Use chrome_computer with action "left_click"/);
  // Codex's dynamic tool calls are told the same
  const sent: any[] = [];
  const handle = codexServerRequests({ send: (m: any) => sent.push(m), registry });
  handle({ id: 1, method: 'item/tool/call', params: { tool: 'chrome_click', threadId: 't' } });
  assert.match(sent[0].error.message, /Use chrome_computer/);
  handle({ id: 2, method: 'item/tool/call', params: { tool: 'nope', threadId: 't' } });
  assert.equal(sent[1].error.message, 'Unknown tool: nope');
  off();
  assert.equal(registry.unknownMessage('chrome_click'), 'Unknown tool: chrome_click');
});

test('the computer tool does not ask for a screenshot before a click by ref: navigate and click results already list the elements (#3810 BU step cost)', () => {
  const { TOOLS } = require('../electron/capabilities/browser/chromeTools.cjs');
  assert.match(TOOLS.computer.description, /Click by ref \(navigate and click results list the page's elements\) with no screenshot/);
  assert.match(TOOLS.computer.description, /look at one before clicking by coordinates/);
});
