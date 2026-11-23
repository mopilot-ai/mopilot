// The request ledger's ACP tap (electron/ledger/acpTap.cjs), how it names accounts (electron/ledger/accounts.cjs,
// Accounts.turnAccount), its wiring (electron/ledger/index.cjs), and the privacy check: fed through the real store by
// every harness's tap, no prompt, reply, tool argument, token or key ever reaches the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AcpLedgerTap, modelOf } = require('../electron/ledger/acpTap.cjs');
const { claudeLedgerAccount } = require('../electron/ledger/accounts.cjs');
const { createRequestLedger, openRequestLedger } = require('../electron/ledger/index.cjs');
const { AccountLimits } = require('../electron/identity/accounts/limits.cjs');

const ACCOUNT = { id: 'acct-1', email: 'work@example.com', verified: true };
const n = (method: string, params: any) => ({ method, params });
const usage = (o: any = {}) => ({
  inputTokens: 120,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 5,
  outputTokens: 30,
  reasoningOutputTokens: 7,
  ...o,
});

const assistant = (id: string, o: any = {}) => ({
  type: 'assistant',
  message: {
    id,
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: 'the reply' }],
    usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 },
    ...o,
  },
});

test('ACP: each prompt is one line with its outcome, usage and the session model, named by the harness', () => {
  const out: any[] = [];
  const tap = new AcpLedgerTap({ record: (r: any) => out.push(r), chatOf: (k: string) => `chat-of-${k}` });
  const key = 'acp:gemini:chat-1';
  tap.event({ key, kind: 'session', sessionId: 'sess-1', models: { currentModelId: 'gemini-3-pro' }, configOptions: null });
  tap.event({ key, kind: 'turnStart', turnId: 'at-1', user: { content: ['the prompt'] } });
  tap.event({
    key,
    kind: 'turnEnd',
    turnId: 'at-1',
    stopReason: 'end_turn',
    error: null,
    usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 6, cachedWriteTokens: 1, thoughtTokens: 2 },
  });
  tap.event({ key, kind: 'state', state: { configOptions: [{ id: 'model', category: 'model', currentValue: 'gemini-3-flash' }] } });
  tap.event({ key, kind: 'turnEnd', turnId: 'at-2', stopReason: 'cancelled', error: null });
  tap.event({ key, kind: 'state', state: { configOptions: [{ id: 'mode', category: 'mode', currentValue: 'plan' }] } });
  tap.event({ key, kind: 'turnEnd', turnId: 'at-3', stopReason: 'error', error: 'Authentication required' });
  assert.deepEqual(out, [
    {
      harness: 'gemini',
      chat: `chat-of-${key}`,
      session: 'sess-1',
      turn: 'at-1',
      account: { id: 'gemini' },
      pay: 'unknown',
      req: 'gemini-3-pro',
      outcome: 'ok',
      code: undefined,
      error: undefined,
      in: 10,
      out: 4,
      cacheRead: 6,
      cacheWrite: 1,
      reasoning: 2,
    },
    {
      harness: 'gemini',
      chat: `chat-of-${key}`,
      session: 'sess-1',
      turn: 'at-2',
      account: { id: 'gemini' },
      pay: 'unknown',
      req: 'gemini-3-flash',
      outcome: 'interrupted',
      code: 'cancelled',
      error: undefined,
      in: undefined,
      out: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
    },
    {
      harness: 'gemini',
      chat: `chat-of-${key}`,
      session: 'sess-1',
      turn: 'at-3',
      account: { id: 'gemini' },
      pay: 'unknown',
      req: 'gemini-3-flash',
      outcome: 'error',
      code: 'error',
      error: 'Authentication required',
      in: undefined,
      out: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
    },
  ]);
  // a closed session is forgotten; one never opened falls back to the key's id; other keys and kinds write nothing
  tap.event({ key, kind: 'closed' });
  assert.equal(tap.sessions.has(key), false);
  tap.event({ key: 'acp:opencode:c2', kind: 'turnEnd', turnId: 'x', stopReason: 'end_turn' });
  tap.event({ key: 'claude:s', kind: 'turnEnd' });
  tap.event(null);
  tap.event({ key: 'acp:opencode:c2', kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'reply' } } });
  assert.deepEqual(
    out.slice(3).map((r) => [r.harness, r.session, r.req]),
    [['opencode', 'c2', undefined]],
  );
});

