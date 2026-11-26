// Native follow-ups use the real controller and live session store, with vendor replies supplied at their wire boundaries.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { setup } from './support/controller-coverage/setup.ts';

const require = createRequire(import.meta.url);
const { recordSessionUpdate } = require('../electron/harness/acp/sessionUpdates.cjs');
const { RpcPeer } = require('../electron/harness/acp/rpc.cjs');
const { samplePromptSuggestion } = require('../electron/harness/codexPromptSuggestion.cjs');
const { CodexConnection } = require('../electron/harness/codexConnection.cjs');

test('Codex samples once per eligible turn and discards old answers even when the turn id is reused', async () => {
  const requests: Array<{ params: any; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const id = 'cx1';
  const { c, state, s } = setup({
    ctl: {
      codex: {
        promptSuggestion: CodexConnection.prototype.promptSuggestion,
        request: (method: string, params: any, options: any) => {
          assert.equal(method, 'thread/sample');
          assert.equal(params.threadId, id);
          assert.equal(params.disableMcp, true);
          assert.equal(options.timeoutMs, 8000);
          assert.equal(options.background, true);
          return new Promise((resolve, reject) => requests.push({ params, resolve, reject }));
        },
      },
    },
  });
  function finish(turnId: string, status = 'completed') {
    c.onCodexMessage({ method: 'turn/completed', params: { threadId: id, turn: { id: turnId, status } } });
  }
  state.step(id, 'start', { turnId: 'same', human: true });
  finish('same');
  finish('same');
  assert.equal(requests.length, 1);
  assert.equal(s(id).turn, 'idle', 'a prediction never holds the regular turn open');
  state.step(id, 'start', { turnId: 'same', human: true });
  finish('same');
  assert.equal(requests.length, 2);
  requests[1].resolve({ sourceTurnId: 'same', text: '  Add a regression test. ' });
  await tick();
  assert.equal(state.snapshot(id).promptSuggestion, 'Add a regression test.');
  requests[0].resolve({ sourceTurnId: 'same', text: 'Old context' });
  await tick();
  assert.equal(s(id).promptSuggestion, 'Add a regression test.');
  c.onCodexExit();
  assert.equal(s(id).promptSuggestion, null);

  state.step(id, 'start', { turnId: 'rejected', human: true });
  assert.equal(s(id).promptSuggestion, null);
  finish('rejected');
  requests[2].reject(new Error('method unavailable'));
  await tick();
  assert.equal(s(id).promptSuggestion, null);
  state.step(id, 'start', { turnId: 'stopped', human: true });
  finish('stopped', 'interrupted');
  state.step(id, 'start', { turnId: 'automatic', human: false });
  finish('automatic');
  assert.equal(requests.length, 3);
});

test('Codex handles incompatible, isolated, and malformed or mismatched replies', async () => {
  assert.equal(await samplePromptSuggestion({}, 'cx1', 't'), null);
  assert.equal(
    await samplePromptSuggestion({ isolation: { applies: () => true }, request: () => assert.fail('isolated context') }, 'cx1', 't'),
    null,
  );
  for (const value of [null, { sourceTurnId: 'other', text: 'Wrong turn' }, { sourceTurnId: 't', text: [] }])
    assert.equal(await samplePromptSuggestion({ request: async () => value }, 'cx1', 't'), null);
});

test('Claude follow-ups need an eligible idle turn on the current segment', () => {
  const id = 'cl1';
  const { c, state, s } = setup({ ids: [id] });
  const key = c.ref(id).key;
  const offer = (text: unknown, source = key) => c.onClaudeEvent({ key: source, kind: 'promptSuggestion', text });
  const result = { key, kind: 'message', msg: { type: 'result', subtype: 'success' } };
  c.onClaudeEvent(null);
  offer('before a turn');
  state.step(id, 'start', { turnId: 'first', human: true });
  offer('while running');
  assert.equal(s(id).promptSuggestion, null);
  c.rt(id).outstanding = 1;
  c.onClaudeEvent(result);
  offer('another chat', 'claude:other');
  assert.equal(s(id).promptSuggestion, null);
  offer('Continue with the tests.');
  assert.equal(s(id).promptSuggestion, 'Continue with the tests.');
  offer('   ');
  assert.equal(s(id).promptSuggestion, null);
  offer('Try one more test.');
  state.patch(id, { turn: 'idle' });
  assert.equal(s(id).promptSuggestion, 'Try one more test.');
  state.patch(id, { pendingSwitch: { harness: 'codex' } });
  offer('late from Claude');
  assert.equal(s(id).promptSuggestion, null);
  state.patch(id, { pendingSwitch: null });
  c.onClaudeEvent({ key, kind: 'processStarted' });
  offer('from before the restart');
  assert.equal(s(id).promptSuggestion, null);
  state.step(id, 'start', { turnId: 'again', human: true });
  c.rt(id).outstanding = 1;
  c.onClaudeEvent(result);
  offer('Try the new test.');
  c.onClaudeEvent({ key, kind: 'closed' });
  assert.equal(s(id).promptSuggestion, null);
});

test('a delayed Host patch cannot reintroduce a suggestion during Plan, a pending switch, or an external turn', () => {
  for (const hold of [{ plan: true }, { pendingSwitch: { harness: 'claude' } }, { runningElsewhere: true }]) {
    const { state, s } = setup();
    state.patch('cx1', hold);
    state.patch('cx1', { promptSuggestion: 'An obsolete suggestion.' });
    assert.equal(s('cx1').promptSuggestion, null);
  }
});

test('ACP gates suggestions on the prompt reply, even when the reply and update arrive in one read', async () => {
  const id = 'acp1';
  const { c, s } = setup({ ids: [id] });
  const key = c.ref(id).key;
  c.claim(key, id);
  s(id);
  const recorded: unknown[] = [];
  const receipt = { received: false };
  const chat = {
    key,
    prompting: { turnId: 't1', receipt } as { turnId: string; receipt: typeof receipt } | null,
    loading: false,
    isolated: false,
  };
  const host = {
    quirksOf: () => ({}),
    now: () => 100,
    emitEvent: (e: unknown) => c.onAcpEvent(e),
    items: { appendUpdate: (_key: string, entry: unknown) => recorded.push(entry) },
  };
  const update = (suggestions: unknown) => recordSessionUpdate(host, chat, { sessionUpdate: 'prompt_suggestions_update', suggestions });
  c.onAcpEvent({ key, kind: 'turnStart', turnId: 't1', human: true });
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new RpcPeer({
    input,
    output,
    onNotification: (_method: string, params: any) => update(params.suggestions),
  });
  const result = peer.request('session/prompt', { sessionId: 's', prompt: [{ type: 'text', text: 'Check the tests.' }] }, { receipt });
  assert.deepEqual(JSON.parse(output.read().toString()), {
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: 's', prompt: [{ type: 'text', text: 'Check the tests.' }] },
  });
  const suggestions = [
    {
      prompt: [
        { type: 'text', text: 'Open ' },
        { type: 'resource_link', uri: 'file:///test' },
      ],
    },
    {},
    { prompt: [{ type: 'text', text: '  ' }] },
    {
      prompt: [
        { type: 'text', text: 'Run ' },
        { type: 'text', text: 'the tests.' },
      ],
    },
  ];
  const notification = { method: 'session/update', params: { suggestions } };
  input.write(
    [
      { method: 'session/update', params: { suggestions: [{ prompt: [{ type: 'text', text: 'Stale offer' }] }] } },
      { id: 1, result: { stopReason: 'end_turn' } },
      notification,
    ]
      .map((message) => JSON.stringify(message))
      .join('\n') + '\n',
  );
  await result;
  assert.equal(s(id).promptSuggestion, null);
  c.onAcpEvent({ key, kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  chat.prompting = null;
  assert.equal(s(id).promptSuggestion, 'Run the tests.');
  peer.close();
  update(null);
  assert.equal(s(id).promptSuggestion, 'Run the tests.');
  update([]);
  assert.equal(s(id).promptSuggestion, null);
  chat.loading = true;
  update([{ prompt: [{ type: 'text', text: 'Replay' }] }]);
  chat.loading = false;
  chat.isolated = true;
  update([{ prompt: [{ type: 'text', text: 'Isolated' }] }]);
  chat.isolated = false;
  assert.equal(s(id).promptSuggestion, null);
  recordSessionUpdate(host, chat, {
    sessionUpdate: 'session_info_update',
    _meta: { ordinary: true, promptSuggestions: { suggestions: [{ text: '' }, { text: '  Check the diff. ' }] } },
  });
  assert.equal(s(id).promptSuggestion, 'Check the diff.');
  assert.deepEqual((recorded[0] as any).update._meta, { ordinary: true });
  assert.equal(recorded.length, 1);
  recordSessionUpdate(host, chat, {
    sessionUpdate: 'session_info_update',
    _meta: { ordinary: true, promptSuggestions: { suggestions: 'Malformed prediction text' } },
  });
  assert.deepEqual((recorded[1] as any).update._meta, { ordinary: true });
  assert.equal(s(id).promptSuggestion, 'Check the diff.');
  recordSessionUpdate(host, chat, { sessionUpdate: 'session_info_update', _meta: { promptSuggestions: { suggestions: [] } } });
  assert.equal(s(id).promptSuggestion, null);
  update([{ prompt: [{ type: 'text', text: 'Review the changes.' }] }]);
  c.onAcpEvent({ key, kind: 'closed' });
  assert.equal(s(id).promptSuggestion, null);
  chat.prompting = { turnId: 't2', receipt: { received: false } };
  c.onAcpEvent({ key, kind: 'turnStart', turnId: 't2', human: true });
  update([{ prompt: [{ type: 'text', text: 'A prediction sent before the new prompt was accepted' }] }]);
  c.onAcpEvent({ key, kind: 'turnEnd', turnId: 't2', stopReason: 'end_turn' });
  assert.equal(s(id).promptSuggestion, null);
});
