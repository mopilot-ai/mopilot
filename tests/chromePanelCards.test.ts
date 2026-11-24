// The approval cards Chrome's side panel answers (capabilities/browser/chromePanelCards.cjs): each card's question and choices, the answer a choice sends (the same as the app's card), and the cards left to MoPilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardOf, answerOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');
const { placed } = require('../electron/remote/phoneCards.cjs');

const keys = (c: any) => c.choices.map((x: any) => `${x.key}:${x.label}${x.deny ? ':deny' : ''}`);

test('a Remote Run control request tells a phone to check MoPilot on the Mac and can only be answered there', () => {
  const request = {
    id: 'sage-hostAsk-1',
    method: 'sage/hostAsk',
    params: { kind: 'hostAsk', title: 'Use Chrome on this Mac', macOnly: true, choices: [{ id: 'once', label: 'Allow once' }] },
  };
  const card = placed(cardOf(request, 'Codex'));
  assert.equal(card.title, 'Use Chrome on this Mac');
  assert.equal(card.where, 'mac-only');
  assert.equal(card.waitingCopy, 'Approve this Mac action in MoPilot.');
  assert.equal(card.choices, undefined);
  assert.equal(answerOf(request, 'once', 'Codex'), null);
});

test('Codex commands and file edits: allow once, for this session, or deny, as the app’s cards answer them', () => {
  const run = { id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } };
  assert.deepEqual(cardOf(run, 'Codex'), {
    id: 7,
    title: 'Run this command?',
    detail: 'npm test',
    choices: [
      { key: 'once', label: 'Allow once' },
      { key: 'session', label: 'Allow for this session' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  });
  assert.deepEqual(answerOf(run, 'once', 'Codex'), { decision: 'accept' });
  assert.deepEqual(answerOf(run, 'session', 'Codex'), { decision: 'acceptForSession' });
  assert.deepEqual(answerOf(run, 'deny', 'Codex'), { decision: 'decline' });
  assert.equal(answerOf(run, 'always', 'Codex'), null, 'a choice the card has not');
  // a command given as argv; a proposed rule is the app's card's to offer
  const argv = {
    id: 8,
    method: 'item/commandExecution/requestApproval',
    params: { command: ['ls', '-la'], proposedExecpolicyAmendment: ['ls'] },
  };
  assert.match(cardOf(argv, 'Codex').detail, /Permanent command prefix: \["ls"\]/);
  assert.match(cardOf(argv, 'Codex').detail, /ls -la/);
  assert.match(cardOf(argv, 'Codex').choices[1].confirm, /Permanently.*\["ls"\]/);
  assert.deepEqual(keys(cardOf(argv, 'Codex')), ['once:Allow once', 'similar:Always allow this prefix', 'deny:Deny:deny']);
  assert.equal(answerOf(argv, 'session', 'Codex'), null);
  assert.deepEqual(answerOf(argv, 'similar', 'Codex'), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } } });
  assert.equal(cardOf({ id: 9, method: 'item/commandExecution/requestApproval' }, 'Codex').detail, null);
  const edit = { id: 10, method: 'item/fileChange/requestApproval', params: { reason: 'fix the test' } };
  assert.deepEqual([cardOf(edit, 'Codex').title, cardOf(edit, 'Codex').detail], ['Allow Codex to edit files?', 'fix the test']);
  assert.deepEqual(answerOf(edit, 'session', 'Codex'), { decision: 'acceptForSession' });
  // why it asks, and where an edit would write
  const why = { id: 12, method: 'item/commandExecution/requestApproval', params: { command: 'make', reason: 'needs the network' } };
  assert.equal(cardOf(why, 'Codex').detail, 'make\n\nneeds the network');
  const outside = { id: 13, method: 'item/fileChange/requestApproval', params: { grantRoot: '/etc' } };
  assert.equal(cardOf(outside, 'Codex').detail, '/etc');
  const notebook = {
    id: 'cperm-9',
    method: 'claude/permission',
    params: { toolName: 'NotebookEdit', input: { notebook_path: '/w/a.ipynb' } },
  };
  assert.equal(cardOf(notebook, 'Claude Code').detail, '/w/a.ipynb');
  // a long detail is cut
  const long = cardOf({ id: 11, method: 'item/commandExecution/requestApproval', params: { command: 'x'.repeat(5000) } }, 'Codex');
  assert.equal(long.detail.length, 2000);
});