test('ACP: modelOf reads the model config option first, then the session models', () => {
  assert.equal(modelOf({ configOptions: [{ category: 'model', currentValue: 'a' }], models: { currentModelId: 'b' } }), 'a');
  assert.equal(modelOf({ configOptions: [{ category: 'model', currentValue: 3 }], models: { currentModelId: 'b' } }), 'b');
  assert.equal(modelOf({ models: { currentModelId: 1 } }), undefined);
  assert.equal(modelOf(null), undefined);
});

test('Claude accounts: a login is named as MoPilot resolved it (#1294), a key by how it bills, never by the key', () => {
  const view = () => ({
    accounts: [
      { id: 'default', email: 'cli@example.com', isDefault: true, identity: 'verified' },
      { id: 'b1', email: 'added@example.com', isDefault: false, identity: null },
      { id: 'b2', email: null, isDefault: false, identity: null },
    ],
  });
  const o = { view, authMode: () => 'apiKey', cloud: () => null };
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'default' }, o), {
    id: 'default',
    email: 'cli@example.com',
    verified: true,
    pay: 'plan',
  });
  assert.deepEqual(claudeLedgerAccount({ login: true }, o), { id: 'default', email: 'cli@example.com', verified: true, pay: 'plan' });
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'b1' }, o), {
    id: 'b1',
    email: 'added@example.com',
    verified: true,
    pay: 'plan',
  });
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'b2' }, o), { id: 'b2', email: null, verified: false, pay: 'plan' });
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'gone' }, o), { id: 'gone', pay: 'plan' });
  // a login folded into another one of the same server account is named by that account's row, under its own id
  const folded = () => ({ ...view(), same: { b9: 'b1' } });
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'b9' }, { ...o, view: folded }), {
    id: 'b9',
    email: 'added@example.com',
    verified: true,
    pay: 'plan',
  });
  for (const [identity, verified] of [
    ['unverified', false],
    [null, null],
  ] as const) {
    const v = () => ({ accounts: [{ id: 'default', email: 'cli@example.com', isDefault: true, identity }] });
    assert.deepEqual(claudeLedgerAccount({ login: true, account: 'default' }, { ...o, view: v }), {
      id: 'default',
      email: 'cli@example.com',
      verified,
      pay: 'plan',
    });
  }
  assert.deepEqual(claudeLedgerAccount({ login: true, account: 'b1' }, { ...o, view: () => null }), { id: 'b1', pay: 'plan' });
  assert.deepEqual(claudeLedgerAccount({ login: false, account: 'default' }, o), { id: 'apiKey', pay: 'key' });
  assert.deepEqual(claudeLedgerAccount({ login: false }, { ...o, cloud: () => ({ provider: 'bedrock' }) }), { id: 'cloud', pay: 'cloud' });
  assert.deepEqual(claudeLedgerAccount({ login: false }, { ...o, authMode: () => 'mopilot' }), { id: 'mopilot', pay: 'gateway' });
  assert.deepEqual(claudeLedgerAccount({ login: false }, { ...o, authMode: () => 'subscription' }), { id: 'subscription', pay: 'unknown' });
});

