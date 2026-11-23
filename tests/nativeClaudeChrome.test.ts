// Claude in Chrome for Claude Code sessions (PR #346, electron/harness/claude/index.cjs): which sessions run the
// vendor-native Chrome (--chrome) and which keep --no-chrome, the MoPilot tools such a session must
// not see, and approvals and MCP elicitations that the SDK cancels or answers with metadata. Run
// against a fake Agent SDK and a fake Electron; the session code is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-chrome-'));
fs.writeFileSync(
  path.join(tmp, 'electron.cjs'),
  `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).slice(4) } };`,
);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__fakeChromeQuery(args);',
    'export const tool = (name, description, schema, handler, extra) => ({ name, description, handler, extra });',
    "export const createSdkMcpServer = (o) => ({ type: 'sdk', ...o });",
  ].join('\n'),
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** A CLI process that answers each prompt with a result and ends when closed. */
const queries: any[] = [];
(globalThis as any).__fakeChromeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    closed: false,
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async setPermissionMode() {},
    async getSettings() {
      return { applied: {} };
    },
    async applyFlagSettings() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      out.push({ type: 'result', subtype: 'success', echo: m.message.content });
      wake();
    }
  })();
  queries.push(q);
  return q;
};

const require = createRequire(import.meta.url);
const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

const handlers = new Map<string, (...a: any[]) => any>();
const events: any[] = [];
const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}
let serial = 0;
/** Starts a chat's CLI and returns its query once it answered the first message. */
async function startChat(extra: any = {}) {
  const sid = `chrome-${++serial}`;
  const key = `claude:${sid}`;
  const before = queries.length;
  await claude.send(
    key,
    { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', ...extra },
    { role: 'user', content: 'hi' },
  );
  await until('the CLI', () => queries.length > before);
  return { key, q: queries[before] };
}

function registry(names: string[]) {
  return {
    list: () => names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, policy: 'act' })),
    invoke: async () => ({ ok: true, content: [] }),
  };
}
const toolNames = (q: any) => Object.values(q.options.mcpServers ?? {}).flatMap((s: any) => s.tools.map((t: any) => t.name));

test('before the account list is read, a subscription session on the switch runs Claude in Chrome', () => {
  claude.setTools(null);
  assert.equal(claude.nativeChromeFor('default'), false, 'no tools set: no switch');
  claude.setTools({ nativeChrome: () => 'yes' });
  assert.equal(claude.nativeChromeFor('default'), false, 'only a switch that says true counts');
  claude.setTools({ nativeChrome: () => true });
  assert.equal(claude.nativeChromeFor('default'), true);
});

test('only a claude.ai login on the remote switch gets Claude in Chrome', async () => {
  claude.register(
    { handle: (name: string, fn: any) => handlers.set(name, fn) },
    (channel: string, evt: any) => channel === 'claude:event' && events.push(evt),
  );
  const accounts = claude.identity.accounts();
  const view = accounts.view.bind(accounts);
  claude.setTools({ nativeChrome: () => true });
  try {
    assert.equal(claude.nativeChromeFor('default'), true);
    // a login the CLI reports as a Console API key bills per use
    accounts.view = () => ({ ...view(), accounts: [{ id: 'default', authMethod: 'api_key' }] });
    assert.equal(claude.nativeChromeFor('default'), false);
    // an account the list does not know, or a list that cannot be read, is taken as the subscription login
    assert.equal(claude.nativeChromeFor('other'), true);
    accounts.view = () => {
      throw new Error('accounts file is corrupt');
    };
    assert.equal(claude.nativeChromeFor('default'), true);
    accounts.view = () => null;
    assert.equal(claude.nativeChromeFor('default'), true);
  } finally {
    accounts.view = view;
  }
  // a stored API key in use, or MoPilot credits: no Claude in Chrome
  await call('claude:setApiKey', 'sk-test-chrome');
  await call('claude:setAuthMode', 'apiKey');
  assert.equal(claude.nativeChromeFor('default'), false);
  await call('claude:setAuthMode', 'subscription');
  await call('claude:clearApiKey');
  assert.equal(claude.nativeChromeFor('default'), true);
  // the remote switch off
  claude.setTools({ nativeChrome: () => false });
  assert.equal(claude.nativeChromeFor('default'), false);
});

test("a Claude in Chrome session starts with --chrome and without Your Chrome's browser tools", async () => {
  const sessions = new ToolSessions();
  const asked: string[] = [];
  claude.setTools({
    registry: registry(['sage_browser_click', 'sage_files']),
    sessions,
    nativeChrome: () => true,
    hideTool: (name: string) => (asked.push(name), name.startsWith('sage_browser_')),
  });
  const { key, q } = await startChat();
  try {
    assert.deepEqual(q.options.extraArgs, { chrome: null });
    assert.deepEqual(toolNames(q), ['sage_files']);
    assert.ok(asked.includes('sage_browser_click'));
    // the tools it has pass canUseTool without a card
    const [server] = Object.keys(q.options.mcpServers);
    assert.deepEqual(await q.options.canUseTool(`mcp__${server}__sage_files`, { a: 1 }, {}), { behavior: 'allow', updatedInput: { a: 1 } });
  } finally {
    await call('claude:control', key, 'close');
  }
});

