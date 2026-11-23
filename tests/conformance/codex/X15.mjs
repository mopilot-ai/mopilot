// MoPilot's tool channel end to end (WP5-8, A8): a thread gets sage-mcp through the per-thread
// config fragment (electron/capabilities/channels/codexConfig.cjs), the model calls sage_debug_echo
// and reads back a random word; the same thread resumed in a new app-server gets a rotated token and
// reads another word; cua_repl is not among the thread's MCP servers. Needs native/sage-mcp/build.
// Runs in a throwaway CODEX_HOME (shared by both app-servers, so the thread can be resumed): two cheap turns.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { open, agentText, tempHome, sleep } from '../lib/codex.mjs';
import { randomWord } from '../lib/png.mjs';

export const id = 'X15';
export const title = "MoPilot's tools on a new and a resumed thread";
export const timeoutMs = 600000;

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '../../..');
const { Registry } = require(path.join(REPO, 'electron/capabilities/contract/registry.cjs'));
const { ToolSessions } = require(path.join(REPO, 'electron/capabilities/contract/session.cjs'));
const { ToolSocket, sageMcpPath } = require(path.join(REPO, 'electron/capabilities/mcp/socket.cjs'));
const { CodexToolInjection } = require(path.join(REPO, 'electron/capabilities/channels/codexConfig.cjs'));
const { echo } = require(path.join(REPO, 'electron/capabilities/tools/debug.cjs'));

const ask = (w) => `Call the sage_debug_echo tool exactly once with the text "${w}". Reply with only what it returned.`;

export default async function run(ctx) {
  const command = sageMcpPath({ packaged: false, repoRoot: REPO });
  if (!fs.existsSync(command))
    return ctx.result({ note: `no sage-mcp at ${command}; build native/sage-mcp first` }, {}, { verdict: 'skip' });
  const registry = new Registry();
  registry.register(echo);
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry });
  const socketPath = await socket.listen();
  ctx.defer(() => socket.close());
  let harness = null;
  const tools = new CodexToolInjection({ sessions, command, socketPath, harnessPid: () => harness?.proc.pid });
  // what main does with each request and response: add the thread's fragment, see the answer
  let seq = 0;
  const withTools = (c, method, params) => {
    const msg = tools.outgoing({ id: `x15-${++seq}`, method, params });
    return c.request(method, msg.params).then((r) => (tools.observe({ id: msg.id, result: r.result, error: r.error }), r));
  };
  const serverNames = async (c, threadId) => {
    await sleep(3000);
    const s = await c.request('mcpServerStatus/list', { threadId }, 90000);
    return (s.result?.data ?? []).map((x) => x.name);
  };
  const o = {};
  const env = tempHome(ctx);

  // a new thread
  let c = await open(ctx, 'new', { env });
  harness = c;
  // thread/start as main sends it: with the thread's sage-mcp fragment
  const t = await withTools(c, 'thread/start', {
    model: ctx.model,
    cwd: ctx.cwd('thread'),
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    serviceTier: 'default',
    config: { model_reasoning_effort: ctx.effort },
  });
  if (t.error) return ctx.result({ startError: t.error.message }, {}, { verdict: 'error' });
  const thread = t.result.thread.id;
  c.threads.add(thread);
  o.newServers = await serverNames(c, thread);
  const w1 = randomWord();
  const r1 = await c.turn(thread, ask(w1), {}, 150000);
  o.newReply = agentText(c.items(r1.from, thread)).slice(0, 200);
  c.threads.delete(thread);
  await c.close();

  // the same thread in a new app-server: resumed with a rotated token
  c = await open(ctx, 'resumed', { env });
  harness = c;
  tools.exited();
  const res = await withTools(c, 'thread/resume', { threadId: thread, excludeTurns: true });
  c.threads.add(thread);
  o.resumeError = res.error?.message ?? null;
  o.resumedServers = await serverNames(c, thread);
  const w2 = randomWord();
  const r2 = await c.turn(thread, ask(w2), {}, 150000);
  o.resumedReply = agentText(c.items(r2.from, thread)).slice(0, 200);
  await c.close();

  const sage = (names) => (names ?? []).some((n) => /^sage_[0-9a-f]{12}$/.test(n));
  return ctx.result(o, {
    'a new thread lists its sage_<nonce> server': sage(o.newServers),
    'cua_repl is not loaded on the thread': !(o.newServers ?? []).includes('cua_repl') && !(o.resumedServers ?? []).includes('cua_repl'),
    'sage_debug_echo reads the word back on a new thread': o.newReply.toUpperCase().includes(w1),
    'a resumed thread gets its server again': !o.resumeError && sage(o.resumedServers),
    'sage_debug_echo reads the word back on the resumed thread': o.resumedReply.toUpperCase().includes(w2),
  });
}