test("Codex accounts: turnAccount names the turn's own login, or behind the relay the thread's pin, without forgetting it", () => {
  const logins: Record<string, any> = {
    default: { id: 'default', email: 'me@example.com' },
    k: { id: 'k', kind: 'apiKey' },
    m: { id: 'm', kind: 'apiKey', mopilot: true },
  };
  const acc: any = Object.assign(Object.create(AccountLimits.prototype), {
    relay: null,
    turnLogins: new Map([['tu', 'default']]),
    pins: new Map([['th', { id: 'k' }]]),
    get: (id: string) => logins[id] ?? null,
  });
  assert.deepEqual(acc.turnAccount('th', 'tu'), { id: 'default', email: 'me@example.com', verified: true, pay: 'plan' });
  assert.equal(acc.turnLogins.get('tu'), 'default', 'still known for turn/completed');
  assert.equal(acc.turnAccount('th', 'other'), null);
  acc.relay = {};
  assert.deepEqual(acc.turnAccount('th', 'tu'), { id: 'k', email: null, verified: true, pay: 'key' });
  acc.pins.set('th', { id: 'm' });
  assert.equal(acc.turnAccount('th', 'tu').pay, 'gateway', 'MoPilot credits');
  assert.equal(acc.turnAccount('nopin', 'tu'), null);
  acc.pins.set('stale', { id: 'removed' });
  assert.equal(acc.turnAccount('stale', 'tu'), null);
});

test("main's ledger: its folder in userData, the switch in the saved prefs, each harness's account, Claude events observed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-open-'));
  const observed: any[] = [];
  const claude = { observe: (fn: any) => observed.push(fn), ledgerAccount: (evt: any) => ({ id: evt.account }) };
  const live: any = {};
  const ledger = openRequestLedger({
    app: { getPath: () => dir },
    readState: () => ({ prefs: { requestLog: false } }),
    claude,
    live,
    chatOf: (id: string) => `c:${id}`,
  });
  assert.equal(ledger.store.dir, path.join(dir, 'ledger'));
  assert.equal(ledger.store.enabled(), false);
  assert.equal(observed.length, 1);
  // before the pool exists a Codex turn has no account; once it does, the pool names it
  assert.equal(ledger.codex.accountOf('th', 'tu'), null);
  live.accounts = { turnAccount: () => undefined };
  assert.equal(ledger.codex.accountOf('th', 'tu'), null);
  live.accounts = { turnAccount: (th: string, tu: string) => ({ id: `${th}/${tu}` }) };
  assert.deepEqual(ledger.codex.accountOf('th', 'tu'), { id: 'th/tu' });
  assert.equal(ledger.claude.accountOf, claude.ledgerAccount);
  observed[0]({ key: 'claude:s', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: true, result: 'boom' } });
  assert.equal(ledger.store.queue.length, 0, 'the switch is off: the observed result is not queued');
});

test('the ledger reads the Privacy switch at most every two seconds, and main can find it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-index-'));
  let now = 1_000_000;
  let prefs: any = {};
  let reads = 0;
  const ledger = createRequestLedger({
    userData: () => dir,
    prefs: () => (reads++, prefs),
    chatOf: (id: string) => id,
    codexAccount: () => null,
    claudeAccount: () => null,
    now: () => now,
  });
  assert.equal(ledger.store.dir, path.join(dir, 'ledger'));
  assert.equal(ledger.store.enabled(), true);
  prefs = { requestLog: false };
  now += 1000;
  assert.equal(ledger.store.enabled(), true, 'the last read stands for two seconds');
  now += 1500;
  assert.equal(ledger.store.enabled(), false);
  assert.equal(reads, 2);
  prefs = undefined;
  now += 2500;
  assert.equal(ledger.store.enabled(), true, 'no saved prefs: on');
  // the taps feed the one store
  ledger.acp.event({ key: 'acp:gemini:c', kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  assert.equal(ledger.store.queue.length, 1);
  const real = createRequestLedger({
    userData: () => dir,
    prefs: () => ({}),
    chatOf: (id: string) => id,
    codexAccount: () => null,
    claudeAccount: () => null,
  });
  assert.equal(typeof real.store.now(), 'number');
});

