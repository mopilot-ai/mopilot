// The Claude Code side of the Claude in Chrome control-matrix cases (tests/controlMatrixChrome*.test.ts): a fake
// Electron while electron/harness/claude/index.cjs loads, a fake Agent SDK whose CLI answers each prompt and runs its exit hooks when
// its input ends, the real harness/claude/index.cjs over it, and helpers to start a chat with Claude in Chrome and report its group.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './waitFor.ts';

/* ---------- a fake Electron (only while electron/harness/claude/index.cjs loads) and a fake Agent SDK ---------- */

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-y-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__matrixYQuery(args);',
    'export const deleteSession = async () => true;',
    'export const tool = (name, description, schema, handler) => ({ name, description, handler });',
    "export const createSdkMcpServer = (o) => ({ type: 'sdk', ...o });",
  ].join('\n'),
);
let fakeElectron = true;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: pathToFileURL(path.join(tmp, 'sdk.mjs')).href, shortCircuit: true };
    if (specifier === 'electron' && fakeElectron) return { url: pathToFileURL(path.join(tmp, 'electron.cjs')).href, shortCircuit: true };
    return next(specifier, context);
  },
});

export const DIALOG = {
  installed: true,
  connected: true,
  paired_browser: 'Chrome on Mac',
  urls: { reconnect: 'https://r', permissions: 'https://p' },
};
/** While true, a prompt gets no result: the turn keeps running until the test sends one. */
let holdTurns = false;
/** Makes prompts wait for the test's own result (true), or answers them at once again (false). */
export const setHoldTurns = (v: boolean) => {
  holdTurns = v;
};

/** A Claude Code CLI over the SDK: answers each prompt with a result, and when its input ends runs its exit hooks and quits. */
export const queries: any[] = [];
(globalThis as any).__matrixYQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    log: [] as string[],
    quit: false,
    dialog: { ...DIALOG },
    selected: [] as string[],
    push(m: any) {
      out.push(m);
      wake();
    },
    close() {
      q.log.push('close');
      q.quit = true;
      wake();
    },
    async interrupt() {
      q.log.push('interrupt');
    },
    async getSettings() {
      return { applied: {} };
    },
    async getChromeDialog() {
      return q.dialog;
    },
    async reconnectMcpServer() {
      q.log.push('reconnect');
    },
    async selectChromeBrowser(id: string) {
      q.selected.push(id);
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.quit) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const _m of prompt) if (!holdTurns) q.push({ type: 'result', subtype: 'success' });
    q.log.push('eof');
    // a test sets exitGate to keep this CLI in its exit hooks until it opens the gate
    await q.exitGate;
    q.log.push('exit hooks');
    q.quit = true;
    wake();
  })();
  queries.push(q);
  return q;
};

const require = createRequire(import.meta.url);
// the app's hand-off check, as electron/main.cjs gives it
export const claude = require('../../electron/harness/claude/index.cjs').createClaudeHarness({
  handedOff: require('../../electron/capabilities/browser/handoffPages.cjs').handedOff,
});
fakeElectron = false;
export const { SERVER } = require('../../electron/harness/claude/chromeLink.cjs');

export const handlers = new Map<string, (...a: any[]) => any>();
export const ipc = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
claude.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => {});
claude.timing.blankGroupMs = 20;
claude.timing.retireMs = 200;

export async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}
export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
/** A gate the test opens itself, when the step it waits for has happened. */
export function opened() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Starts a chat's Claude session (key claude:<id>) with Claude in Chrome on, its link read as connected. */
export async function claudeChrome(sessionId: string, chatId: string) {
  claude.setTools({ enabled: () => false, nativeChrome: () => true });
  const key = `claude:${sessionId}`;
  const before = queries.length;
  await claude.send(
    key,
    { bin: process.execPath, sessionId, resume: true, cwd: tmp, account: 'default', chatId },
    { role: 'user', content: 'hi' },
  );
  await until('the CLI', () => queries.length > before);
  const q = queries[before];
  q.push({ type: 'system', subtype: 'init', mcp_servers: [{ name: SERVER, status: 'connected' }] });
  await until('the link', () => claude.chromeLinkOf(key)?.connected === true);
  return { key, q };
}
/** A Claude in Chrome call whose result says the session's group holds `urls`. */
export function groupHolds(q: any, id: string, urls: string[]) {
  q.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__claude-in-chrome__navigate', input: {} }] } });
  const lines = urls.map((u, i) => `  • tabId ${i + 1}: "T" ("${u}")`).join('\n');
  q.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Done.\n\nAvailable tabs:\n${lines}` }] } });
}
