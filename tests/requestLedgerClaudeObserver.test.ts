// electron/harness/claude/index.cjs's observers (the request ledger's hook, electron/ledger/claudeTap.cjs): each one sees every
// session event beside main's hook, one that throws costs neither the others nor the windows, and ledgerAccount names
// a session's account as MoPilot resolved it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-claude-observer-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  'export const query = (args) => globalThis.__fakeQuery(args);\nexport const getSessionMessages = async () => [];',
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** A CLI that answers each prompt with an assistant message and a result, then ends when closed. */
(globalThis as any).__fakeQuery = ({ prompt }: { prompt: AsyncIterable<any> }) => {
  const out: any[] = [];
  let wake = () => {};
  let closed = false;
  const q: any = {
    close() {
      closed = true;
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
        else if (closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const _m of prompt) {
      out.push(
        { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 2 } } },
        { type: 'result', subtype: 'success', is_error: false },
      );
      wake();
    }
  })();
  return q;
};

const require = createRequire(import.meta.url);
const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

test('ledgerAccount before the logins are open names the login by its id alone, paid in a way not known yet', () => {
  assert.deepEqual(
    claude.ledgerAccount({ login: true, account: 'b1' }),
    { id: 'b1', pay: 'unknown' },
    'a login not read yet may be a Console key',
  );
});

test('every observer sees each session event beside the hook; one that throws is noted and costs nobody else', async () => {
  const hook: any[] = [];
  const windows: any[] = [];
  claude.register({ handle: () => {} }, (channel: string, evt: any) => channel === 'claude:event' && windows.push(evt), {
    onEvent: (e: any) => hook.push(e),
  });
  const seen: any[] = [];
  const stopThrowing = claude.observe(() => {
    throw new Error('observer broke');
  });
  const stop = claude.observe((e: any) => seen.push(e));
  clearIgnored();
  const debug = console.debug;
  console.debug = () => {};
  try {
    await claude.send(
      'claude:obs',
      { bin: process.execPath, sessionId: 'obs', cwd: tmp, account: 'default' },
      { role: 'user', content: 'hi' },
    );
    await waitFor(() => seen.some((e) => e.msg?.type === 'result'), 'the result message');
  } finally {
    console.debug = debug;
  }
  const kinds = (list: any[]) => list.filter((e) => e.kind === 'message').map((e) => e.msg.type);
  assert.deepEqual(kinds(seen), ['assistant', 'result']);
  assert.deepEqual(kinds(hook), kinds(seen));
  assert.deepEqual(kinds(windows), kinds(seen));
  assert.ok(recentIgnored().some((e: any) => e.context === 'handle a Claude Code message event' && e.message.includes('observer broke')));
  stop();
  stopThrowing();
  const before = seen.length;
  claude.retire('claude:obs');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.length, before, 'a stopped observer sees nothing more');
  // with the logins open, a subscription session is named by its login's row; a key by how it bills
  const own = claude.ledgerAccount({ login: true, account: 'default' });
  assert.equal(own.id, 'default');
  assert.ok('email' in own);
  assert.equal(claude.ledgerAccount({ login: false, account: 'default' }).id, claude.authMode());
});
