// Claude in Chrome's live link in a Claude Code session (BU-07): electron/harness/claude/chromeLink.cjs reads it
// through the SDK-bundled CLI's control requests (getChromeDialog, getChromeBrowsers, selectChromeBrowser,
// reconnectMcpServer), and electron/harness/claude/index.cjs keeps one per session, re-reads it when the session starts
// or a Claude in Chrome tool says the extension went away, and reconnects or switches browsers on request.
// Run against a fake Agent SDK and a fake Electron; the session code is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-chrome-link-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__fakeLinkQuery(args);',
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

const require = createRequire(import.meta.url);
const link = require('../electron/harness/claude/chromeLink.cjs');
const { ChromeLink, readLink, listBrowsers, selectBrowser, reconnect, errorText, SERVER, UNKNOWN } = link;

const DIALOG = {
  allowed: true,
  subscriber: true,
  wsl: false,
  installed: true,
  connected: true,
  paired_browser: 'Chrome on Mac',
  enabled_by_default: true,
  urls: { install: 'https://i', reconnect: 'https://r', permissions: 'https://p' },
};
const LINK = { connected: true, browser: 'Chrome on Mac', installed: true, reconnectUrl: 'https://r', permissionsUrl: 'https://p' };
/** a link as a session keeps it */
const KEPT = { ...LINK, dropped: false };
const never = () => new Promise(() => {});

/* ------------------------------------------------------------------ the module */

test("the link from the CLI's /chrome dialog", async () => {
  assert.deepEqual(await readLink({ getChromeDialog: async () => DIALOG }), LINK);
  assert.deepEqual(
    await readLink({ getChromeDialog: async () => ({ connected: false, paired_browser: '', installed: false, urls: { reconnect: 1 } }) }),
    {
      connected: false,
      browser: null,
      installed: false,
      reconnectUrl: null,
      permissionsUrl: null,
    },
  );
  assert.deepEqual(await readLink({ getChromeDialog: async () => ({ connected: true, paired_browser: 7 }) }), {
    connected: true,
    browser: null,
    installed: true,
    reconnectUrl: null,
    permissionsUrl: null,
  });
  assert.equal(await readLink(null), null);
});

test("without a dialog answer, the claude-in-chrome server's mcp status can only say the link is down", async () => {
  const status = (rows: any) => ({ mcpServerStatus: async () => rows });
  // a running server says nothing about the extension: unknown, never "connected"
  assert.equal(await readLink(status([null, { name: 'x', status: 'connected' }, { name: SERVER, status: 'connected' }])), UNKNOWN);
  assert.deepEqual(await readLink(status([{ name: SERVER, status: 'failed' }])), {
    connected: false,
    browser: null,
    installed: true,
    reconnectUrl: null,
    permissionsUrl: null,
  });
  assert.equal(await readLink(status([{ name: 'other', status: 'connected' }])), null);
  assert.equal(await readLink(status('x')), null);
  // a dialog that fails or answers nothing falls back too
  assert.equal(
    (await readLink({
      getChromeDialog: async () => {
        throw new Error('unknown subtype');
      },
      ...status([{ name: SERVER, status: 'failed' }]),
    }))!.connected,
    false,
  );
  assert.equal((await readLink({ getChromeDialog: async () => null, ...status([{ name: SERVER, status: 'pending' }]) }))!.connected, false);
  // neither answers
  assert.equal(await readLink({ getChromeDialog: async () => 'x' }), null);
  assert.equal(
    await readLink({
      mcpServerStatus: async () => {
        throw new Error('closed');
      },
    }),
    null,
  );
  assert.equal(await readLink({}), null);
  // a CLI that does not answer in time
  assert.equal(await readLink({ getChromeDialog: never, mcpServerStatus: never }, 5), null);
});