test('an undisplayable or malformed persistent command prefix is never offered or accepted', () => {
  for (const prefix of [undefined, [], 'rm', ['rm', 1], ['x'.repeat(3000)]]) {
    const request = {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'test', proposedExecpolicyAmendment: prefix },
    };
    assert.equal(answerOf(request, 'similar', 'Codex'), null);
    if (prefix !== undefined) assert.equal(answerOf(request, 'session', 'Codex'), null);
    assert.equal(
      cardOf(request, 'Codex').choices.some((c: any) => c.key === 'similar'),
      false,
    );
  }
});

test('Claude Code tools, its plan and WebFetch; Claude in Chrome’s own tool card is the app’s', () => {
  const tool = { id: 'cperm-1', method: 'claude/permission', params: { toolName: 'mcp__github__create_issue', input: { title: 'x' } } };
  const c = cardOf(tool, 'Claude Code');
  assert.equal(c.title, 'Allow Claude Code to use github · create_issue?');
  assert.equal(c.detail, JSON.stringify({ title: 'x' }, null, 2));
  assert.deepEqual(answerOf(tool, 'session', 'Claude Code'), { decision: 'acceptForSession' });
  assert.equal(
    cardOf({ id: 2, method: 'claude/permission', params: { toolName: 'Grep', title: 'Run make' } }, 'Claude Code').title,
    'Run make',
  );
  assert.equal(
    cardOf({ id: 2, method: 'claude/permission', params: { toolName: 'Grep', description: 'needs net' } }, 'Claude Code').title,
    'needs net',
  );
  const fetch = cardOf(
    { id: 3, method: 'claude/permission', params: { toolName: 'WebFetch', input: { url: 'https://a.example' } } },
    'Claude Code',
  );
  assert.deepEqual([fetch.title, fetch.detail], ['Allow Claude Code to fetch https://a.example?', null]);
  assert.equal(cardOf({ id: 3, method: 'claude/permission', params: {} }, 'Claude Code').title, 'Allow Claude Code to use ?');
  const plan = { id: 4, method: 'claude/permission', params: { toolName: 'ExitPlanMode' } };
  assert.deepEqual(keys(cardOf(plan, 'Claude Code')), ['once:Approve plan', 'deny:Deny:deny']);
  assert.deepEqual(answerOf(plan, 'once', 'Claude Code'), { decision: 'accept' });
  // the plan travels with the card so a client can read it before approving; a file shows by name only
  assert.deepEqual(cardOf(plan, 'Claude Code').plan, { text: '' });
  const written = {
    ...plan,
    params: { toolName: 'ExitPlanMode', input: { plan: '1. Do it', planFilePath: '/Users/me/.claude/plans/a.md' } },
  };
  assert.deepEqual(
    [cardOf(written, 'Claude Code').kind, cardOf(written, 'Claude Code').plan],
    ['plan', { text: '1. Do it', file: 'a.md' }],
  );
  const winFile = { ...plan, params: { toolName: 'ExitPlanMode', input: { plan: 'x', planFilePath: 'C:\\plans\\b.md' } } };
  assert.equal(cardOf(winFile, 'Claude Code').plan.file, 'b.md');
  const long = { ...plan, params: { toolName: 'ExitPlanMode', input: { plan: 'p'.repeat(20001) } } };
  assert.deepEqual([cardOf(long, 'Claude Code').plan.text.length, cardOf(long, 'Claude Code').plan.clipped], [20000, true]);
  const pair = { ...plan, params: { toolName: 'ExitPlanMode', input: { plan: `${'p'.repeat(19999)}😀tail` } } };
  assert.equal(cardOf(pair, 'Claude Code').plan.text, 'p'.repeat(19999));
  const chrome = { id: 5, method: 'claude/permission', params: { toolName: 'mcp__claude-in-chrome__navigate' } };
  assert.equal(cardOf(chrome, 'Claude Code').inApp, undefined);
  assert.deepEqual(answerOf(chrome, 'once', 'Claude Code'), { decision: 'accept' });
});

