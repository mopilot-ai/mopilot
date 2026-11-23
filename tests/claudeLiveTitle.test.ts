// A Claude Code chat's title from its running CLI (electron/harness/claude/sessions.cjs generateTitle, #2150), against a fake
// Agent SDK: asked unsaved, so a name the user gives meanwhile wins; an SDK without the request answers null.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-title-'));
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

/** A CLI that answers each prompt with a result and ends when closed. */
const queries: any[] = [];
(globalThis as any).__fakeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
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
    async getSettings() {
      return { applied: {} };
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
    for await (const _m of prompt) {
      out.push({ type: 'result', subtype: 'success' });
      wake();
    }
    q.close();
  })();
  queries.push(q);
  return q;
};

const claude = createRequire(import.meta.url)('../electron/harness/claude/index.cjs').createClaudeHarness();
const events: any[] = [];
claude.register({ handle: () => {} }, (channel: string, evt: any) => channel === 'claude:event' && events.push(evt));

test("the running CLI writes a chat's title without saving it; a CLI without the request answers null", async () => {
  const key = 'claude:title';
  // any executable stands in for the CLI: the fake SDK never runs it (a runner has no claude installed)
  const opts = { bin: process.execPath, sessionId: 'title', resume: false, cwd: tmp, account: 'default', chatId: key };
  await claude.send(key, opts, { role: 'user', content: 'go' });
  await waitFor(() => events.some((e) => e.key === key && e.msg?.type === 'result'), 'the result event');
  const q = queries.at(-1);
  // an SDK without generateSessionTitle (an older one): nothing to ask
  assert.equal(await claude.turnApi.control(key, 'generateTitle', 'fix the login bug'), null);
  const asked: any[] = [];
  q.generateSessionTitle = async (text: string, o: any) => (asked.push([text, o]), 'Login bug');
  assert.equal(await claude.turnApi.control(key, 'generateTitle', 'fix the login bug'), 'Login bug');
  assert.equal(await claude.turnApi.control(key, 'generateTitle'), 'Login bug');
  // MoPilot saves it itself, so a name the user gave meanwhile wins
  assert.deepEqual(asked, [
    ['fix the login bug', { persist: false }],
    ['', { persist: false }],
  ]);
  // a chat with no running CLI has no one to ask
  assert.equal(await claude.turnApi.control('claude:none', 'generateTitle', 'x'), null);
  await claude.turnApi.control(key, 'close');
});

test("a new chat's title at send comes from its login's warm title CLI, one lean CLI the next chat reuses (#3413)", async () => {
  const before = queries.length;
  const title = (text: string) => claude.turnApi.title(text, tmp, process.execPath, 'default', 'claude:t2', { helper: true });
  // this SDK can't ask for a title: null, and the chat's own CLI is asked instead
  assert.equal(await title('fix the login bug'), null);
  assert.equal(queries.length - before, 1);
  const q = queries.at(-1);
  assert.deepEqual(q.options.settingSources, []);
  assert.deepEqual(q.options.tools, []);
  q.generateSessionTitle = async (text: string, o: any) => `${text} (${o.persist})`;
  assert.equal(await title('next chat'), 'next chat (false)');
  assert.equal(queries.length - before, 1, 'the same CLI');
});