test('no prompt, reply, tool argument, token or key from any harness ever reaches the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-privacy-'));
  const SECRETS = {
    prompt: 'PROMPT-please-refactor-my-payroll',
    reply: 'REPLY-here-is-the-refactor',
    toolArg: 'TOOLARG-cat-/etc/shadow',
    toolOut: 'TOOLOUT-root:x:0:0',
    anthropicKey: `sk-ant-${'Z'.repeat(40)}`,
    openaiKey: `sk-proj-${'Y'.repeat(40)}`,
    bearer: 'Bearer eyJabcdefghijklmnopqrstuvwxyz',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  };
  const ledger = createRequestLedger({
    userData: () => dir,
    prefs: () => ({}),
    chatOf: (id: string) => `chat:${id}`,
    codexAccount: () => ACCOUNT,
    claudeAccount: () => ACCOUNT,
  });
  // Codex: the prompt rides on turnStarted, the reply and tool calls on item notifications, a key in an error
  ledger.codex.message(
    n('turn/started', { threadId: 'th', turn: { id: 'tu', items: [{ type: 'userMessage', content: [{ text: SECRETS.prompt }] }] } }),
  );
  ledger.codex.emitted({ kind: 'turnStarted', chatId: 'c', turnId: 'tu', text: SECRETS.prompt, model: 'gpt-5', effort: 'low' });
  ledger.codex.message(n('item/completed', { threadId: 'th', turnId: 'tu', item: { type: 'agentMessage', text: SECRETS.reply } }));
  ledger.codex.message(n('item/started', { threadId: 'th', turnId: 'tu', item: { type: 'commandExecution', command: SECRETS.toolArg } }));
  ledger.codex.message(
    n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: usage(), note: SECRETS.reply } }),
  );
  ledger.codex.message(
    n('error', {
      threadId: 'th',
      turnId: 'tu',
      willRetry: false,
      error: { message: `401 invalid key ${SECRETS.openaiKey}`, additionalDetails: `${SECRETS.bearer} ${SECRETS.jwt}` },
    }),
  );
  ledger.codex.message(n('turn/completed', { threadId: 'th', turn: { id: 'tu', status: 'failed', items: [{ text: SECRETS.reply }] } }));
  // Claude: the reply and tool use on assistant messages, the tool result on a user message, a key in an API error
  const msg = (m: any) => ledger.claude.event({ key: 'claude:s', kind: 'message', msg: m, login: true, account: 'default' });
  msg({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5', cwd: SECRETS.prompt });
  msg({ type: 'user', message: { content: [{ type: 'text', text: SECRETS.prompt }] } });
  msg(
    assistant('m1', {
      content: [
        { type: 'text', text: SECRETS.reply },
        { type: 'tool_use', input: { command: SECRETS.toolArg } },
      ],
    }),
  );
  msg({ type: 'user', message: { content: [{ type: 'tool_result', content: SECRETS.toolOut }] } });
  msg({
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ type: 'text', text: `Invalid API key ${SECRETS.anthropicKey}` }] },
  });
  msg({ type: 'result', subtype: 'success', is_error: false, result: SECRETS.reply });
  // ACP: the prompt on turnStart, the reply on updates, a key in a failed prompt
  ledger.acp.event({ key: 'acp:gemini:c', kind: 'turnStart', turnId: 't', user: { content: [SECRETS.prompt] } });
  ledger.acp.event({ key: 'acp:gemini:c', kind: 'update', update: { content: { text: SECRETS.reply } } });
  ledger.acp.event({ key: 'acp:gemini:c', kind: 'turnEnd', turnId: 't', stopReason: 'error', error: `bad key ${SECRETS.anthropicKey}` });
  await ledger.store.flush();
  const files = fs.readdirSync(path.join(dir, 'ledger'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, 'ledger', files[0]), 'utf8');
  const lines = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.harness, l.outcome]),
    [
      ['codex', 'ok'],
      ['codex', 'error'],
      ['claude', 'ok'],
      ['claude', 'error'],
      ['gemini', 'error'],
    ],
  );
  for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!text.includes(secret), `${name} was written`);
  // the parts of a key that survive are only the redaction markers
  assert.match(text, /\[REDACTED:openai-key\]/);
  assert.match(text, /\[REDACTED:anthropic-key\]/);
  assert.match(text, /Bearer \[REDACTED:token\]/);
});
