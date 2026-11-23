// The panel's site permission card words itself as one "MoPilot needs your OK" card (capabilities/browser/chromePanelPermissionCard.cjs), on every card that asks for a site, and leaves every other card's words alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardOf, answerOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');

const site = (params: any = {}) => ({
  id: 's1',
  method: 'sage/browserOrigin',
  params: { kind: 'browserOrigin', browser: 'chrome', origin: 'https://example.com', level: 'write', ...params },
});
const shortcuts = (c: any) => c.choices.map((x: any) => `${x.key}:${x.shortcut ?? '-'}`);

test('a site card has the heading and reminder, Enter allows this action, Esc declines, Cmd+Enter allows the site always', () => {
  const c = cardOf(site(), 'Codex');
  assert.equal(c.heading, 'MoPilot needs your OK');
  assert.equal(c.note, 'MoPilot asks you first before it buys anything, creates an account, or gets past a CAPTCHA.');
  assert.deepEqual(shortcuts(c), ['once:enter', 'chat:-', 'always:mod-enter', 'deny:escape']);
  // the keys still map to the same answers the app's card sends
  assert.deepEqual(answerOf(site(), 'once', 'Codex'), { decision: 'allow', scope: 'once', level: 'write' });
  assert.deepEqual(answerOf(site(), 'always', 'Codex'), { decision: 'allow', scope: 'always', level: 'write' });
  assert.deepEqual(answerOf(site(), 'deny', 'Codex'), { decision: 'deny' });
});

test('a read-only grant keeps its own wording and the Cmd+Enter key; a paired computer offers no standing grant', () => {
  const read = cardOf(site({ allowAlways: 'read' }), 'Codex');
  assert.deepEqual(
    read.choices.map((x: any) => `${x.key}:${x.label}`),
    ['once:Allow once', 'chat:Allow in this chat', 'alwaysRead:Always allow reading on this site', 'deny:Decline'],
  );
  assert.deepEqual(shortcuts(read), ['once:enter', 'chat:-', 'alwaysRead:mod-enter', 'deny:escape']);
  assert.deepEqual(answerOf(site({ allowAlways: 'read' }), 'alwaysRead', 'Codex'), { decision: 'allow', scope: 'always', level: 'read' });
  const remote = cardOf(site({ remote: { hostName: 'mini' } }), 'Codex');
  assert.deepEqual(shortcuts(remote), ['once:enter', 'chat:-', 'deny:escape']);
});

test('Claude in Chrome’s tool card has the same heading, wording and keys, with its saved rule on Cmd+Enter', () => {
  const tool = {
    id: 'cperm-1',
    method: 'claude/permission',
    params: {
      toolName: 'mcp__claude-in-chrome__navigate',
      input: { url: 'https://example.com' },
      suggestions: [
        { type: 'addRules', rules: [{ toolName: 'mcp__claude-in-chrome__navigate' }], behavior: 'allow', destination: 'session' },
      ],
    },
  };
  const c = cardOf(tool, 'Claude Code');
  assert.equal(c.heading, 'MoPilot needs your OK');
  assert.match(c.note, /before it buys anything/);
  assert.equal(c.choices[0].label, 'Allow once');
  assert.equal(c.choices[2].label, 'Decline');
  assert.deepEqual(shortcuts(c), ['once:enter', 'session:mod-enter', 'deny:escape']);
  assert.deepEqual(answerOf(tool, 'once', 'Claude Code'), { decision: 'accept' });
  assert.deepEqual(answerOf(tool, 'session', 'Claude Code'), { decision: 'acceptForSession' });
  assert.deepEqual(answerOf(tool, 'deny', 'Claude Code'), { decision: 'decline' });
  // no saved rule offered: just allow and decline
  assert.deepEqual(shortcuts(cardOf({ ...tool, params: { ...tool.params, suggestions: [] } }, 'Claude Code')), [
    'once:enter',
    'deny:escape',
  ]);
});

test('cards that are not a site permission keep their wording, with no heading, reminder or key', () => {
  const others = [
    { id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } },
    { id: 2, method: 'sage/computerAccess', params: { kind: 'computerAccess', app: { name: 'Notes' } } },
    { id: 3, method: 'sage/visionConsent', params: { kind: 'visionConsent' } },
    { id: 4, method: 'claude/permission', params: { toolName: 'Grep' } },
    { id: 5, method: 'claude/permission', params: { toolName: 'ExitPlanMode' } },
  ];
  for (const a of others) {
    const c = cardOf(a, 'Codex');
    assert.equal(c.heading, undefined, String(a.method));
    assert.equal(c.note, undefined, String(a.method));
    assert.deepEqual(
      c.choices.filter((x: any) => x.shortcut),
      [],
      String(a.method),
    );
  }
  const readOnly = cardOf({ id: 6, method: 'sage/computerAccess', params: { kind: 'computerAccess', allowAlways: 'read' } }, 'Codex');
  assert.deepEqual(
    readOnly.choices.map((x: any) => x.label),
    ['Allow once', 'Allow in this chat', 'Always allow reading', 'Deny'],
  );
  const app = cardOf(others[1], 'Codex');
  assert.deepEqual(
    app.choices.map((x: any) => x.label),
    ['Allow once', 'Allow in this chat', 'Always allow', 'Deny'],
  );
});