test('the paired browsers, the switch between them, and Reconnect extension', async () => {
  const browsers = [{ device_id: 'b1', name: 'Chrome', current: true }, { device_id: 'b2', name: '' }, { name: 'no id' }, null];
  assert.deepEqual(await listBrowsers({ getChromeBrowsers: async () => ({ browsers }) }), [
    { id: 'b1', name: 'Chrome', current: true },
    { id: 'b2', name: 'b2', current: false },
  ]);
  assert.deepEqual(await listBrowsers({ getChromeBrowsers: async () => ({}) }), []);
  assert.deepEqual(
    await listBrowsers({
      getChromeBrowsers: async () => {
        throw new Error('not connected');
      },
    }),
    [],
  );
  assert.deepEqual(await listBrowsers({}), []);
  assert.deepEqual(await listBrowsers(null), []);
  const calls: any[] = [];
  await selectBrowser({ selectChromeBrowser: async (id: string) => calls.push(['select', id]) }, 7);
  await reconnect({ reconnectMcpServer: async (name: string) => calls.push(['reconnect', name]) });
  assert.deepEqual(calls, [
    ['select', '7'],
    ['reconnect', SERVER],
  ]);
  await assert.rejects(selectBrowser({}, 'b1'), /can't switch browsers/);
  await assert.rejects(reconnect(null), /can't reconnect/);
  await assert.rejects(selectBrowser({ selectChromeBrowser: never }, 'b1', 5), /Timed out/);
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('plain'), 'plain');
});

test('a session re-reads its link when it starts with the server, and when a Chrome tool says the extension went away', () => {
  const l = new ChromeLink();
  assert.equal(l.note({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'x' }, null, { name: SERVER }] }), 'start');
  assert.equal(l.note({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'x' }] }), null);
  assert.equal(l.note({ type: 'system', subtype: 'init' }), null);
  assert.equal(l.note(null), null);
  assert.equal(l.note({ type: 'assistant', message: { content: 'text' } }), null);
  const use = (...ids: string[]) => ({
    type: 'assistant',
    message: {
      content: [
        { type: 'text' },
        ...ids.map((id) => ({ type: 'tool_use', id, name: id.startsWith('o') ? 'mcp__other__x' : 'mcp__claude-in-chrome__navigate' })),
      ],
    },
  });
  const result = (id: string, content: any, isError = true) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });
  const results = (...blocks: any[]) => ({ type: 'user', message: { content: [null, ...blocks] } });
  assert.equal(l.note(use('a', 'other')), null);
  // an error about something else, an error for another tool, and an error that says the link is gone
  assert.equal(l.note(results(result('a', 'Element not found'))), null);
  assert.equal(l.note(results(result('other', 'Browser extension is not connected'))), null);
  l.note(use('c', 'd'));
  assert.equal(
    l.note(results(result('c', [{ type: 'image' }, { type: 'text', text: 'Browser extension is not connected' }]), result('d', 7))),
    'error',
  );
  // a working tool: worth a look only while the link is known to be down
  l.note(use('e'));
  assert.equal(l.note(results(result('e', 'ok', false))), null);
  assert.equal(l.set({ connected: false }), true);
  l.note(use('f', 'g', 'h'));
  assert.equal(l.note(results(result('f', 'ok', false), result('g', 'ok', false))), 'working');
  // an error that says the link is gone wins over a working tool in the same message
  l.note(use('i'));
  const lost =
    'The "navigate" tool call failed because the Chrome extension disconnected mid-operation. This is usually transient (Chrome service worker restart, tab closed, network blip) and the extension often reconnects automatically.';
  assert.equal(l.note(results(result('h', 'ok', false), result('i', lost))), 'error');
  // a result that answers no pending call
  assert.equal(l.note(results(result('zzz', 'Browser extension is not connected'))), null);
});

