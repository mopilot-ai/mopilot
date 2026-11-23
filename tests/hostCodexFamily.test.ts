// The Codex family's own decisions (host/src/codexFamily.mjs), with the controller and the app-server stood in: when the login is asked again, which chat a new thread belongs to, which requests become cards, and what each adapter callback does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexFamily, IDENTITY_BUSY, NOT_INSTALLED, NOT_SIGNED_IN, orgProviderArgs } from '../host/src/codexFamily.mjs';

/** The family over a stand-in controller, state and chat store; `sent` is what went to the app-server. */
function setup(
  o: {
    has?: boolean;
    cards?: boolean;
    recorded?: boolean;
    probe?: () => Promise<boolean>;
    which?: () => string | null;
    now?: () => number;
    leases?: any;
    turns?: Record<string, string>;
  } = {},
) {
  const emitted: any[] = [];
  const calls: any[] = [];
  const committed: any[] = [];
  let refuseCommit = false;
  const approvals: any[] = [];
  /** chat -> the config saved in its meta */
  const metas = new Map<string, any>();
  const records = new Map(o.recorded ? [['chat', { id: 'chat', meta: {} }]] : []);
  const controller: any = {
    chatOf: (id: string) => (id === 'th' ? 'chat' : id),
    // a sub-agent's thread asks in the chat of the thread that spawned it
    requestChat: (id: string) => (id === 'th' || id === 'th-sub' ? 'chat' : id),
    isCurrentSource: () => true,
    ref: () => ({ kind: 'codex', id: 'th', key: 'th' }),
    onCodexMessage: (msg: any) => {
      calls.push(['message', msg.method]);
      if (o.cards !== false && msg.id != null) approvals.push({ id: msg.id });
    },
    onCodexExit: () => ['paused-thread'],
    codexStopped: (...a: any[]) => calls.push(['stopped', ...a]),
    onCodexOutgoing: (m: any) => (calls.push(['outgoing', m.id]), controller.holds !== false),
    invalidate: () => calls.push(['invalidate']),
  };
  const ctx: any = {
    paths: { dataDir: '/data' },
    state: {
      has: (id: string) => o.has !== false && id === 'chat',
      get: (id: string) => ({ approvals, turn: o.turns?.[id] ?? 'idle' }),
      all: () => Object.keys(o.turns ?? {}),
    },
    chats: {
      records,
      record: (id: string) => records.get(id),
      metas,
      get: (id: string) => (metas.has(id) ? { meta: { config: metas.get(id) } } : null),
      patchMeta: (id: string, patch: any) => void metas.set(id, patch.config),
      commit: (r: any) => (refuseCommit ? false : !!committed.push(r)),
    },
    controller: () => controller,
    emit: (e: any) => emitted.push(e),
  };
  const factory = createCodexFamily({
    env: {},
    which: o.which ?? (() => '/bin/codex'),
    probe: (o.probe ?? (async () => true)) as any,
    now: o.now ?? (() => 1000),
    leases: o.leases,
  });
  const family = factory(ctx);
  const sent: any[] = [];
  const stopped: any[] = [];
  const server = family.codex.server;
  server.send = (m: any) => sent.push(m);
  server.stop = () => stopped.push(1);
  const refuse = () => (refuseCommit = true);
  return { factory, ctx, refuse, family, adapter: family.codex, controller, emitted, calls, committed, sent, stopped, server };
}

test('the login is asked once a minute, and only a good answer is kept', async () => {
  let now = 0;
  const asked: number[] = [];
  let good = false;
  const s = setup({ now: () => now, probe: async () => (asked.push(now), good) });
  await assert.rejects(s.family.check(), (e: any) => e.code === 'harness_not_configured' && e.message === NOT_SIGNED_IN);
  await assert.rejects(s.family.check(), /signed in/);
  good = true;
  await s.family.check();
  now = 59_999;
  await s.family.check();
  assert.deepEqual(asked, [0, 0, 0]);
  now = 60_001;
  await s.family.check();
  assert.equal(asked.length, 4);
});

