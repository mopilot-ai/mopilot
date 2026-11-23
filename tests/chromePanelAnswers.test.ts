// Chrome's side panel answering a card and stopping a chat (app/chromePanel.cjs): each harness's own answer path, the cards that come with a chat's rows, and Stop.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-panel-answers-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('retained native and host cards name the asking harness even after the chat changes', async () => {
  const state = new SessionStore();
  const approvals = [
    {
      id: 'old',
      method: 'acp/permission',
      sourceHarness: 'acp:kimi',
      params: { toolCall: { title: 'Act' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
    },
    {
      id: 'host',
      method: 'sage/browserOrigin',
      params: { harness: 'claude', kind: 'browserOrigin', origin: 'https://a.example', level: 'read' },
    },
  ];
  state.patch('chat', { approvals });
  const answered: unknown[] = [];
  const records = new Map([['chat', { segments: [{ kind: 'codex', nativeId: 'chat' }], meta: {} }]]);
  const live: any = {
    chats: { records },
    controller: { state, ref: () => ({ kind: 'codex' }), resolveApproval() {} },
    peerRuntime: { readHistory: async () => ({ turns: [], earlierContentOmitted: false }) },
    acpHost: { permission: (id: string, option: string) => (answered.push([id, option]), true) },
    acpAdmission: { list: () => [{ id: 'kimi', label: 'Kimi Code' }] },
  };
  const panel = createChromePanel({
    live,
    claude: {},
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open() {},
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  const read = (await ask('read', { chatId: 'chat' })).result;
  assert.equal(read.approvals[0].title, 'Kimi Code wants to: Act');
  assert.equal(read.approvals[1].title, 'Allow Claude Code to use https://a.example in the browser?');
  const answer = await ask('answer', { chatId: 'chat', approvalId: 'old', choice: 'o0', version: read.approvals[0].version });
  assert.equal(answer.result.answered, true);
  assert.deepEqual(answered, [['old', 'yes']]);
});

test('a card’s answer goes through the harness that asked, as the window’s does; Stop stops the chat on any harness', async () => {
  const calls: any[] = [];
  const approvals: any[] = [
    { id: 's1', method: 'sage/browserOrigin', params: { kind: 'browserOrigin', origin: 'https://a.example', level: 'read' } },
    {
      id: 'cperm-1',
      // as main holds Claude Code's request (session/controllerEvents.cjs), never the window's card
      method: 'claude/permission',
      params: { toolName: 'Bash', input: { command: 'ls' }, suggestions: [{ r: 1 }] },
    },
    { id: 'cperm-2', method: 'claude/permission', params: { toolName: 'Bash' } },
    { id: 'p1', method: 'acp/permission', params: { options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } },
    { id: 12, method: 'item/commandExecution/requestApproval', params: { command: 'make' } },
    { id: 13, method: 'item/commandExecution/requestApproval', params: { command: 'rm' } },
    { id: 14, method: 'item/tool/requestUserInput', params: {} },
  ];
  const state = new SessionStore();
  state.patch('th-1', { turn: 'awaitingUser', approvals });
  const live: any = {
    chats: { records: new Map([['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} }]]) },
    controller: {
      state,
      chatOf: (k: string) => k,
      ref: () => ({ kind: 'codex' }),
      resolveApproval: (id: string) => calls.push(['resolveApproval', id]),
      onCodexOutgoing: (m: any) => (calls.push(['onCodexOutgoing', m]), m.id !== 13),
      stopChat: async (id: string) => calls.push(['stopChat', id]),
    },
    acpAdmission: { list: () => [], admitted: () => true },
    peerRuntime: {
      readReference: async () => ({ turns: [], earlierContentOmitted: false }),
      readHistory: async () => ({ turns: [], earlierContentOmitted: false }),
    },
    computerUse: { broker: { answer: (id: string, r: any) => (calls.push(['broker', id, r]), true) } },
    acpHost: { permission: (id: string, optionId: any) => (calls.push(['acp', id, optionId]), true) },
    codex: { respond: (id: any, r: any) => calls.push(['codex', id, r]) },
    siteConsent: { answered: (id: any) => calls.push(['siteConsent', id]) },
  };
  const panel = createChromePanel({
    live,
    claude: { resolvePermission: (id: string, a: any) => (calls.push(['claude', id, a]), true) },
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({}),
    usable: async () => true,
    starter: { prefs: () => ({}), chats: { patchMeta: () => undefined }, started: () => undefined },
    send: async () => undefined,
    open: () => undefined,
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  const answer = (approvalId: any, choice: string) =>
    ask('answer', { chatId: 'th-1', approvalId, choice, version: read.approvals.find((a: any) => a.id === approvalId)?.version });
  // the chat's cards come with its rows
  const read = (await ask('read', { chatId: 'th-1' })).result;
  assert.deepEqual(
    read.approvals.map((c: any) => [c.id, c.inApp ?? false]),
    [
      ['s1', false],
      ['cperm-1', false],
      ['cperm-2', false],
      ['p1', false],
      [12, false],
      [13, false],
      [14, false],
    ],
  );
  assert.equal(read.approvals[0].title, 'Allow Codex to use https://a.example in the browser?');
  // MoPilot's own card: its broker
  assert.deepEqual((await answer('s1', 'once')).result, { answered: true });
  assert.deepEqual(calls.at(-1), ['broker', 's1', { decision: 'allow', scope: 'once', level: 'read' }]);
  // Claude Code: the card goes, and the CLI gets the Agent SDK's answer with the rules it proposed
  await answer('cperm-1', 'session');
  assert.deepEqual(calls.slice(-2), [
    ['resolveApproval', 'cperm-1'],
    ['claude', 'cperm-1', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ r: 1 }] }],
  ]);
  await answer('cperm-2', 'deny');
  assert.deepEqual(calls.at(-1), ['claude', 'cperm-2', { behavior: 'deny', message: 'The user declined this action.' }]);
  // a basic harness: the option picked
  await answer('p1', 'o0');
  assert.deepEqual(calls.slice(-2), [
    ['resolveApproval', 'p1'],
    ['acp', 'p1', 'yes'],
  ]);
  // Codex: only a card main still holds goes to the app-server
  await answer(12, 'once');
  assert.deepEqual(calls.slice(-3), [
    ['onCodexOutgoing', { id: 12, result: { decision: 'accept' } }],
    ['codex', 12, { decision: 'accept' }],
    ['siteConsent', 12],
  ]);
  assert.equal((await answer(13, 'deny')).error, 'That request was already answered.');
  assert.deepEqual(calls.at(-1), ['onCodexOutgoing', { id: 13, result: { decision: 'decline' } }]);
  // gone, a choice the card hasn't, or a card the panel doesn't answer
  assert.equal((await answer('nope', 'once')).error, 'That request was already answered.');
  assert.equal((await answer(12, 'always')).error, 'Choose an option offered by this request.');
  assert.equal((await answer(14, 'once')).error, 'Choose an option offered by this request.');
  for (const bad of [
    { approvalId: 1.5, choice: 'once' },
    { approvalId: 's1', choice: '' },
    { approvalId: 's1', choice: 5 },
    { approvalId: null, choice: 'once' },
  ])
    assert.equal((await ask('answer', { chatId: 'th-1', ...bad })).error, 'Pick one of the choices.');
  // Stop
  assert.deepEqual((await ask('stop', { chatId: 'th-1' })).result, { stopped: true });
  assert.deepEqual(calls.at(-1), ['stopChat', 'th-1']);
  assert.equal((await ask('stop', {})).error, "That chat isn't in MoPilot.");
  // no computer use set up, a chat with no harness yet: nothing to answer with, and "The agent" asks
  live.computerUse = undefined;
  assert.equal((await answer('s1', 'deny')).error, 'That request was already answered.');
  live.chats.records.clear();
  live.controller.ref = () => undefined;
  assert.equal(
    (await ask('read', { chatId: 'th-1' })).result.approvals[0].title,
    'Allow The agent to use https://a.example in the browser?',
  );
  state.patch('th-1', { approvals: [] });
  assert.deepEqual((await ask('read', { chatId: 'th-1' })).result.approvals, []);
});