test('a reading is a drop only after the link was up, or when a tool found it gone', () => {
  const l = new ChromeLink();
  // still connecting at the start: down, not dropped
  assert.equal(l.set({ connected: false }, 'start'), true);
  assert.deepEqual(l.state, { connected: false, dropped: false });
  assert.equal(l.set({ connected: false }, 'refresh'), false);
  assert.equal(l.set({ connected: true }, 'refresh'), true);
  assert.deepEqual(l.state, { connected: true, dropped: false });
  // down after it was up
  l.set({ connected: false }, 'refresh');
  assert.equal(l.state.dropped, true);
  // still down after a reconnect: still a drop
  l.set({ connected: false });
  assert.equal(l.state.dropped, true);
  // a CLI that can't say keeps the last reading, drop included
  assert.equal(l.set(null), false);
  assert.deepEqual(l.state, { connected: false, dropped: true });
  // an older CLI whose server runs again (after a reconnect, or a tool that worked): no longer down, but unknown
  assert.equal(l.set(UNKNOWN, 'reconnect'), true);
  assert.equal(l.state, null);
  assert.equal(l.set(UNKNOWN), false);
  // and down again later is a fresh reading, not a drop
  l.set({ connected: false }, 'refresh');
  assert.equal(l.state.dropped, false);
  // a tool that found it gone, from a session that never read it as up
  const fresh = new ChromeLink();
  fresh.set({ connected: false }, 'error');
  assert.equal(fresh.state.dropped, true);
  assert.equal(fresh.set(null), false);
  assert.equal(new ChromeLink().set(null), false);
});

/* ------------------------------------------------------------------ the sessions (electron/harness/claude/index.cjs) */

const queries: any[] = [];
(globalThis as any).__fakeLinkQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    closed: false,
    calls: [] as any[],
    dialog: { ...DIALOG },
    browsers: [
      { device_id: 'b1', name: 'Chrome', current: true },
      { device_id: 'b2', name: 'Arc', current: false },
    ],
    push(m: any) {
      out.push(m);
      wake();
    },
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async getSettings() {
      return { applied: {} };
    },
    async getChromeDialog() {
      q.calls.push('dialog');
      return q.dialogGate ? q.dialogGate.then(() => q.dialog) : q.dialog;
    },
    async getChromeBrowsers() {
      return { browsers: q.browsers };
    },
    async selectChromeBrowser(id: string) {
      q.calls.push(['select', id]);
      if (q.selectFails) throw q.selectFails;
      q.dialog = { ...q.dialog, paired_browser: q.browsers.find((b: any) => b.device_id === id)?.name };
    },
    async reconnectMcpServer(name: string) {
      q.calls.push(['reconnect', name]);
      if (q.reconnectFails) throw q.reconnectFails;
      q.dialog = { ...q.dialog, connected: true };
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) q.push({ type: 'result', subtype: 'success', echo: m.message.content });
  })();
  queries.push(q);
  return q;
};

const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();
const handlers = new Map<string, (...a: any[]) => any>();
const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
claude.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => {});
async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}
let serial = 0;
async function startChat(chatId?: string) {
  const sid = `link-${++serial}`;
  const key = `claude:${sid}`;
  const before = queries.length;
  await claude.send(
    key,
    { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', chatId },
    { role: 'user', content: 'hi' },
  );
  await until('the CLI', () => queries.length > before);
  return { key, q: queries[before], chatId: chatId ?? key };
}
const INIT = { type: 'system', subtype: 'init', mcp_servers: [{ name: SERVER, status: 'connected' }] };
const toolUse = (id: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'mcp__claude-in-chrome__computer' }] },
});
const toolError = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Browser extension is not connected' }] },
});