test('a binary that is not there is refused with the install hint, at the check and when the app-server would start', async () => {
  const s = setup({ which: () => null });
  await assert.rejects(s.family.check(), (e: any) => e.code === 'harness_not_configured' && e.message === NOT_INSTALLED);
  assert.throws(
    () => s.server.findBin(),
    (e: any) => e.code === 'harness_not_configured',
  );
  assert.equal(setup().server.findBin(), '/bin/codex');
});

test('a new chat records the thread Codex started under the chat id, once, even when started twice together', async () => {
  const s = setup();
  const started: any[] = [];
  s.adapter.startThread = async (params: any) => (started.push(params), { thread: { id: 'th-new' } });
  await Promise.all([s.family.prepare({ chatId: 'chat', cwd: '/work' }), s.family.prepare({ chatId: 'chat', cwd: '/work' })]);
  assert.equal(started.length, 1);
  assert.equal(started[0].cwd, '/work');
  assert.equal(started[0].ephemeral, false);
  assert.equal(s.committed[0].id, 'chat');
  assert.equal(s.committed[0].segments[0].nativeId, 'th-new');
  assert.equal(s.committed[0].segments[0].kind, 'codex');
  assert.deepEqual(s.calls, [['invalidate']]);
  // with no folder the thread starts in the Host's data dir
  s.adapter.startThread = async (params: any) => (started.push(params), { thread: { id: 'th-2' } });
  await s.family.prepare({ chatId: `side-chat-${crypto.randomUUID()}` });
  assert.equal(started[1].cwd, '/data');
  assert.equal(started[1].ephemeral, false);
});

test('a chat that already has a record starts no thread, and a start that returns no thread fails and can be retried', async () => {
  const known = setup({ recorded: true });
  known.adapter.startThread = async () => assert.fail('no thread for a known chat');
  await known.family.prepare({ chatId: 'chat' });
  const s = setup();
  s.adapter.startThread = async () => ({});
  await assert.rejects(s.family.prepare({ chatId: 'chat' }), /didn't start a thread/);
  s.adapter.startThread = async () => ({ thread: { id: 'th-ok' } });
  await s.family.prepare({ chatId: 'chat' });
  assert.equal(s.committed.length, 1);
});

test('a chat the store refuses to record fails the start, and leaves nothing to answer for', async () => {
  const s = setup();
  const deleted: string[] = [];
  s.adapter.threadDelete = async (id: string) => void deleted.push(id);
  s.adapter.startThread = async () => ({ thread: { id: 'th-x' } });
  s.refuse();
  await assert.rejects(s.family.prepare({ chatId: 'chat' }), /Couldn't record/);
  assert.deepEqual(deleted, ['th-x']);
  assert.deepEqual(s.calls, []);
});

test('requests: an approval becomes a card, anything else is refused to the app-server', () => {
  const s = setup();
  const approval = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: 't', command: 'ls' } };
  s.adapter.observe(approval);
  assert.equal(s.emitted.find((e) => e.kind === 'permission').requestId, 'codex-0-7');
  assert.deepEqual(s.sent, []);
  // user input, a tool call, or a thread no chat shows: the turn must not wait on a person who cannot be asked
  s.adapter.observe({ id: 8, method: 'item/tool/requestUserInput', params: { threadId: 'th' } });
  s.adapter.observe({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'ghost', conversationId: undefined } });
  s.adapter.observe({ id: 10, method: 'applyPatchApproval', params: {} });
  // (a question with nothing to ask is answered as skipped, the others are refused)
  assert.deepEqual(
    (s.sent as any[]).map((m) => [m.id, m.error?.code ?? JSON.stringify(m.result)]),
    [
      [8, '{"answers":{}}'],
      [9, -32601],
      [10, -32601],
    ],
  );
});

test('#4000: a sub-agent’s approval is a card on the chat’s running turn, and its answer reaches the app-server', () => {
  const s = setup();
  s.adapter.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  s.adapter.observe({
    id: 21,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'th-sub', turnId: 'sub-turn', command: 'rm x' },
  });
  assert.deepEqual(s.sent, []);
  const card = s.emitted.find((e) => e.kind === 'permission');
  assert.deepEqual([card.key, card.turnId, card.toolCall.title], ['chat', 't1', 'rm x']);
  assert.equal(s.family.permit({ requestId: card.requestId, optionId: 'allow_once' }), true);
  assert.deepEqual(s.sent, [{ id: 21, result: { decision: 'accept' } }]);
  // the chat's turn ending closes a sub-agent's card too
  s.adapter.observe({ id: 22, method: 'item/fileChange/requestApproval', params: { threadId: 'th-sub', turnId: 'sub-turn' } });
  s.adapter.observe({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 't1', status: 'completed' } } });
  assert.equal(s.emitted.filter((e) => e.kind === 'permissionCancelled').length, 1);
});

