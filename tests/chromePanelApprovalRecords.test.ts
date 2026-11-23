// Chrome's side panel reads the approvals main itself holds (session/controllerEvents.cjs) on every harness: a card built from each harness's real request record, and its answer back through that harness with what the request asked about (#2114).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-panel-records-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const KIND: Record<string, string> = { cl1: 'claude', cx1: 'codex', ac1: 'acp:gemini' };

for (const change of ['withdrawn', 'reused', 'deleted'])
  test(`a managed-policy read retires the ${change} request snapshot`, async () => {
    const replaced = change === 'reused';
    const { controller, state, ask, live } = setup();
    live.codex.request = async () => ({});
    controller.onCodexMessage({
      id: 701,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'cx1',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          connector_id: 'browser-use',
          codex_approval_kind: 'mcp_tool_call',
          tool_name: 'access_browser_origin',
          origin: 'https://example.org',
          persist: ['always'],
        },
      },
    });
    const first = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
    const original = state.get('cx1').approvals[0];
    let finish: any;
    live.codex.request = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = ask('read', { chatId: 'cx1' });
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    state.patch('cx1', { approvals: [] });
    if (change === 'deleted') live.chats.records.delete('cx1');
    if (replaced) state.patch('cx1', { approvals: [structuredClone(original)] });
    finish({});
    const response = await pending;
    if (change === 'deleted') assert.equal(response.error, "That chat isn't in MoPilot.");
    else assert.deepEqual(response.result.approvals, []);
    if (replaced) {
      live.codex.request = async () => ({});
      const next = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
      assert.notEqual(next.version, first.version);
    }
  });

test('an unopened chat has a stable default live state for the panel without a window', () => {
  const state = new SessionStore();
  assert.equal(state.has('unopened'), false);
  const first = state.get('unopened');
  assert.deepEqual(first.approvals, []);
  assert.deepEqual(first.questions, []);
  assert.equal(state.get('unopened'), first);
});

