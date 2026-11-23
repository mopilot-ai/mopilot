// The request ledger as main wires it (electron/app/sessions.cjs, electron/app/ipc/ledger.cjs, electron/app/ipc/app.cjs): each
// harness's events reach it with no window involved, a quit writes what is queued, its IPC reads lines and reveals the
// folder, and Copy diagnostics carries the last day.
import { test, mock, assert, fs, path, calls, ready } from './support/main-sessions/fixture.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, filterOf } = require('../electron/app/ipc/ledger.cjs');

test('main feeds the ledger from the Codex, Claude Code and ACP adapters and serves it over IPC', async () => {
  const h = await ready();
  const ctl = h.one('ChatController');
  ctl.chatOf.mock.mockImplementation((id: string) => `chat:${id}`);
  const accounts = h.one('Accounts');
  accounts.turnAccount = mock.fn(() => ({ id: 'default', email: 'me@example.com', verified: true }));
  // Codex: the adapter's own turnStarted still reaches the windows, and the raw messages still reach the controller
  const o = h.one('CodexAdapter').opts;
  o.observe({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'tu' } } });
  o.emit({ kind: 'turnStarted', chatId: 'c1', turnId: 'tu', model: 'gpt-5', effort: 'low' }, undefined);
  o.observe({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'th', turnId: 'tu', tokenUsage: { last: { inputTokens: 9, outputTokens: 2 } } },
  });
  assert.deepEqual(calls(accounts.turnAccount), [['th', 'tu']]);
  assert.equal(calls(ctl.onCodexMessage).length, 2);
  // Claude Code: the observer main gave electron/harness/claude/index.cjs
  h.claude.ledgerAccount.mock.mockImplementation(() => ({ id: 'b1', email: 'added@example.com' }));
  const [observer] = calls(h.claude.observe)[0];
  observer({
    key: 'claude:s',
    kind: 'message',
    login: true,
    account: 'b1',
    msg: { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529' },
  });
  // ACP: a listener of its own beside the controller's (the third restarts a harness for its own MCP servers, #1575)
  const host = h.one('AcpHost');
  const listeners = calls(host.on).filter(([ev]: any[]) => ev === 'event');
  assert.equal(listeners.length, 3);
  listeners[1][1]({ key: 'acp:gemini:c3', kind: 'turnEnd', turnId: 'at-1', stopReason: 'cancelled', error: null });
  const lines = await h.invoke('ledger:recent', { limit: 10 });
  assert.deepEqual(
    lines.map((l: any) => [l.harness, l.chat, l.account?.email, l.outcome, l.req]),
    [
      ['gemini', 'chat:acp:gemini:c3', undefined, 'interrupted', undefined],
      ['claude', 'chat:claude:s', 'added@example.com', 'error', undefined],
      ['codex', 'c1', 'me@example.com', 'ok', 'gpt-5'],
    ],
  );
  assert.deepEqual(await h.invoke('ledger:recent', { harness: 'codex', limit: 'x', chat: { no: 1 } }), [lines[2]]);
  // Copy diagnostics carries the last day's lines
  const diag = (await h.invoke('app:diagnostics')).diagnostics;
  assert.equal(diag.ledger.length, 3);
  // the folder opens; a failure to open says why
  assert.deepEqual(await h.invoke('ledger:reveal'), { ok: true });
  assert.deepEqual(calls(h.electron.shell.openPath).at(-1), [path.join(h.userData, 'ledger')]);
  h.electron.shell.openPath.mock.mockImplementation(async () => 'no such app');
  assert.deepEqual(await h.invoke('ledger:reveal'), { ok: false, error: 'no such app' });
});

test("a quit writes the ledger's queued lines before the app goes", async () => {
  const h = await ready();
  h.one('ChatController').chatOf.mock.mockImplementation((id: string) => id);
  const host = h.one('AcpHost');
  const listeners = calls(host.on).filter(([ev]: any[]) => ev === 'event');
  listeners[1][1]({ key: 'acp:gemini:c', kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  const dir = path.join(h.userData, 'ledger');
  assert.equal(fs.existsSync(dir), false, 'still queued');
  h.app.emit('before-quit', { preventDefault: () => {} });
  const [file] = fs.readdirSync(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).harness, 'gemini');
});

test('the ledger IPC before the ledger opened reads nothing and reveals nothing; a window filter keeps only known fields', async () => {
  const handlers = new Map<string, Function>();
  register({ handle: (ch: string, f: Function) => handlers.set(ch, f) }, { shell: { openPath: async () => '' } }, () => null);
  assert.deepEqual(await handlers.get('ledger:recent')!({}, {}), []);
  assert.deepEqual(await handlers.get('ledger:reveal')!({}), { ok: false, error: 'The request log has not started' });
  assert.deepEqual(filterOf({ limit: 5, harness: 'codex', account: 'a', outcome: 'error', chat: 'c', other: 'x' }), {
    limit: 5,
    harness: 'codex',
    account: 'a',
    outcome: 'error',
    chat: 'c',
  });
  assert.deepEqual(filterOf({ harness: 'h'.repeat(300) }).harness.length, 200);
  assert.deepEqual(filterOf(null), { limit: undefined, harness: undefined, account: undefined, outcome: undefined, chat: undefined });
  assert.deepEqual(filterOf('text'), { limit: undefined, harness: undefined, account: undefined, outcome: undefined, chat: undefined });
});

test('the ledger IPC reads the ledger main opened (live.ledger) when it is asked, none before', async () => {
  const handlers = new Map<string, Function>();
  const live: { ledger?: any } = {};
  register({ handle: (ch: string, f: Function) => handlers.set(ch, f) }, { shell: { openPath: async () => '' }, live });
  assert.deepEqual(await handlers.get('ledger:recent')!({}, {}), []);
  live.ledger = { store: { recent: async () => [{ harness: 'codex' }] } };
  assert.deepEqual(await handlers.get('ledger:recent')!({}, {}), [{ harness: 'codex' }]);
  // deps without live read nothing
  const bare = new Map<string, Function>();
  register({ handle: (ch: string, f: Function) => bare.set(ch, f) }, { shell: { openPath: async () => '' } });
  assert.deepEqual(await bare.get('ledger:recent')!({}, {}), []);
});