test('a basic harness’s permission: its own options, the first allow first, its reject as Deny', () => {
  const ask = {
    id: 'r1',
    method: 'acp/permission',
    params: {
      toolCall: { title: 'Edit main.py' },
      options: [
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      ],
    },
  };
  const c = cardOf(ask, 'Gemini');
  assert.equal(c.title, 'Gemini wants to: Edit main.py');
  assert.deepEqual(keys(c), ['o0:Allow', 'o1:Always allow', 'deny:Deny:deny']);
  assert.deepEqual(answerOf(ask, 'o0', 'Gemini'), { optionId: 'yes' });
  assert.deepEqual(answerOf(ask, 'o1', 'Gemini'), { optionId: 'always' });
  assert.deepEqual(answerOf(ask, 'deny', 'Gemini'), { optionId: 'no' });
  assert.equal(cardOf({ id: 'r2', method: 'acp/permission', params: {} }, 'Gemini').title, 'Gemini is asking for permission');
});

test('MoPilot’s site and app cards: once, always (or this chat), decline; the rest are the app’s', () => {
  const site = {
    id: 's1',
    method: 'sage/browserOrigin',
    params: { kind: 'browserOrigin', browser: 'chrome', origin: 'https://example.com', level: 'write' },
  };
  const c = cardOf(site, 'Claude Code');
  assert.equal(c.title, 'Allow Claude Code to use https://example.com in your Chrome?');
  assert.deepEqual(keys(c), ['once:Allow once', 'chat:Allow in this chat', 'always:Always allow on this site', 'deny:Decline:deny']);
  assert.deepEqual(answerOf(site, 'once', 'Claude Code'), { decision: 'allow', scope: 'once', level: 'write' });
  assert.deepEqual(answerOf(site, 'always', 'Claude Code'), { decision: 'allow', scope: 'always', level: 'write' });
  assert.deepEqual(answerOf(site, 'deny', 'Claude Code'), { decision: 'deny' });
  // never "always" for a risky site or a local server's write: this chat instead
  for (const params of [{ allowAlways: false }, { allowAlways: 'read' }]) {
    const p = { id: 's2', method: 'sage/browserOrigin', params: { kind: 'browserOrigin', origin: 'http://localhost:3000', ...params } };
    assert.ok(keys(cardOf(p, 'Codex')).includes('chat:Allow in this chat'));
    assert.equal(keys(cardOf(p, 'Codex')).includes('always:Always allow on this site'), false);
    assert.equal(answerOf(p, 'always', 'Codex'), null);
    assert.deepEqual(answerOf(p, 'chat', 'Codex'), { decision: 'allow', scope: 'chat', level: undefined });
  }
  assert.equal(
    cardOf({ id: 's3', method: 'sage/browserOrigin', params: { kind: 'browserOrigin', origin: 'https://a.example' } }, 'Codex').title,
    'Allow Codex to use https://a.example in the browser?',
  );
  // a paired computer's card is the app's: it says which computer acts and gets the answer
  const remote = {
    id: 's9',
    method: 'sage/browserOrigin',
    params: { kind: 'browserOrigin', origin: 'https://a.example', remote: { hostName: 'mini' } },
  };
  assert.match(cardOf(remote, 'Codex').title, /on mini/);
  assert.deepEqual(answerOf(remote, 'once', 'Codex'), { decision: 'allow', scope: 'once', level: undefined });
  assert.equal(answerOf(remote, 'always', 'Codex'), null);
  const app = { id: 's4', method: 'sage/computerAccess', params: { kind: 'computerAccess', app: { name: 'Notes' } } };
  assert.equal(cardOf(app, 'Codex').title, 'Allow Codex to use Notes?');
  assert.equal(
    cardOf({ id: 's5', method: 'sage/computerAccess', params: { kind: 'computerAccess' } }, 'Codex').title,
    'Allow Codex to use this app?',
  );
  for (const kind of ['computerConfirm', 'visionConsent', 'devServer'])
    assert.equal(cardOf({ id: 's6', method: `sage/${kind}`, params: { kind } }, 'Codex').inApp, undefined, kind);
  // a question, a form or a card this panel doesn't know: answered in MoPilot
  for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'execCommandApproval'])
    assert.equal(cardOf({ id: 1, method }, 'Codex').inApp, undefined, method);
  assert.equal(cardOf({ id: 1, method: 'something/new' }, 'Codex').inApp, true);
  assert.equal(answerOf({ id: 1, method: 'something/new' }, 'once', 'Codex'), null);
  assert.equal(cardOf({ id: 1, method: 'item/fileChange/requestApproval' }, 'Codex').detail, null);
  assert.deepEqual(answerOf({ id: 1, method: 'item/fileChange/requestApproval' }, 'once', 'Codex'), { decision: 'accept' });
});