test('#4025: a question Codex asks is a form card the person answers; one this Host cannot draw is answered as declined; a form answer reaches the app-server', () => {
  const s = setup();
  s.adapter.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  const questions = [{ id: 'q1', header: 'Language', question: 'Which?', options: [{ label: 'JS' }, { label: 'Rust' }] }];
  s.adapter.observe({ id: 31, method: 'item/tool/requestUserInput', params: { threadId: 'th', turnId: 't1', questions } });
  const card = s.emitted.find((e) => e.kind === 'question');
  assert.deepEqual([card.key, card.turnId], ['chat', 't1']);
  assert.equal(s.family.permit({ requestId: card.question.id, form: { action: 'accept', content: { q1: 'Rust' } } }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(s.sent)), [{ id: 31, result: { answers: { q1: { answers: ['Rust'] } } } }]);
  // an elicitation with no fields cannot be asked: declined, and the controller is told it went
  s.adapter.observe({
    id: 32,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'th', mode: 'form', requestedSchema: { type: 'object', properties: {} } },
  });
  assert.deepEqual(s.sent.at(-1), { id: 32, result: { action: 'decline', content: null, _meta: null } });
  assert.deepEqual(
    s.calls.filter((c) => c[0] === 'outgoing').map((c) => c[1]),
    [31, 32],
  );
  // a question the controller did not keep as a card is refused
  const none = setup({ cards: false });
  none.adapter.observe({ id: 33, method: 'item/tool/requestUserInput', params: { threadId: 'th', questions } });
  assert.equal(none.sent[0].error.code, -32601);
});

test('an approval the controller did not keep as a card is refused too; a chat the Host does not hold has none', () => {
  const noCard = setup({ cards: false });
  noCard.adapter.observe({ id: 1, method: 'execCommandApproval', params: { conversationId: 'th' } });
  assert.equal(noCard.sent[0].id, 1);
  assert.equal(noCard.emitted.length, 0);
  const noChat = setup({ has: false });
  noChat.adapter.observe({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'th' } });
  assert.equal(noChat.sent[0].id, 2);
  assert.deepEqual(noChat.calls, []);
});

test('a thread that is not the current segment of its chat has no stream; the adapter’s log line goes nowhere', () => {
  const s = setup();
  s.controller.isCurrentSource = () => false;
  s.adapter.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  assert.deepEqual(s.emitted, []);
  assert.equal(s.adapter.log('[native-stop] x'), undefined);
});

test('notifications go to the controller and the stream; the adapter’s own start of a turn is heard once', () => {
  const s = setup();
  s.adapter.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't1' } } });
  s.adapter.emit({ kind: 'turnStarted', chatId: 'chat', turnId: 't1' });
  s.adapter.emit({ kind: 'toast', text: 'ignored' });
  // the chat was titled: the stream's state lane hears it
  s.adapter.emit({ kind: 'threadName', chatId: 'chat', name: 'Fix login' });
  assert.deepEqual(s.emitted.at(-1), { kind: 'threadName', chatId: 'chat', name: 'Fix login' });
  assert.deepEqual(s.calls, [['message', 'turn/started']]);
  assert.equal(s.emitted.filter((e) => e.kind === 'turnStart').length, 1);
  // #3599: the adapter's start carries the message's text, and the turn's start tells it
  s.adapter.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 't2' } } });
  s.adapter.emit({ kind: 'turnStarted', chatId: 'chat', turnId: 't2', text: 'nightly check' });
  assert.deepEqual(s.emitted.at(-1).user.content, [{ type: 'text', text: 'nightly check' }]);
});