test('sessions without Claude in Chrome keep --no-chrome and every MoPilot tool', async () => {
  const sessions = new ToolSessions();
  const hideTool = (name: string) => name.startsWith('sage_browser_');
  for (const tools of [
    { nativeChrome: () => false, hideTool },
    // a hide hook that is not a function, or that does not say true, hides nothing
    { nativeChrome: () => true, hideTool: 'sage_browser_' },
    { nativeChrome: () => true, hideTool: () => 1 },
  ]) {
    claude.setTools({ registry: registry(['sage_browser_click', 'sage_files']), sessions, ...tools });
    const { key, q } = await startChat();
    try {
      assert.deepEqual(q.options.extraArgs, tools.nativeChrome() ? { chrome: null } : { 'no-chrome': null });
      assert.deepEqual(toolNames(q), ['sage_browser_click', 'sage_files']);
    } finally {
      await call('claude:control', key, 'close');
    }
  }
});

test('a session left with no tool to show gets no MoPilot server and its tool session ends', async () => {
  const sessions = new ToolSessions();
  const opened: string[] = [];
  const open = sessions.open.bind(sessions);
  sessions.open = (k: string, o: any) => (opened.push(k), open(k, o));
  claude.setTools({ registry: registry(['sage_browser_click']), sessions, nativeChrome: () => true, hideTool: () => true });
  const { key, q } = await startChat();
  try {
    assert.equal(q.options.mcpServers, undefined);
    assert.equal(opened.length, 1);
    assert.equal(sessions.get(opened[0]), null);
    // without a MoPilot tool set every tool asks as usual
    const card = q.options.canUseTool('mcp__x__y', {}, {});
    await until('the card', () => events.some((e) => e.key === key && e.kind === 'permission'));
    await call('claude:permission', events.find((e) => e.key === key && e.kind === 'permission').requestId, {
      behavior: 'allow',
      updatedInput: {},
    });
    assert.deepEqual(await card, { behavior: 'allow', updatedInput: {} });
  } finally {
    await call('claude:control', key, 'close');
  }
});

/* ---------- approvals the SDK cancels ---------- */

/** An abort signal whose listeners stay registered, to see what a late abort does. */
function stickySignal() {
  const listeners: (() => void)[] = [];
  return {
    aborted: false,
    addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
    fire() {
      this.aborted = true;
      for (const fn of listeners) fn();
    },
  };
}

test('a permission the SDK already gave up on gets no card; one it cancels later is withdrawn', async () => {
  claude.setTools(null);
  const { key, q } = await startChat();
  try {
    const before = events.length;
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await q.options.canUseTool('Bash', { command: 'ls' }, { signal: aborted.signal }), {
      behavior: 'deny',
      message: 'Cancelled',
    });
    assert.equal(
      events.slice(before).some((e) => e.kind === 'permission'),
      false,
    );
    // cancelled while the card is up
    const ctl = new AbortController();
    const answer = q.options.canUseTool(
      'Bash',
      { command: 'rm -rf build' },
      { signal: ctl.signal, toolUseID: 'toolu_1', agentID: 'agent-7', displayName: 'Run a shell command' },
    );
    await until('the card', () => events.slice(before).some((e) => e.kind === 'permission'));
    const card = events.slice(before).find((e) => e.kind === 'permission');
    assert.equal(card.agentID, 'agent-7');
    assert.equal(card.displayName, 'Run a shell command');
    assert.equal(card.toolUseID, 'toolu_1');
    ctl.abort();
    assert.deepEqual(await answer, { behavior: 'deny', message: 'Cancelled' });
    assert.ok(events.some((e) => e.kind === 'permissionCancelled' && e.requestId === card.requestId));
    assert.equal(
      await call('claude:permission', card.requestId, { behavior: 'allow' }),
      false,
      'the cancelled card can no longer be answered',
    );
  } finally {
    await call('claude:control', key, 'close');
  }
});

test('an answered permission keeps its answer when a late abort arrives; a card without options has nulls', async () => {
  claude.setTools(null);
  const { key, q } = await startChat();
  try {
    const before = events.length;
    const signal = stickySignal();
    const answer = q.options.canUseTool('Bash', { command: 'ls' }, { signal });
    await until('the card', () => events.slice(before).some((e) => e.kind === 'permission'));
    const card = events.slice(before).find((e) => e.kind === 'permission');
    await call('claude:permission', card.requestId, { behavior: 'allow', updatedInput: { command: 'ls' } });
    signal.fire();
    assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'ls' } });
    assert.equal(
      events.some((e) => e.kind === 'permissionCancelled' && e.requestId === card.requestId),
      false,
    );
    // no options at all
    const bare = q.options.canUseTool('Read', { file_path: '/a' });
    await until('the second card', () => events.slice(before).filter((e) => e.kind === 'permission').length === 2);
    const second = events.slice(before).filter((e) => e.kind === 'permission')[1];
    assert.equal(second.agentID, null);
    assert.equal(second.displayName, null);
    await call('claude:permission', second.requestId, { behavior: 'deny', message: 'no' });
    assert.deepEqual(await bare, { behavior: 'deny', message: 'no' });
  } finally {
    await call('claude:control', key, 'close');
  }
});

