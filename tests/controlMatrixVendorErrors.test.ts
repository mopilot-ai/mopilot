// The control matrix (docs/control-plane/matrix.md), VendorErrors rows: every place that reads a vendor control
// error (the thread step's problem, the step's hand-off, Claude in Chrome's link reading in main, the Codex
// lifecycle's Sky report) reads it through the one table in shared/vendorErrors.mjs, so a real vendor wording
// reads the same everywhere and the model's tool result is left as the vendor sent it. The narration,
// ChromeLink and the table are real; vendor results are the real wordings in tests/fixtures/vendor-error-wordings.json.
// Case ids (CM-U..) start every title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { controlHandoff, controlStep } from '../src/lib/agentNarration.ts';
import { skyProblemOfItem } from '../shared/skyComputerUse.mjs';
import { CHROME_LINK_DOWN, VENDOR_SOURCES, chromeLinkDown, vendorErrorByWording } from '../shared/vendorErrors.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/lib/', 'tests/fixtures/vendor-error-wordings.json'];

const require = createRequire(import.meta.url);
const { ChromeLink } = require('../electron/harness/claude/chromeLink.cjs');

type Case = { source: 'cua' | 'claudeInChrome' | 'yourChrome'; status: string; kind: string | null; from: string; text: string };
const { cases } = JSON.parse(readFileSync(new URL('./fixtures/vendor-error-wordings.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};
const chromeCases = cases.filter((c) => c.source === 'claudeInChrome');

let seq = 0;
/** A Claude Code tool call item of Claude in Chrome's `tool`, ended as `status` with `text`. */
const chromeItem = (tool: string, text: string, status = 'failed') => ({
  id: `c${++seq}`,
  type: 'mcpToolCall',
  server: 'claude',
  tool: `mcp__claude-in-chrome__${tool}`,
  arguments: { action: 'left_click', coordinate: [10, 10] },
  status,
  error: status === 'failed' ? { message: text } : null,
  result: { content: [{ type: 'text', text }] },
});
/** A Codex cua_repl program that clicks in an app, ended as `status` with `text`. */
const cuaItem = (text: string, status: string) => ({
  id: `x${++seq}`,
  type: 'mcpToolCall',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code: "const app = await sky.app('Notes');\nawait app.click({ x: 10, y: 10 });", title: 'Click in Notes' },
  status,
  result: { content: [{ type: 'text', text }] },
});

/** What one Claude Code session's link watcher makes of a Claude in Chrome tool error: 'error' when it reads the link again. */
function linkNote(text: string) {
  const link = new ChromeLink();
  link.note({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__claude-in-chrome__computer' }] } });
  return link.note({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: text }] } });
}

const NOT_CONNECTED = chromeCases.filter((c) => c.kind === 'chromeDisconnected');

test("CM-U01: Claude in Chrome's 'Browser extension is not connected' reads as not connected with a next step, and the session reads its link again", () => {
  assert.ok(NOT_CONNECTED.length >= 3, 'every wording the CLI sends');
  for (const c of NOT_CONNECTED) {
    const p = controlStep(chromeItem('computer', c.text))?.problem;
    assert.equal(p?.kind, 'chromeDisconnected', c.text);
    assert.equal(p?.title, "Claude in Chrome isn't connected");
    assert.deepEqual(p?.actions, [
      { kind: 'settings', label: 'Browser settings', section: 'browser' },
      { kind: 'send', label: 'Try again', text: 'Try that step again.' },
    ]);
    assert.equal(linkNote(c.text), 'error', c.text);
  }
});

test("CM-U02: a Claude in Chrome error about the page or the network is not read as the extension's link going away", () => {
  for (const text of [
    'Navigation failed: net::ERR_INTERNET_DISCONNECTED',
    'Uncaught Error: WebSocket is not connected',
    'No element matches the "Reconnect" button',
    'The "find" tool call failed unexpectedly. This is usually transient — retry the same call in a few seconds.',
  ]) {
    assert.equal(linkNote(text), null, text);
    assert.equal(chromeLinkDown(text), false, text);
  }
  assert.equal(chromeLinkDown(undefined), false);
});

test('CM-U03: a Claude in Chrome call that lost its connection or got no answer reads as that problem, not as Chrome waiting for the user', () => {
  for (const c of chromeCases.filter((x) => x.kind === 'chromeConnectionLost' || x.kind === 'chromeNoResponse')) {
    const item = chromeItem('computer', c.text);
    const p = controlStep(item)?.problem;
    assert.equal(p?.kind, c.kind, c.text);
    assert.ok(p?.hint, 'a next step');
    // "Chrome may be waiting for the user" is the vendor's guess after a timeout, not a hand-off
    assert.equal(controlHandoff(item), null, c.text);
    // only a lost connection says the extension went away
    assert.equal(linkNote(c.text), c.kind === 'chromeConnectionLost' ? 'error' : null, c.text);
  }
  // a real hand-off still is one, also when the page it worked on quotes a vendor sentence
  const signIn = { where: 'chrome', reason: 'signIn', url: null, tabId: null };
  assert.deepEqual(controlHandoff(chromeItem('computer', 'Login is required: waiting for the user to sign in.', 'completed')), signIn);
  const quoted = 'Login is required: waiting for the user to sign in. The help page says: The "computer" tool did not respond in time.';
  assert.deepEqual(controlHandoff(chromeItem('computer', quoted, 'completed')), signIn);
});

test('CM-U04: every real vendor wording reads the same in every reader of the vendor error table, and the model gets it as sent', () => {
  for (const c of cases) {
    // Your Chrome's Playwright MCP errors are read by its own tools (CM-U05), not as a vendor runtime's thread step
    if (c.source === 'yourChrome') {
      assert.equal(vendorErrorByWording(c.text, VENDOR_SOURCES.yourChrome)?.row.kind ?? null, c.kind, `${c.from}: ${c.text}`);
      continue;
    }
    if (c.source === 'claudeInChrome') {
      const item = chromeItem('computer', c.text, c.status);
      const before = JSON.stringify(item);
      assert.equal(controlStep(item)?.problem?.kind ?? null, c.kind, `${c.from}: ${c.text}`);
      assert.equal(controlHandoff(item), null, `${c.from}: ${c.text}`);
      assert.equal(linkNote(c.text) === 'error', CHROME_LINK_DOWN.includes(c.kind as never), `${c.from}: ${c.text}`);
      assert.equal(JSON.stringify(item), before, 'the tool result is not rewritten');
    } else {
      const item = cuaItem(c.text, c.status);
      // the Codex lifecycle in main (Settings' Sky report) and the thread step agree
      const main = skyProblemOfItem(item)?.kind ?? null;
      assert.equal(main, c.kind, `${c.from}: ${c.text}`);
      assert.equal(controlStep(item)?.problem?.kind ?? null, main, `${c.from}: ${c.text}`);
      assert.equal(controlHandoff(item), null, `${c.from}: ${c.text}`);
    }
  }
});