test('a card is answered once: the controller must still hold it, and the app-server gets the decision', () => {
  const s = setup();
  s.adapter.observe({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'th' } });
  assert.equal(s.family.permit({ requestId: 'codex-0-nope' }), false);
  assert.equal(s.family.permit({ requestId: 'codex-0-3', optionId: 'allow_once' }), true);
  assert.deepEqual(s.sent, [{ id: 3, result: { decision: 'accept' } }]);
  // the controller no longer holds a card (the app-server restarted under it): nothing is sent
  const gone = setup();
  gone.controller.holds = false;
  gone.adapter.observe({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: 'th' } });
  assert.equal(gone.family.permit({ requestId: 'codex-0-4' }), false);
  assert.deepEqual(gone.sent, []);
  // the card is closed for the clients that still show it
  assert.equal(gone.emitted.at(-1).kind, 'permissionCancelled');
});

test('the app-server quitting, a native stop, and closing the Host reach the controller and the process', () => {
  const s = setup();
  assert.deepEqual(s.adapter.onExit('Codex stopped', {}), ['paused-thread']);
  s.adapter.onStopped('chat', 't1');
  assert.deepEqual(s.calls, [['stopped', 'chat', 't1']]);
  s.family.close();
  assert.equal(s.stopped.length, 1);
});

test('a permission mode is kept in the chat’s config beside what it has, and only a mode Codex has', async () => {
  const s = setup();
  s.ctx.chats.patchMeta('chat', { config: { model: 'gpt-fake' } });
  await s.family.setPermission('chat', 'read-only');
  assert.deepEqual(s.ctx.chats.get('chat').meta.config, { model: 'gpt-fake', permission: 'read-only' });
  await s.family.setPermission('fresh', 'full-access');
  assert.deepEqual(s.ctx.chats.get('fresh').meta.config, { permission: 'full-access' });
  await assert.rejects(s.family.setPermission('chat', 'bogus'), /isn't one Codex has/);
  assert.equal(s.ctx.chats.get('chat').meta.config.permission, 'read-only');
  // the adapter reads it back as the chat's own
  assert.deepEqual(s.adapter.chatConfig('chat'), { model: 'gpt-fake', permission: 'read-only' });
  assert.equal(s.adapter.chatConfig('nobody'), null);
});

test('plan is kept as the mode Codex plans in, on the mode the chat was in; any other mode leaves it, and entering it twice keeps the first base', async () => {
  const s = setup();
  s.ctx.chats.patchMeta('chat', { config: { model: 'gpt-fake', permission: 'auto-review' } });
  await s.family.setPermission('chat', 'plan');
  assert.deepEqual(s.ctx.chats.get('chat').meta.config, { model: 'gpt-fake', permission: 'plan', planBasePermission: 'auto-review' });
  // asking for Plan again must not make Plan its own base
  await s.family.setPermission('chat', 'plan');
  assert.equal(s.ctx.chats.get('chat').meta.config.planBasePermission, 'auto-review');
  // leaving Plan sets the mode asked for; the base stays for the next time
  await s.family.setPermission('chat', 'read-only');
  assert.deepEqual(s.ctx.chats.get('chat').meta.config, { model: 'gpt-fake', permission: 'read-only', planBasePermission: 'auto-review' });
  // a chat with no mode yet plans on the default
  await s.family.setPermission('fresh', 'plan');
  assert.deepEqual(s.ctx.chats.get('fresh').meta.config, { permission: 'plan', planBasePermission: 'default' });
  // the adapter reads it back: its turns say the plan collaboration mode on that base (electron/harness/codexParams.cjs)
  assert.deepEqual(s.adapter.chatConfig('fresh'), { permission: 'plan', planBasePermission: 'default' });
});

test('the models come from the app-server’s list, kept a minute; none when Codex is missing, signed out or silent', async () => {
  let now = 0;
  const s = setup({ now: () => now });
  assert.deepEqual(await createCodexFamily({}).models(), []);
  const asked: object[] = [];
  s.adapter.request = async (method: string, params: object) => (
    asked.push({ method, params }),
    {
      data: [
        {
          model: 'gpt-fake',
          displayName: 'GPT Fake',
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, 'high'],
        },
        { model: 'gpt-bare' },
      ],
    }
  );
  const expected = [
    { id: 'gpt-fake', name: 'GPT Fake', resolvedModel: 'GPT Fake', default: true, defaultEffort: 'high', efforts: ['low', 'high'] },
    { id: 'gpt-bare', name: 'gpt-bare', default: false, efforts: [] },
  ];
  assert.deepEqual(await s.family.models(), expected);
  // the factory answers for the family it built
  assert.deepEqual(await s.factory.models(), expected);
  now = 30_000;
  assert.deepEqual(await s.family.models(), expected);
  assert.equal(asked.length, 1);
  now = 61_000;
  s.adapter.request = async () => ({});
  assert.deepEqual(await s.family.models(), []);
  // a list that cannot be read is not kept
  s.adapter.request = async () => {
    throw new Error('no answer');
  };
  now = 200_000;
  assert.deepEqual(await s.family.models(), []);
  assert.deepEqual(await setup({ which: () => null }).family.models(), []);
});