/* ---------- MCP elicitations ---------- */

test('an elicitation answer keeps the content and metadata given, and nothing else', () => {
  assert.deepEqual(claude.elicitationResult(null), { action: 'decline' });
  assert.deepEqual(claude.elicitationResult({}), { action: 'decline' });
  assert.deepEqual(claude.elicitationResult({ action: 'accept', content: { name: 'x' }, _meta: { persist: 'session' } }), {
    action: 'accept',
    content: { name: 'x' },
    _meta: { persist: 'session' },
  });
  assert.deepEqual(claude.elicitationResult({ action: 'accept', content: null, _meta: null }), { action: 'accept' });
  assert.deepEqual(claude.elicitationResult({ action: 'decline' }), { action: 'decline' });
  // only the answer's own fields pass
  const inherited = Object.create({ content: { leaked: true }, _meta: { leaked: true } });
  inherited.action = 'cancel';
  assert.deepEqual(claude.elicitationResult(inherited), { action: 'cancel' });
});

test("an elicitation card carries the server's id and display; the answer goes back with its _meta", async () => {
  claude.setTools(null);
  const { key, q } = await startChat();
  try {
    const before = events.length;
    const answer = q.options.onElicitation(
      {
        serverName: 'claude-in-chrome',
        message: 'Allow example.com?',
        elicitationId: 'el-1',
        displayName: 'Claude in Chrome',
        description: 'Navigate to example.com',
        requestedSchema: { type: 'object', properties: {} },
      },
      {},
    );
    await until('the card', () => events.slice(before).some((e) => e.kind === 'elicitation'));
    const card = events.slice(before).find((e) => e.kind === 'elicitation');
    assert.deepEqual(
      { elicitationId: card.elicitationId, displayName: card.displayName, description: card.description, mode: card.mode, url: card.url },
      { elicitationId: 'el-1', displayName: 'Claude in Chrome', description: 'Navigate to example.com', mode: 'form', url: null },
    );
    await call('claude:permission', card.requestId, { action: 'accept', content: {}, _meta: { persist: 'always' } });
    assert.deepEqual(await answer, { action: 'accept', content: {}, _meta: { persist: 'always' } });
    // a card without the optional fields
    const plain = q.options.onElicitation({ serverName: 'docs', message: 'Name?' });
    await until('the second card', () => events.slice(before).filter((e) => e.kind === 'elicitation').length === 2);
    const second = events.slice(before).filter((e) => e.kind === 'elicitation')[1];
    assert.deepEqual([second.elicitationId, second.displayName, second.description], [null, null, null]);
    await call('claude:permission', second.requestId, null);
    assert.deepEqual(await plain, { action: 'decline' });
  } finally {
    await call('claude:control', key, 'close');
  }
});

test('an elicitation the SDK cancels gets no card, or has its card withdrawn; a late abort is ignored', async () => {
  claude.setTools(null);
  const { key, q } = await startChat();
  try {
    const before = events.length;
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await q.options.onElicitation({ serverName: 'docs', message: 'm' }, { signal: aborted.signal }), { action: 'cancel' });
    assert.equal(
      events.slice(before).some((e) => e.kind === 'elicitation'),
      false,
    );
    const ctl = new AbortController();
    const cancelled = q.options.onElicitation({ serverName: 'docs', message: 'm' }, { signal: ctl.signal });
    await until('the card', () => events.slice(before).some((e) => e.kind === 'elicitation'));
    const card = events.slice(before).find((e) => e.kind === 'elicitation');
    ctl.abort();
    assert.deepEqual(await cancelled, { action: 'cancel' });
    assert.ok(events.some((e) => e.kind === 'permissionCancelled' && e.requestId === card.requestId));
    // answered first, aborted after
    const signal = stickySignal();
    const answered = q.options.onElicitation({ serverName: 'docs', message: 'm' }, { signal });
    await until('the second card', () => events.slice(before).filter((e) => e.kind === 'elicitation').length === 2);
    const second = events.slice(before).filter((e) => e.kind === 'elicitation')[1];
    await call('claude:permission', second.requestId, { action: 'accept', content: { name: 'x' } });
    signal.fire();
    assert.deepEqual(await answered, { action: 'accept', content: { name: 'x' } });
    assert.equal(
      events.some((e) => e.kind === 'permissionCancelled' && e.requestId === second.requestId),
      false,
    );
  } finally {
    await call('claude:control', key, 'close');
  }
});
