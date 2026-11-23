// The scripted Codex app-server ends a turn interrupted when the Stop lands while it is still writing the reply after a tool call (#4704).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli } from './support/fake-cli-protocol.ts';

const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

test('a Stop that reaches the fake after its tool call returned ends the turn interrupted, with the reply cut short', async (t) => {
  const f = fakeCli(t, 'codex');
  const { thread } = await f.request('thread/start', { cwd: f.root });
  // no MoPilot tool server here, so the call answers at once ("no sage server") and the reply is written next, a few characters at a time
  // the call is a line of its own; the lines after it make the reply long enough to take many steps to write
  const text = 'MCPCU desktop_app_batch {}\nand a long enough request that its reply takes many steps to write out';
  const { turn } = await f.request('turn/start', { threadId: thread.id, input: input(text) });
  await f.receive((m) => m.method === 'item/agentMessage/delta');
  await f.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  const done = await f.receive((m) => m.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'interrupted');
  const written = done.params.turn.items.find((i: any) => i.type === 'agentMessage').text;
  assert.ok(written.length < `fake-codex: ${text} [cu: no sage server]`.length, `the reply was cut short (${written.length} characters)`);
  // the Stop took the turn's one interrupt hook with it: a repeated Stop is harmless
  await f.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
});

test('a turn that was not stopped completes in full, and a Stop after its end leaves no hook behind', async (t) => {
  const f = fakeCli(t, 'codex');
  const { thread } = await f.request('thread/start', { cwd: f.root });
  const text = 'MCPCU desktop_app_batch {}';
  const { turn } = await f.request('turn/start', { threadId: thread.id, input: input(text) });
  const done = await f.receive((m) => m.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'completed');
  assert.equal(done.params.turn.items.find((i: any) => i.type === 'agentMessage').text, `fake-codex: ${text} [cu: no sage server]`);
  // a Stop that arrives after the turn is over changes nothing
  await f.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  assert.equal(f.messages.filter((m) => m.method === 'turn/completed').length, 1);
});