function setup() {
  const rec = (id: string) => ({ id, segments: [{ kind: KIND[id], nativeId: id }], meta: {} });
  const records = new Map(Object.keys(KIND).map((id) => [id, rec(id)]));
  const state = new SessionStore();
  const controller = new ChatController({ state, chats: { record: rec, records }, codex: {}, claudeTurns: {}, acpTurns: {} });
  for (const id of Object.keys(KIND)) state.patch(id, { turn: 'running' });
  const calls: any[] = [];
  const live: any = {
    chats: { records },
    controller,
    acpAdmission: { list: () => [{ id: 'gemini', label: 'Gemini' }], admitted: () => true },
    peerRuntime: {
      readReference: async () => ({ turns: [], earlierContentOmitted: false }),
      readHistory: async () => ({ turns: [], earlierContentOmitted: false }),
    },
    acpHost: { permission: (id: string, optionId: unknown) => (calls.push(['acp', id, optionId]), true) },
    codex: { respond: (id: unknown, r: unknown) => calls.push(['codex', id, r]) },
  };
  const panel = createChromePanel({
    live,
    claude: { resolvePermission: (id: string, a: unknown) => (calls.push(['claude', id, a]), true) },
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
  return { controller, state, calls, ask, live };
}

/** Claude Code's CLI asking about a tool, as electron/harness/claude/sessions.cjs relays it. */
const claudeAsks = (controller: any, requestId: string, toolName: string, input: object, extra: object = {}) =>
  controller.onClaudeEvent({ kind: 'permission', key: 'cl1', requestId, toolName, input, ...extra });

test('Claude Code’s own requests get the panel’s cards and are answered with their input and rules (#2114)', async () => {
  const { controller, state, calls, ask } = setup();
  claudeAsks(controller, 'cperm-1', 'Bash', { command: 'ls -la' }, { suggestions: [{ type: 'addRules' }], description: 'List files' });
  claudeAsks(controller, 'cperm-2', 'Write', { file_path: '/w/a.txt', content: 'x' }, { description: 'Write a.txt' });
  claudeAsks(controller, 'cperm-3', 'WebFetch', { url: 'https://a.example' });
  claudeAsks(controller, 'cperm-4', 'ExitPlanMode', { plan: 'Do it' });
  claudeAsks(controller, 'cperm-5', 'AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'a' }] }] });
  claudeAsks(controller, 'cperm-6', 'mcp__claude-in-chrome__navigate', { url: 'https://a.example' });
  // what main holds is the CLI's request as it came, never the window's card
  assert.deepEqual(
    state.get('cl1').approvals.map((a: any) => a.method),
    Array(6).fill('claude/permission'),
  );
  const cards = (await ask('read', { chatId: 'cl1' })).result.approvals;
  assert.deepEqual(
    cards.map((c: any) => [c.id, c.title, c.inApp ? 'inApp' : c.choices.map((x: any) => x.key).join(',')]),
    [
      ['cperm-1', 'Run this command?', 'once,session,deny'],
      ['cperm-2', 'Allow Claude Code to edit files?', 'once,session,deny'],
      ['cperm-3', 'Allow Claude Code to fetch https://a.example?', 'once,session,deny'],
      ['cperm-4', 'Ready to start on this plan?', 'once,deny'],
      // a question and Claude in Chrome's tool card are the app's
      ['cperm-5', 'A question for you', 'submit,skip'],
      ['cperm-6', 'Allow Claude Code to Open a page on a.example?', 'once,deny'],
    ],
  );
  // the command or the file, and why the CLI asks
  assert.equal(cards[0].detail, 'ls -la\n\nList files');
  assert.equal(cards[1].detail, '/w/a.txt\n\nWrite a.txt');
  // Allow for this session: the CLI gets back the very input it asked about and the rules it proposed
  assert.deepEqual(
    (
      await ask('answer', {
        chatId: 'cl1',
        approvalId: 'cperm-1',
        choice: 'session',
        version: cards.find((c: any) => c.id === 'cperm-1').version,
      })
    ).result,
    { answered: true },
  );
  assert.deepEqual(calls.at(-1), [
    'claude',
    'cperm-1',
    { behavior: 'allow', updatedInput: { command: 'ls -la' }, updatedPermissions: [{ type: 'addRules' }] },
  ]);
  await ask('answer', {
    chatId: 'cl1',
    approvalId: 'cperm-2',
    choice: 'once',
    version: cards.find((c: any) => c.id === 'cperm-2').version,
  });
  assert.deepEqual(calls.at(-1), ['claude', 'cperm-2', { behavior: 'allow', updatedInput: { file_path: '/w/a.txt', content: 'x' } }]);
  await ask('answer', {
    chatId: 'cl1',
    approvalId: 'cperm-3',
    choice: 'deny',
    version: cards.find((c: any) => c.id === 'cperm-3').version,
  });
  assert.deepEqual(calls.at(-1), ['claude', 'cperm-3', { behavior: 'deny', message: 'The user declined this action.' }]);
  // answered cards are gone from main
  assert.deepEqual(
    state.get('cl1').approvals.map((a: any) => a.id),
    ['cperm-4', 'cperm-5', 'cperm-6'],
  );
  assert.equal(
    (
      await ask('answer', {
        chatId: 'cl1',
        approvalId: 'cperm-5',
        choice: 'once',
        version: cards.find((c: any) => c.id === 'cperm-5').version,
      })
    ).error,
    'Choose an option offered by this request.',
  );
});

test('a Codex and a basic harness’s request, as main holds them, are answered in the panel too', async () => {
  const { controller, calls, ask } = setup();
  controller.onCodexMessage({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'cx1', command: 'make' } });
  controller.onAcpEvent({
    kind: 'permission',
    key: controller.ref('ac1').key,
    requestId: 'acpperm-1',
    toolCall: { title: 'Edit main.py' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  const codex = (await ask('read', { chatId: 'cx1' })).result.approvals;
  assert.deepEqual([codex[0].title, codex[0].detail], ['Run this command?', 'make']);
  await ask('answer', { chatId: 'cx1', approvalId: 3, choice: 'once', version: codex[0].version });
  assert.deepEqual(calls.at(-1), ['codex', 3, { decision: 'accept' }]);
  const acp = (await ask('read', { chatId: 'ac1' })).result.approvals;
  assert.equal(acp[0].title, 'Gemini wants to: Edit main.py');
  await ask('answer', { chatId: 'ac1', approvalId: 'acpperm-1', choice: 'o0', version: acp[0].version });
  assert.deepEqual(calls.at(-1), ['acp', 'acpperm-1', 'yes']);
});

test('question and form answers are validated in main, retain drafts on refusal and cannot reuse old card versions', async () => {
  const { controller, state, calls, ask } = setup();
  claudeAsks(controller, 'cperm-question', 'AskUserQuestion', {
    questions: [{ question: 'Choose a hotel', options: [{ label: 'A' }], multiSelect: false }],
  });
  const card = (await ask('read', { chatId: 'cl1' })).result.approvals[0];
  assert.equal(card.questions[0].id, '0');
  const malformed = await ask('answer', {
    chatId: 'cl1',
    approvalId: card.id,
    choice: 'submit',
    version: card.version,
    values: { 0: ['A', 'B'] },
  });
  assert.match(malformed.error, /Check the answer/);
  assert.equal(state.get('cl1').approvals.length, 1);
  await ask('answer', { chatId: 'cl1', approvalId: card.id, choice: 'submit', version: card.version, values: { 0: ['A'] } });
  assert.equal(calls.at(-1)[0], 'claude');
  assert.equal(calls.at(-1)[2].updatedInput.answers['Choose a hotel'], 'A');
  const replied = calls.length;
  const stale = await ask('answer', { chatId: 'cl1', approvalId: card.id, choice: 'submit', version: card.version, values: { 0: ['A'] } });
  assert.match(stale.error, /already answered/);
  assert.equal(calls.length, replied);
  controller.onCodexMessage({
    id: 99,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'cx1', message: 'Form', requestedSchema: { type: 'object', properties: { n: { type: 'integer' } } } },
  });
  const form = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
  const big = await ask('answer', {
    chatId: 'cx1',
    approvalId: 99,
    choice: 'submit',
    version: form.version,
    values: { text: 'x'.repeat(200_001) },
  });
  assert.match(big.error, /too large/);
  await ask('answer', { chatId: 'cx1', approvalId: 99, choice: 'submit', version: form.version, values: { n: 2 } });
  assert.deepEqual(
    calls.find((c: any) => c[0] === 'codex' && c[1] === 99),
    ['codex', 99, { action: 'accept', content: { n: 2 }, _meta: null }],
  );
});

test('native browser all-sites grants re-read managed policy and retire a pending answer if its request disappeared', async () => {
  const { controller, state, calls, ask, live } = setup();
  const p = {
    threadId: 'cx1',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      connector_id: 'browser-use',
      codex_approval_kind: 'mcp_tool_call',
      tool_name: 'access_browser_origin',
      origin: 'https://example.com',
      persist: ['always'],
    },
  };
  let policy: any = {};
  live.codex.request = async () => policy;
  controller.onCodexMessage({ id: 100, method: 'mcpServer/elicitation/request', params: p });
  const card = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
  assert.ok(card.choices.some((c: any) => c.key === 'allSites'));
  policy = { requirements: { browserUse: { allowGlobalPersistentApproval: false } } };
  assert.match((await ask('answer', { chatId: 'cx1', approvalId: 100, choice: 'allSites', version: card.version })).error, /offered/);
  let finish: any;
  live.codex.request = () =>
    new Promise((r) => {
      finish = r;
    });
  const answering = ask('answer', { chatId: 'cx1', approvalId: 100, choice: 'allSites', version: card.version });
  while (!finish) await new Promise((r) => setImmediate(r));
  state.patch('cx1', { approvals: [] });
  finish({});
  assert.match((await answering).error, /already answered/);
  assert.equal(
    calls.some((c: any) => c[0] === 'codex'),
    false,
  );
  live.codex.request = async () => {
    throw new Error('Requirements offline');
  };
  controller.onCodexMessage({ id: 101, method: 'mcpServer/elicitation/request', params: p });
  const unavailable = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
  assert.equal(
    unavailable.choices.some((c: any) => c.key === 'allSites'),
    false,
  );
});

test('native ACP forms use the ACP owner and schema, answer once without a window, and reject retired segments', async () => {
  const { controller, state, ask, live } = setup();
  const { AcpQuestions } = require('../electron/harness/acp/questions.cjs');
  const agent = {};
  const chat = { chatId: 'ac1', key: controller.ref('ac1').key, harness: 'gemini', agent };
  const replies: any[] = [];
  const host: any = {
    chats: new Map([[chat.key, chat]]),
    chatOf: () => chat,
    label: () => 'Gemini',
    emitEvent: (e: any) => controller.onAcpEvent(e),
  };
  const questions = new AcpQuestions(host);
  host.questions = questions;
  live.acpHost.questions = questions;
  controller.acp = host;
  const context = { defer: () => null, respond: (payload: any) => (replies.push(payload), { status: 'delivered' }) };
  const p = {
    mode: 'form',
    sessionId: 'ac1',
    message: 'Choose a hotel',
    requestedSchema: {
      type: 'object',
      required: ['hotel'],
      properties: { hotel: { type: 'string', enum: ['A', 'B'], default: 'A' }, nights: { type: 'integer', minimum: 1, maximum: 5 } },
    },
  };
  questions.open(agent, p, context);
  const first = (await ask('read', { chatId: 'ac1' })).result.approvals[0];
  assert.ok(first.id.startsWith('panel:acp-form:'));
  assert.equal(first.schema.properties.hotel.default, 'A');
  const invalid = await ask('answer', {
    chatId: 'ac1',
    approvalId: first.id,
    version: first.version,
    choice: 'submit',
    values: { hotel: 'Other' },
  });
  assert.ok(invalid.error);
  assert.equal(replies.length, 0);
  const accepted = await ask('answer', {
    chatId: 'ac1',
    approvalId: first.id,
    version: first.version,
    choice: 'submit',
    values: { hotel: 'B', nights: 2 },
  });
  assert.deepEqual(accepted.result, { answered: true });
  assert.deepEqual({ ...replies[0], content: { ...replies[0].content } }, { action: 'accept', content: { hotel: 'B', nights: 2 } });
  assert.equal((await ask('read', { chatId: 'ac1' })).result.approvals.length, 0);
  assert.ok(
    (await ask('answer', { chatId: 'ac1', approvalId: first.id, version: first.version, choice: 'submit', values: { hotel: 'B' } })).error,
  );
  questions.open(agent, p, context);
  const second = (await ask('read', { chatId: 'ac1' })).result.approvals[0];
  const source = controller.isCurrentSource.bind(controller);
  controller.isCurrentSource = () => false;
  assert.ok((await ask('answer', { chatId: 'ac1', approvalId: second.id, version: second.version, choice: 'decline' })).error);
  controller.isCurrentSource = source;
  assert.ok(state.get('ac1').questions.every((q: any) => q.status !== 'pending'));
});

test('asynchronous question replies route through the stable chat on every harness and display queued receipts accurately', async () => {
  for (const chatId of ['cl1', 'cx1', 'ac1']) {
    const { ask, live, controller } = setup();
    let turns: any[] = [
      {
        id: 'turn',
        items: [{ id: 'questions', type: 'agentMessage', text: 'Which hotel?', questions: [{ title: 'Hotel?', options: ['A', 'B'] }] }],
      },
    ];
    live.peerRuntime.readHistory = async () => ({ turns, earlierContentOmitted: false });
    const sent: any[] = [];
    controller.send = async (...args: any[]) => (sent.push(args), { action: chatId === 'ac1' ? 'queued' : 'steered', id: 'input-1' });
    const first = (await ask('read', { chatId })).result.approvals[0];
    assert.ok(first.id.startsWith('panel:async:'));
    const readAgain = (await ask('read', { chatId })).result.approvals[0];
    assert.equal(first.version, readAgain.version);
    const result = await ask('answer', { chatId, approvalId: first.id, version: first.version, choice: 'submit', values: { 0: ['B'] } });
    assert.deepEqual(result.result, { answered: true });
    assert.equal(sent[0][0], chatId);
    assert.equal(sent[0][1].text, 'Hotel?\nB');
    assert.equal(sent[0][1].followUp, 'steer');
    assert.equal(sent[0][1].opts.human, true);
    const pending = (await ask('read', { chatId })).result.approvals[0];
    assert.equal(pending.disabled, true);
    assert.match(pending.title, chatId === 'ac1' ? /queued/ : /sent/);
    assert.ok(
      (await ask('answer', { chatId, approvalId: first.id, version: first.version, choice: 'submit', values: { 0: ['B'] } })).error,
    );
    assert.equal(sent.length, 1);
    turns = [...turns, { id: 'reply', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Hotel?\nB' }] }] }];
    assert.equal((await ask('read', { chatId })).result.approvals.length, 0);
  }
});

test('an async question answer is claimed before history awaits; failed or stale delivery preserves the pending form', async () => {
  const { ask, live, controller } = setup();
  const turns = [{ id: 'turn', items: [{ id: 'q', type: 'agentMessage', questions: [{ title: 'Destination?' }] }] }];
  let finish: any,
    pendingRead = false;
  live.peerRuntime.readHistory = () =>
    pendingRead
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve({ turns });
  let sent = 0;
  controller.send = async () => (sent++, { action: 'failed', id: 'input', error: 'Offline' });
  const card = (await ask('read', { chatId: 'cl1' })).result.approvals[0];
  pendingRead = true;
  const first = ask('answer', { chatId: 'cl1', approvalId: card.id, version: card.version, choice: 'submit', values: { 0: ['Taipei'] } });
  const second = await ask('answer', {
    chatId: 'cl1',
    approvalId: card.id,
    version: card.version,
    choice: 'submit',
    values: { 0: ['Taipei'] },
  });
  assert.ok(second.error);
  assert.equal(sent, 0);
  finish({ turns });
  assert.match((await first).error, /Offline/);
  assert.equal(sent, 1);
  pendingRead = false;
  const retry = (await ask('read', { chatId: 'cl1' })).result.approvals[0];
  assert.equal(retry.version, card.version);
  controller.send = async () => ({ action: 'started', id: 'input' });
  assert.deepEqual((await ask('answer', { chatId: 'cl1', approvalId: card.id, version: card.version, choice: 'skip' })).result, {
    answered: true,
  });
});

test('an async question running in another client stays visible but disabled and refuses a stale control', async () => {
  const { ask, live, controller, state } = setup();
  live.peerRuntime.readHistory = async () => ({
    turns: [{ id: 't', items: [{ id: 'q', type: 'agentMessage', questions: [{ title: 'Where?' }] }] }],
  });
  const first = (await ask('read', { chatId: 'cl1' })).result.approvals[0];
  state.patch('cl1', { turn: 'idle', runningElsewhere: true });
  const blocked = (await ask('read', { chatId: 'cl1' })).result.approvals[0];
  assert.equal(blocked.version, first.version);
  assert.equal(blocked.disabled, true);
  assert.match(blocked.detail, /Another client/);
  controller.send = async () => {
    throw new Error('must not send');
  };
  assert.match(
    (await ask('answer', { chatId: 'cl1', approvalId: first.id, version: first.version, choice: 'skip' })).error,
    /Another client/,
  );
});

test('the first panel answer claims its version before a managed-policy wait, with retry after a refused scope', async () => {
  const { controller, ask, live, calls } = setup();
  live.codex.request = async () => ({});
  controller.onCodexMessage({
    id: 120,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'cx1',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        connector_id: 'browser-use',
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'access_browser_origin',
        origin: 'https://example.org',
        persist: ['always'],
      },
    },
  });
  const card = (await ask('read', { chatId: 'cx1' })).result.approvals[0];
  let finish: any;
  live.codex.request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = ask('answer', { chatId: 'cx1', approvalId: 120, version: card.version, choice: 'allSites' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await ask('answer', { chatId: 'cx1', approvalId: 120, version: card.version, choice: 'deny' });
  assert.match(second.error, /already answered/);
  assert.equal(calls.length, 0);
  finish({ requirements: { browserUse: { allowGlobalPersistentApproval: false } } });
  assert.match((await first).error, /offered/);
  live.codex.request = async () => ({});
  assert.equal((await ask('answer', { chatId: 'cx1', approvalId: 120, version: card.version, choice: 'deny' })).result.answered, true);
  assert.equal(calls.length, 1);
});