test('a Claude in Chrome session reports its link, a drop, Reconnect, the browser picker, and its end', async () => {
  const seen: any[] = [];
  // before main listens, a change goes nowhere
  claude.setTools({ enabled: () => false, nativeChrome: () => true });
  const early = await startChat();
  early.q.push(INIT);
  await until('the first read', () => early.q.calls.includes('dialog'));
  await call('claude:control', early.key, 'close');
  await until('the early session to end', () => !queries.some((q: any) => !q.closed && q.options.extraArgs?.chrome === null));
  await new Promise((r) => setTimeout(r, 20));
  claude.setChromeLinkListener((chatId: string, l: any, key: string) => seen.push([chatId, l, key]));
  const a = await startChat('chat-a');
  try {
    assert.deepEqual(a.q.options.extraArgs, { chrome: null });
    assert.equal(claude.chromeLinkOf(a.key), null, 'not read yet');
    a.q.push(INIT);
    await until('the link', () => seen.length === 1);
    // each reading names the session it came from, so main can keep it to the chat's current segment
    assert.deepEqual(seen[0], ['chat-a', KEPT, a.key]);
    assert.deepEqual(claude.chromeLinkOf(a.key), KEPT);
    assert.equal(claude.chromeLinkOf('claude:none'), null, 'no session on that key');
    assert.deepEqual(await claude.chromeLinks(), [{ key: a.key, chatId: 'chat-a', link: KEPT }]);
    // the same reading again is not a change
    a.q.push(INIT);
    await until('the second read', () => a.q.calls.filter((c: any) => c === 'dialog').length === 2);
    assert.equal(seen.length, 1);
    // Settings opened: every session reads its link again first
    assert.deepEqual(await claude.chromeLinks(true), [{ key: a.key, chatId: 'chat-a', link: KEPT }]);
    assert.equal(a.q.calls.filter((c: any) => c === 'dialog').length, 3);
    assert.equal(seen.length, 1);
    // the extension goes away mid-session
    a.q.dialog = { ...a.q.dialog, connected: false, paired_browser: undefined };
    a.q.push(toolUse('t1'));
    a.q.push(toolError('t1'));
    await until('the drop', () => seen.length === 2);
    assert.equal(seen[1][1].connected, false);
    assert.equal(seen[1][1].dropped, true);
    assert.deepEqual(await claude.chromeBrowsers(), []);
    assert.deepEqual(await claude.chromeSelect('b2'), []);
    // Reconnect for every chat whose link is down
    const back = await claude.chromeReconnect(null);
    assert.deepEqual(back, [{ chatId: 'chat-a', link: { ...KEPT, browser: null }, error: null }]);
    assert.deepEqual(
      a.q.calls.filter((c: any) => Array.isArray(c)),
      [['reconnect', SERVER]],
    );
    assert.equal(seen.at(-1)[1].connected, true);
    // with nothing down, Reconnect without a chat touches nothing
    assert.deepEqual(await claude.chromeReconnect(null), []);
    // the picker lists the paired browsers, and a pick switches every connected session
    assert.deepEqual(await claude.chromeBrowsers(), [
      { id: 'b1', name: 'Chrome', current: true },
      { id: 'b2', name: 'Arc', current: false },
    ]);
    assert.deepEqual(await claude.chromeSelect('b2'), [{ chatId: 'chat-a', link: { ...KEPT, browser: 'Arc' }, error: null }]);
    // failures come back per chat
    a.q.selectFails = new Error('not paired');
    assert.equal((await claude.chromeSelect('b9'))[0].error, 'not paired');
    a.q.reconnectFails = 'socket closed';
    assert.equal((await claude.chromeReconnect('chat-a'))[0].error, 'socket closed');
    assert.deepEqual(await claude.chromeReconnect('another chat'), []);
    // a session that lists no browsers is passed over
    a.q.browsers = [];
    assert.deepEqual(await claude.chromeBrowsers(), []);
  } finally {
    await call('claude:control', a.key, 'close');
  }
  await until('the end', () => seen.at(-1)[1] === null);
  assert.equal(seen.at(-1)[0], 'chat-a');
  assert.equal(seen.at(-1)[2], a.key);
  assert.equal(claude.chromeLinkOf(a.key), null, 'the session is gone');
  assert.deepEqual(await claude.chromeLinks(true), []);
});