test('the factory says which family it built: none before the Host’s sessions built it (#4915)', () => {
  assert.equal(createCodexFamily({}).running(), null);
  const s = setup();
  assert.equal(s.factory.running(), s.family);
});

test('a sign-out of Codex stops its app-server and asks the login again; another harness or a family not yet built changes nothing', async () => {
  let good = true;
  const asked: number[] = [];
  const s = setup({ probe: async () => (asked.push(1), good) });
  await s.family.check();
  createCodexFamily({}).signedOut('codex');
  s.factory.signedOut('claude');
  assert.deepEqual(s.stopped, []);
  s.factory.signedOut('codex');
  assert.deepEqual(s.stopped, [1], 'the old login goes with its process');
  good = false;
  await assert.rejects(s.family.check(), (e: any) => e.message === NOT_SIGNED_IN);
  assert.equal(asked.length, 2, 'the kept good answer was dropped');
});

test('a lent key: the app-server starts with an ephemeral store and is told the key after initialize; one started without a key never is', async () => {
  const { createCredentialLeases } = await import('../host/src/credentialLease.mjs');
  const KEY = 'sk-proj-dummy-0000-test-key-abcd';
  const leases = createCredentialLeases();
  let probes = 0;
  const s = setup({ leases, probe: async () => (probes++, false) });
  const asked: any[] = [];
  s.server.start = () => undefined;
  s.adapter.call = async (method: string, params: any) => (asked.push([method, params]), {});
  assert.deepEqual(s.server.args(), [], 'no key: Codex keeps its own store');
  await s.adapter.initialize();
  assert.deepEqual(
    asked.map((a) => a[0]),
    ['initialize'],
    'no key is told to a process that has its own store',
  );
  leases.set('codex', KEY);
  assert.deepEqual(s.stopped, [1], 'nothing runs: the app-server goes at once, for one with the key');
  assert.deepEqual(s.server.args(), ['-c', 'cli_auth_credentials_store="ephemeral"']);
  // the next process: initialize, then the key over its own protocol
  s.adapter.init = null;
  asked.length = 0;
  const first = s.adapter.initialize();
  assert.equal(s.adapter.initialize(), first, 'one login per process');
  await first;
  assert.deepEqual(
    asked.map((a) => a[0]),
    ['initialize', 'account/login/start'],
  );
  assert.deepEqual(asked[1][1], { type: 'apiKey', apiKey: KEY });
  // a lent key needs no sign-in here
  await s.family.check();
  assert.equal(probes, 0);
  // a key taken back while a Codex turn runs: the app-server stays until it is idle
  const busy = { turns: { chat: 'running' } as Record<string, string> };
  const b = setup({ leases, turns: busy.turns, probe: async () => false });
  leases.set('codex', null);
  assert.deepEqual(b.stopped, []);
  busy.turns.chat = 'idle';
  await assert.rejects(b.family.check(), (e: any) => e.message === NOT_SIGNED_IN, 'no key: the Host’s own sign-in counts again');
  assert.deepEqual(b.stopped, [1], 'stopped once idle, at the next request');
  await assert.rejects(b.family.check());
  assert.deepEqual(b.stopped, [1], 'once');
  // another harness's key is not Codex's business
  leases.set('claude', KEY);
  assert.deepEqual(b.stopped, [1]);
});

