// A prewarmed Claude Code CLI in main (electron/harness/claude/index.cjs prewarm, #1664), run against a fake Agent SDK: the chat's
// first send uses it rather than starting a second CLI, even while it is still starting; one no chat took ends without
// a word to the windows; one a chat took reports its end like any other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prewarm-'));
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

/** A CLI that answers each prompt with a result, ends when closed or when its input closes, or fails (`crash`). */
const queries: any[] = [];
const titleHelpers: any[] = [];
(globalThis as any).__fakeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  if (options.model === 'refused') throw new Error('Claude Code is not installed');
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    inputs: [] as any[],
    closed: false,
    crash: null as Error | null,
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
        if (q.crash) throw q.crash;
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      q.inputs.push(m);
      out.push({ type: 'result', subtype: 'success' });
      wake();
    }
    // its input closed (retire): the CLI quits
    q.close();
  })();
  // the login's warm title CLI (electron/harness/claude/titleHelper.cjs) is not a chat's CLI
  (options.settingSources?.length === 0 ? titleHelpers : queries).push(q);
  return q;
};

const claude = createRequire(import.meta.url)('../electron/harness/claude/index.cjs').createClaudeHarness();
claude.timing.retireMs = 50;
const events: any[] = [];
claude.register({ handle: () => {} }, (channel: string, evt: any) => channel === 'claude:event' && events.push(evt));

async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}
const results = (key: string) => events.filter((e) => e.key === key && e.kind === 'message' && e.msg.type === 'result').length;
const ends = (key: string) => events.filter((e) => e.key === key && (e.kind === 'closed' || e.kind === 'error'));
const opts = (sessionId: string) => ({
  bin: process.execPath,
  sessionId,
  resume: false,
  cwd: tmp,
  account: 'default',
  chatId: `claude:${sessionId}`,
});
const msg = (text: string) => ({ role: 'user', content: text });

test("the chat's first send uses the warmed CLI: one process, a fresh session under the warmed id, and the prompt only then", async () => {
  const key = 'claude:pw-ready';
  const before = queries.length;
  await claude.prewarm(key, opts('pw-ready'));
  assert.equal(queries.length - before, 1);
  const q = queries.at(-1);
  assert.equal(q.options.sessionId, 'pw-ready');
  assert.equal(q.options.resume, undefined);
  assert.deepEqual(q.inputs, [], 'nothing is sent before the chat exists');
  // the login's title CLI starts with it, so the chat's first message is titled at send (#3413)
  await until('the title CLI', () => titleHelpers.length === 1);
  assert.equal(titleHelpers[0].options.model, 'haiku');
  claude.prewarmTaken(key);
  await claude.send(key, opts('pw-ready'), msg('one'));
  await until('the reply', () => results(key) === 1);
  assert.equal(queries.length - before, 1, 'no second CLI');
  await claude.turnApi.control(key, 'close');
  await until('its end', () => ends(key).length === 1);
});

test('A3: a send while the warmed CLI is still starting waits for it and uses it', async () => {
  const key = 'claude:pw-starting';
  const before = queries.length;
  const warming = claude.prewarm(key, opts('pw-starting'));
  claude.prewarmTaken(key);
  const sending = claude.send(key, opts('pw-starting'), msg('one'));
  await Promise.all([warming, sending]);
  await until('the reply', () => results(key) === 1);
  assert.equal(queries.length - before, 1);
  await claude.turnApi.control(key, 'close');
});

test('B4: a warmed CLI no chat took ends quietly, whether it is dropped or crashes', async () => {
  const key = 'claude:pw-unused';
  await claude.prewarm(key, opts('pw-unused'));
  assert.equal(claude.turnApi.isLive(key), true);
  await claude.prewarmDrop(key);
  assert.equal(claude.turnApi.isLive(key), false);
  assert.equal(queries.at(-1).closed, true);
  const crash = 'claude:pw-crash';
  await claude.prewarm(crash, opts('pw-crash'));
  const q = queries.at(-1);
  q.crash = new Error('Claude Code exited (1)');
  q.close();
  await until('the crashed CLI to go', () => !claude.turnApi.isLive(crash));
  assert.deepEqual([...ends(key), ...ends(crash)], [], 'no closed or error event reaches the windows');
  await claude.prewarmDrop(crash);
});

test('a CLI that fails to start is no prewarm and leaves nothing starting: the send then starts its own', async () => {
  const key = 'claude:pw-missing';
  await assert.rejects(claude.prewarm(key, { ...opts('pw-missing'), model: 'refused' }), /not installed/);
  const before = queries.length;
  await claude.send(key, opts('pw-missing'), msg('one'));
  await until('the reply', () => results(key) === 1);
  assert.equal(queries.length - before, 1);
  await claude.turnApi.control(key, 'close');
  await until('its end, reported now', () => ends(key).length === 1);
});