test('sessions without Claude in Chrome keep no link; a reading that lands after the end is dropped', async () => {
  const seen: any[] = [];
  claude.setChromeLinkListener((chatId: string, l: any) => seen.push([chatId, l]));
  claude.setTools({ enabled: () => false, nativeChrome: () => false });
  const plain = await startChat('plain');
  claude.setTools({ enabled: () => false, nativeChrome: () => true });
  const late = await startChat('late');
  try {
    plain.q.push(INIT);
    assert.deepEqual(
      (await claude.chromeLinks()).map((l: any) => l.chatId),
      ['late'],
    );
    // a connected session next to one without a link
    late.q.push(INIT);
    await until('the link', () => seen.length === 1);
    assert.equal((await claude.chromeBrowsers()).length, 2);
    assert.equal((await claude.chromeSelect('b1')).length, 1);
    assert.deepEqual(await claude.chromeReconnect(null), []);
    // the next reading waits; the session ends first
    let open!: () => void;
    late.q.dialogGate = new Promise<void>((r) => (open = r));
    late.q.dialog = { ...late.q.dialog, connected: false };
    late.q.push(toolUse('x'));
    late.q.push(toolError('x'));
    await until('the read', () => late.q.calls.filter((c: any) => c === 'dialog').length === 2);
    await call('claude:control', late.key, 'close');
    await until('the end', () => seen.at(-1)[1] === null);
    const count = seen.length;
    open();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, count);
  } finally {
    await call('claude:control', plain.key, 'close');
  }
  // without a listener, changes go nowhere
  claude.setChromeLinkListener(null);
  const quiet = await startChat('quiet');
  quiet.q.push(INIT);
  await until('the read', () => quiet.q.calls.includes('dialog'));
  await call('claude:control', quiet.key, 'close');
  assert.equal(seen.filter(([c]) => c === 'quiet').length, 0);
});

test('a CLI process start tells main its chat and key, and whether it runs Claude in Chrome is read from the process', async () => {
  const started: string[][] = [];
  claude.setProcessListener((chatId: string, key: string) => started.push([chatId, key, String(claude.nativeChromeOf(key))]));
  claude.setTools({ enabled: () => false, nativeChrome: () => false });
  const plain = await startChat('plan-plain');
  assert.deepEqual(claude.toolsOf(plain.key, ['chrome_tabs_context_mcp']), []);
  claude.setTools({ enabled: () => false, nativeChrome: () => true });
  const linked = await startChat('plan-linked');
  assert.deepEqual(started, [
    ['plan-plain', plain.key, 'false'],
    ['plan-linked', linked.key, 'true'],
  ]);
  await call('claude:control', plain.key, 'close');
  await call('claude:control', linked.key, 'close');
  assert.equal(claude.nativeChromeOf(linked.key), null, 'no process runs for the key now');
  assert.equal(claude.toolsOf(linked.key, ['chrome_tabs_context_mcp']), null);
  claude.setProcessListener(() => {});
});

test('a live Claude process exposes only its injected tools under the real server presentation', async () => {
  const { Registry } = require('../electron/capabilities/contract/registry.cjs');
  const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
  const registry = new Registry();
  for (const name of ['chrome_tabs_context_mcp', 'chrome_navigate', 'sage_browser_snapshot'])
    registry.register({ name, description: name, policy: 'observe', handler: async () => [] });
  claude.setTools({ registry, sessions: new ToolSessions(), enabled: () => true, nativeChrome: () => false });
  const session = await startChat('own-tools');
  const names = ['chrome_tabs_context_mcp', 'chrome_navigate', 'sage_browser_snapshot'];
  assert.deepEqual(claude.toolsOf(session.key, [...names, 'chrome_missing']), names);
  assert.deepEqual(claude.toolsOf(session.key, ['chrome_navigate']), ['chrome_navigate']);
  await call('claude:control', session.key, 'close');
  claude.setTools({ enabled: () => false, nativeChrome: () => false });
});

test('a non-string block cannot invent a Chrome disconnect error', () => {
  const state = new ChromeLink();
  state.note({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__claude-in-chrome__navigate' }] } });
  const content = [{ type: 'text', text: ['Browser extension is not connected'] }];
  const result = { type: 'tool_result', tool_use_id: 't', is_error: true, content };
  assert.equal(state.note({ type: 'user', message: { content: [result] } }), null);
});