test('an organization lease: the gateway is a model provider of its own, its token only in the process env; the user’s login and auth.json are never touched', async () => {
  const { createCredentialLeases } = await import('../host/src/credentialLease.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  // the user's own Codex login on this machine, which nothing here may read or write
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const authFile = path.join(home, 'auth.json');
  fs.writeFileSync(authFile, '{"OPENAI_API_KEY":null,"tokens":{"id_token":"user-own-chatgpt-login"}}');
  const before = fs.readFileSync(authFile, 'utf8');
  const TOKEN = 'eyJ.dummy-org-token-alice-0000.sig';
  const leases = createCredentialLeases();
  let probes = 0;
  const s = setup({ leases, probe: async () => (probes++, false) });
  const asked: any[] = [];
  s.adapter.call = async (method: string) => (asked.push(method), {});
  leases.set('codex', 'sk-proj-dummy-0000-test-key-abcd');
  leases.setOrg(
    {
      harness: 'codex',
      identity: 'a'.repeat(32),
      token: TOKEN,
      gateways: { openai: 'https://llm.example.test/openai/v1' },
      expiresAt: Date.now() + 3_600_000,
    },
    Date.now(),
  );
  const args = s.server.args();
  assert.deepEqual(args, orgProviderArgs('https://llm.example.test/openai/v1'));
  assert.deepEqual(args.slice(0, 2), ['-c', 'cli_auth_credentials_store="ephemeral"'], 'its credential store is in memory');
  assert.match(
    args[3],
    /^model_providers\.mopilot_org=\{ name = "Organization gateway", base_url = "https:\/\/llm\.example\.test\/openai\/v1", env_key = "MOPILOT_ORG_TOKEN", wire_api = "responses" \}$/,
  );
  assert.equal(args[5], 'model_provider="mopilot_org"');
  assert.doesNotMatch(args.join(' '), /dummy-org-token/, 'the token is never on the command line');
  assert.deepEqual(s.server.env(), { MOPILOT_ORG_TOKEN: TOKEN }, 'only in the env of the process started for it');
  await s.adapter.initialize();
  assert.deepEqual(asked, ['initialize'], 'no login: the user’s own and the lent key stay where they are');
  await s.family.check();
  assert.equal(probes, 0, 'a lease needs no sign-in here');
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
  fs.rmSync(home, { recursive: true, force: true });
  // a lease with no OpenAI gateway is not Codex's: the key is used as before
  leases.setOrg({ harness: 'codex', identity: 'a'.repeat(32), token: null }, Date.now());
  assert.deepEqual(s.server.args(), ['-c', 'cli_auth_credentials_store="ephemeral"']);
  assert.deepEqual(s.server.env(), {});
});

test('W: another identity’s message while a Codex turn runs is refused, never sent with the running lease; once idle the app-server restarts for it', async () => {
  const { createCredentialLeases } = await import('../host/src/credentialLease.mjs');
  const leases = createCredentialLeases();
  const turns: Record<string, string> = { chat: 'idle' };
  const s = setup({ leases, turns });
  const gw = { openai: 'https://llm.example.test/openai/v1' };
  const at = Date.now() + 3_600_000;
  leases.setOrg(
    { harness: 'codex', identity: 'a'.repeat(32), token: 'eyJ.dummy-org-token-alice-0000.sig', gateways: gw, expiresAt: at },
    Date.now(),
  );
  s.server.args();
  s.stopped.length = 0;
  turns.chat = 'running';
  // A's renewal mid-turn: the process keeps running until the turn ends
  leases.setOrg(
    { harness: 'codex', identity: 'a'.repeat(32), token: 'eyJ.dummy-org-token-alice-1111.sig', gateways: gw, expiresAt: at },
    Date.now(),
  );
  await s.family.check();
  assert.deepEqual(s.stopped, []);
  // B's message while A's turn runs
  leases.setOrg(
    { harness: 'codex', identity: 'b'.repeat(32), token: 'eyJ.dummy-org-token-bobby-0000.sig', gateways: gw, expiresAt: at },
    Date.now(),
  );
  await assert.rejects(s.family.check(), (e: any) => e.code === 'org_identity_busy' && e.message === IDENTITY_BUSY);
  assert.deepEqual(s.stopped, []);
  turns.chat = 'idle';
  await s.family.check();
  assert.deepEqual(s.stopped, [1], 'restarted between turns');
  s.server.args();
  assert.equal(s.server.env().MOPILOT_ORG_TOKEN, 'eyJ.dummy-org-token-bobby-0000.sig');
});
