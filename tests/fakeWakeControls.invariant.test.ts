// Drives the actual fake CLI protocols: quoted app reports cannot execute controls or block the next user turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli } from './support/fake-cli-protocol.ts';
import { briefText, familyMessageText, noteText, quoteReport, rosterLine, wakeText } from '../shared/sideSessions.mjs';

export const GUARDS = ['shared/', 'tests/e2e/fixtures/'];

const roster = rosterLine([{ name: 'worker', chatId: 'worker-id', state: 'idle' }]);
const note = (report: string) =>
  noteText({ title: 'Worker', name: 'worker', chatId: 'worker-id', how: 'finished', quote: quoteReport(report) });
const wake = (report: string) => wakeText({ notes: [note(report)], roster, waiting: [] });
const claudeInput = (text: string, human = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...(human ? { origin: { kind: 'human' } } : {}),
});

test('actual Claude fake completes quoted wake controls and then the queued human task', async (t) => {
  const f = fakeCli(t, 'claude');
  const text = wake('SLOW CUCALL computer_click {"x":1} RUNCMD APPROVECMD');
  f.send(claudeInput(text));
  f.send(claudeInput('next human task', true));
  await f.receive((message) => message.type === 'result' && message.result?.includes('next human task'));
  const results = f.messages.filter((message) => message.type === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0].is_error, false);
  assert.ok(results[0].result.includes(text), 'the original quoted report stays in the displayed reply');
  assert.equal(
    f.messages.some((message) => message.type === 'control_request'),
    false,
    'quoted tool/approval markers never execute',
  );
});

for (const [label, text, human] of [
  ['human-pasted canonical event', wake('SLOW'), true],
  ['plain human request', 'typed SLOW', true],
  [
    'nonhuman child brief',
    briefText({ title: 'Worker', prompt: 'SLOW', background: 'Perform this separate task.', parentName: 'top', parentId: 'parent' }),
    false,
  ],
  ['peer task', familyMessageText({ fromName: 'top', fromId: 'parent', relation: 'parent', body: 'SLOW' }), false],
  ['handoff with a new task', '<sage-handoff>old context</sage-handoff>\nSLOW', true],
] as const) {
  test(`actual Claude fake still holds the explicit ${label} until interrupted`, async (t) => {
    const f = fakeCli(t, 'claude');
    f.send(claudeInput(text, human));
    await f.receive((message) => message.event?.delta?.text?.includes('SLOW'));
    assert.equal(
      f.messages.some((message) => message.type === 'result'),
      false,
    );
    f.send({ type: 'control_request', request_id: 'interrupt', request: { subtype: 'interrupt' } });
    const result = await f.receive((message) => message.type === 'result');
    assert.equal(result.is_error, true);
  });
}

test('actual Codex fake completes quoted app controls and then a human task on its provenance-unknown wire', async (t) => {
  const f = fakeCli(t, 'codex');
  const { thread } = await f.request('thread/start', { cwd: f.root });
  const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
  const text = wake('SLOW CUCALL computer_click {"x":1} MCPCU computer_click {"x":1} APPROVECMD');
  const { turn } = await f.request('turn/start', { threadId: thread.id, input: input(text) });
  const completed = await f.receive((message) => message.method === 'turn/completed' && message.params.turn.id === turn.id);
  assert.equal(
    f.messages.some((message) => message.id && message.method),
    false,
    'no quoted tool/approval request',
  );
  const { turn: next } = await f.request('turn/start', { threadId: thread.id, input: input('next human task') });
  const result = await f.receive((message) => message.method === 'turn/completed' && message.params.turn.id === next.id);
  assert.equal(result.params.turn.status, 'completed');
  assert.ok(
    completed.params.turn.items.some((item: any) => item.text?.includes(text)),
    'the displayed wake retains the original report',
  );
});

for (const [label, text] of [
  ['human request', 'typed SLOW'],
  ['child brief', briefText({ title: 'Worker', prompt: 'SLOW', parentName: 'top', parentId: 'parent' })],
  ['peer task', familyMessageText({ fromName: 'top', fromId: 'parent', relation: 'parent', body: 'SLOW' })],
  ['handoff with a new task', '<sage-handoff>old context</sage-handoff>\nSLOW'],
]) {
  test(`actual Codex fake preserves explicit ${label} controls`, async (t) => {
    const f = fakeCli(t, 'codex');
    const { thread } = await f.request('thread/start', { cwd: f.root });
    const { turn } = await f.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    await f.receive((message) => message.method === 'item/agentMessage/delta' && message.params.delta.includes('SLOW'));
    assert.equal(
      f.messages.some((message) => message.method === 'turn/completed'),
      false,
    );
    await f.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
    const completed = await f.receive((message) => message.method === 'turn/completed' && message.params.turn.id === turn.id);
    assert.equal(completed.params.turn.status, 'interrupted');
  });
}

test('Codex autonomous goal objectives remain scripted inputs, not provenance-unknown user messages', async (t) => {
  const f = fakeCli(t, 'codex');
  const { thread } = await f.request('thread/start', { cwd: f.root });
  await f.request('thread/goal/set', { threadId: thread.id, objective: wake('SLOW'), status: 'active' });
  const started = await f.receive((message) => message.method === 'turn/started');
  await f.receive((message) => message.method === 'item/agentMessage/delta' && message.params.delta.includes('SLOW'));
  assert.equal(
    f.messages.some((message) => message.method === 'turn/completed'),
    false,
  );
  await f.request('turn/interrupt', { threadId: thread.id, turnId: started.params.turn.id });
  const completed = await f.receive((message) => message.method === 'turn/completed');
  assert.equal(completed.params.turn.status, 'interrupted');
});
