// The control matrix's resume of a still-loaded Codex thread (#2500): Codex keeps a thread loaded about a minute after
// the lease lets go, and a thread/resume in that window spawns it again from that request's config. The thread keeps
// its sage-mcp tools (the in-app browser's browser_* among them) and its path. The injection, sessions, ToolSocket and
// Registry are real; the app-server is the kit's fake, which spawns a thread from each open's config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, codexConnection, switchingChat } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const IAB = 'browser_navigate';
const CU = 'desktop_screenshot';

test('CM-K09: a resume while the thread is still loaded keeps its browser_* tools and the same session', async () => {
  const w = world();
  const cx = codexConnection(w, (id) => id);
  const { thread } = await cx.startThread();
  const before = await cx.session(thread.id);
  assert.ok(before.tools.includes(IAB));
  // the lease let go after 5 s; Codex has not unloaded it yet when the next turn resumes it
  cx.resume(thread.id);
  const after = await cx.session(thread.id);
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.owner, before.owner);
  // and again: every resume in the window carries it
  cx.resume(thread.id);
  assert.ok((await cx.session(thread.id)).tools.includes(IAB));
});

test('CM-K09: a native thread resumed while loaded keeps its path even after the Mac changed', async () => {
  const w = world();
  const surfaces = { chrome: false, computer: true };
  const cx = codexConnection(w, (id) => id, surfaces);
  const { thread } = await cx.startThread();
  assert.equal((await cx.session(thread.id)).tools.includes(CU), false, 'native: the plugin does computer use');
  surfaces.computer = false;
  cx.resume(thread.id);
  const s = await cx.session(thread.id);
  assert.equal(s.tools.includes(CU), false, 'still native while loaded');
  assert.ok(s.tools.includes(IAB));
});

test('CM-K09: Claude -> Codex, then a resume while loaded: the calls still go to the chat', async () => {
  const w = world();
  const sw = switchingChat(w);
  sw.startOnClaude('chat-1');
  const seg = await sw.switchTo('chat-1', 'codex');
  sw.codex.resume(seg.nativeId);
  const s = await sw.codex.session(seg.nativeId);
  assert.equal(s.owner.chatId, 'chat-1');
  await s.call(IAB);
  assert.deepEqual(
    w.calls.map((c: any) => c.chatId),
    ['chat-1'],
  );
});
