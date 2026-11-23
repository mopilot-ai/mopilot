// bench/lib/transcript.mjs (#1381): a native arm's tokens (in the request ledger's shape, #1316), its setup (permission
// mode, model, effort) and an unanswered question, from the vendor app's own transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chatUsage, findTranscript, readTranscript, transcriptSetup, transcriptTitle, transcriptUsage } = await import(
  '../bench/lib/transcript.mjs'
);
const { usageCost } = await import('../bench/lib/mgb/run.mjs');

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

test('transcriptUsage (Claude Code): each message id once, summed per model, cache and thinking kept apart', () => {
  const usage = (input: number, out: number, read: number, write: number, thinking?: number) => ({
    input_tokens: input,
    output_tokens: out,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
  });
  const text = jsonl([
    { type: 'user', message: { content: 'go' } },
    // one message streamed as two records: the same usage twice, counted once
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: usage(2, 208, 43623, 25484, 0) } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: usage(2, 208, 43623, 25484, 0) } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', usage: usage(3, 71, 69107, 2201, 12) } },
    { type: 'assistant', message: { id: 'm3', model: 'claude-haiku-5-5', usage: usage(10, 5, 0, 0) } },
    // a record without usage, and an assistant record of a model the app made up for an error, without a name
    { type: 'assistant', message: { id: 'm4', content: [] } },
    { type: 'assistant', message: { id: 'm5', usage: { input_tokens: 1, output_tokens: 'n/a' } } },
  ]);
  const u = transcriptUsage('claude', text);
  assert.deepEqual(u, {
    requests: 4,
    tokens: 2 + 208 + 43623 + 25484 + 3 + 71 + 69107 + 2201 + 15 + 1,
    byModel: {
      'claude-sonnet-5-5': { in: 5, out: 279, cacheRead: 112730, cacheWrite: 27685, reasoning: 12 },
      'claude-haiku-5-5': { in: 10, out: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      '?': { in: 1, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    },
  });
  // priced like a ledger usage: a model with no price makes the cost unknown, never free
  assert.equal(usageCost(u, { 'claude-sonnet-5-5': { in: 3, out: 15 }, 'claude-haiku-5-5': { in: 1, out: 5 } }), null);
});

test('transcriptUsage (Codex): the running total, cached input out of `in`, one request per rise', () => {
  const total = (input: number, cached: number, out: number, reasoning: number, write?: number) => ({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: out,
          reasoning_output_tokens: reasoning,
          ...(write === undefined ? {} : { cache_write_input_tokens: write }),
          total_tokens: input + out,
        },
      },
    },
  });
  const text = jsonl([
    { type: 'session_meta', payload: {} },
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    total(30903, 22912, 75, 0, 0),
    // a rate-limit update repeats the same total: not another request
    total(30903, 22912, 75, 0, 0),
    total(67994, 53632, 127, 0, 0),
    { type: 'turn_context', payload: {} },
    total(1221237, 1144448, 3782, 1757, 0),
  ]);
  assert.deepEqual(transcriptUsage('codex', text), {
    requests: 3,
    tokens: 1221237 - 1144448 + 3782 + 1144448,
    byModel: { 'gpt-6-luna': { in: 76789, out: 3782, cacheRead: 1144448, cacheWrite: 0, reasoning: 1757 } },
  });
  // no cached count and no model name: all input is uncached, under the unknown model
  assert.deepEqual(
    transcriptUsage(
      'codex',
      jsonl([
        {
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } } },
        },
      ]),
    )?.byModel,
    { '?': { in: 9, out: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
  );
});

test('transcriptUsage: a transcript with no usage is unknown (null), never zero', () => {
  assert.equal(transcriptUsage('claude', jsonl([{ type: 'user', message: { content: 'x' } }])), null);
  assert.equal(transcriptUsage('codex', jsonl([{ type: 'turn_context', payload: { model: 'gpt-6-luna' } }])), null);
  assert.equal(transcriptUsage('codex', ''), null);
});

test('transcriptSetup: the permission mode, served model and effort the app actually ran with', () => {
  const claude = jsonl([
    { type: 'user', permissionMode: 'default', message: { content: 'go' } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } },
    { type: 'user', permissionMode: 'auto', message: { content: 'next' } },
    // the app's own message for an interruption names no served model
    { type: 'assistant', message: { model: '<synthetic>', content: [] } },
    { type: 'assistant', message: { content: [] } },
    { type: 'turn_context', payload: { model: 'ignored for Claude' } },
  ]);
  assert.deepEqual(transcriptSetup('claude', claude), { permission: 'auto', model: 'claude-sonnet-5-5', effort: null });
  const codex = jsonl([
    {
      type: 'turn_context',
      payload: { approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-6-luna', effort: 'low' },
    },
    { type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } },
    { type: 'turn_context' },
    { type: 'event_msg', permissionMode: 'ignored for Codex', payload: {} },
  ]);
  assert.deepEqual(transcriptSetup('codex', codex), { permission: 'never/danger-full-access', model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(
    transcriptSetup('codex', jsonl([{ type: 'turn_context', payload: { approval_policy: 'never' } }])).permission,
    'never/?',
  );
  assert.deepEqual(transcriptSetup('claude', ''), { permission: null, model: null, effort: null });
});

test('readTranscript (Claude Code): an AskUserQuestion still waiting for its answer is the turn ending by asking', () => {
  const asked = (input: unknown, name = 'AskUserQuestion') => ({
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Attaching' },
        { type: 'tool_use', name, input },
      ],
    },
  });
  const go = { type: 'user', message: { content: 'go' } };
  const q = { questions: [{ question: 'The built-in browser cannot open a file chooser. How should I proceed?' }] };
  const r = readTranscript('claude', jsonl([go, asked(q)]));
  assert.deepEqual([r.done, r.question], [false, 'The built-in browser cannot open a file chooser. How should I proceed?']);
  // an MCP-prefixed tool and the older single-question input; a call without either still names that it asked
  assert.equal(readTranscript('claude', jsonl([go, asked({ question: 'Which one?' }, 'mcp__ui__AskUserQuestion')])).question, 'Which one?');
  assert.equal(readTranscript('claude', jsonl([go, asked({})])).question, 'a question');
  // answered (or rejected) questions and other tool calls are not waiting
  const answered = { type: 'user', message: { content: [{ type: 'tool_result', content: 'Use Chrome' }] } };
  assert.equal(readTranscript('claude', jsonl([go, asked(q), answered])).question, null);
  assert.equal(readTranscript('claude', jsonl([go, asked({ command: 'ls' }, 'Bash')])).question, null);
  assert.equal(readTranscript('claude', jsonl([go, { type: 'assistant', message: { content: 'plain' } }])).question, null);
  // Codex rollouts end their turn to ask instead
  assert.equal(readTranscript('codex', '').question, null);
});

test('readTranscript (Claude Code): a turn that ends on its wrap-up box is done, with the recap as the answer', () => {
  const go = { type: 'user', message: { content: 'go' } };
  const wrap = (input: unknown) => ({
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Filled steps 1-3.' },
        { type: 'tool_use', id: 'w1', name: 'mcp__ccd_turn__wrap_up', input },
      ],
    },
  });
  const shown = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Shown in the box.' }] },
    mcpMeta: { _meta: { 'claude/endTurn': true } },
  };
  const r = readTranscript('claude', jsonl([go, wrap({ recap: 'Steps 1-3 are filled in; step 4 is not done.' }), shown]));
  assert.deepEqual([r.done, r.answer, r.steps], [true, 'Steps 1-3 are filled in; step 4 is not done.', 1]);
  // a box with no recap keeps the last text; before the box is shown the turn is still running
  assert.equal(readTranscript('claude', jsonl([go, wrap({}), shown])).answer, 'Filled steps 1-3.');
  assert.equal(readTranscript('claude', jsonl([go, wrap({ recap: 'x' })])).done, false);
  // a recap alone draws no box and does not end the turn: its closing message is still to come
  const recapOnly = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'No box.' }] } };
  assert.equal(readTranscript('claude', jsonl([go, wrap({ recap: 'x' }), recapOnly])).done, false);
  // another tool's result, or a result for an unknown call, is not the end
  const other = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } };
  const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } };
  assert.equal(readTranscript('claude', jsonl([go, bash, other])).done, false);
  assert.equal(readTranscript('claude', jsonl([go, { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } }])).done, false);
});

test('readTranscript (Claude Code): the call a turn is waiting on, for the driver to answer an approval card', () => {
  const go = { type: 'user', message: { content: 'go' } };
  const call = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
  const access = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Need TextEdit' }, call('a1', 'mcp__computer-use__request_access')] },
  };
  assert.deepEqual(readTranscript('claude', jsonl([go, access])).pending, { id: 'a1', name: 'mcp__computer-use__request_access' });
  // the last of several calls in one message is the one still open
  const two = { type: 'assistant', message: { content: [call('b1', 'Read'), call('b2', 'Bash')] } };
  assert.deepEqual(readTranscript('claude', jsonl([go, two])).pending, { id: 'b2', name: 'Bash' });
  // answered, or a message with no call: nothing is pending
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'granted' }] } };
  assert.equal(readTranscript('claude', jsonl([go, access, result])).pending, null);
  assert.equal(
    readTranscript('claude', jsonl([go, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }])).pending,
    null,
  );
});

test("readTranscript: prompts counts the chat's messages, so a next message is read only once it has landed", () => {
  const ended = [
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done 1' }] } },
  ];
  // the app writes its own records before the next message: still one prompt, and the old end still reads done
  const housekeeping = [
    { type: 'custom-title', customTitle: 'x' },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
  ];
  const before = readTranscript('claude', jsonl([...ended, ...housekeeping]));
  assert.deepEqual([before.prompts, before.done], [1, true]);
  // tool results are not prompts; a typed message (string or text blocks) is
  const toolResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x' }] }] },
  };
  const typed = { type: 'user', message: { content: [{ type: 'text', text: 'second' }] } };
  const after = readTranscript('claude', jsonl([...ended, toolResult, typed]));
  assert.deepEqual([after.prompts, after.done], [2, false]);
  // Codex: each turn start is a message
  const codex = jsonl([
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'event_msg', payload: { type: 'turn_started' } },
  ]);
  assert.deepEqual([readTranscript('codex', codex).prompts, readTranscript('codex', codex).done], [2, false]);
});

test("chatUsage: a chat moved to a new file adds that file's count, per model; no usage at all is null", () => {
  const total = (input: number, out: number) =>
    jsonl([
      { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: out, total_tokens: input + out } },
        },
      },
    ]);
  assert.deepEqual(chatUsage('codex', [total(100, 10), total(50, 5), '']), {
    requests: 2,
    tokens: 165,
    byModel: { 'gpt-6-luna': { in: 150, out: 15, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
  });
  assert.equal(chatUsage('codex', ['', '']), null);
  assert.equal(chatUsage('claude', []), null);
});

test('findTranscript: a chat moved to a new rollout is read from the newest file holding its tag', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'mgb-tr-'));
  const dir = path.join(home, '.codex/sessions/2026/10/18');
  mkdirSync(dir, { recursive: true });
  const first = path.join(dir, 'rollout-1.jsonl');
  const moved = path.join(dir, 'rollout-2.jsonl');
  writeFileSync(first, 'tag-9 first message');
  writeFileSync(moved, 'tag-9 later message');
  utimesSync(first, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(findTranscript('codex', home, 'tag-9'), moved);
  // the older one is newest again once the new one ages past the hour
  utimesSync(moved, new Date(0), new Date(0));
  assert.equal(findTranscript('codex', home, 'tag-9'), first);
});

test('transcriptTitle: the last title the app gave the chat, or null', () => {
  const t = jsonl([
    { type: 'user', message: { content: 'go' } },
    { type: 'custom-title', customTitle: 'Invoice reconciliation' },
    { type: 'custom-title', customTitle: '' },
    { type: 'custom-title', customTitle: 'Foxglove Outfitters invoice reconciliation' },
    { type: 'agent-name', agentName: 'not a title' },
  ]);
  assert.equal(transcriptTitle(t), 'Foxglove Outfitters invoice reconciliation');
  assert.equal(transcriptTitle(jsonl([{ type: 'user', message: { content: 'x' } }])), null);
});

// A parallel call's sibling can answer first: the person-waiting card is still open though the last record is a result.
const rec = (type: string, content: unknown[], extra: object = {}) => JSON.stringify({ type, message: { role: type, content, ...extra } });
const call = (id: string, name: string, input: object = {}) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content });
const read = (...lines: string[]) => readTranscript('claude', lines.join('\n'));

test('readTranscript: an access card stays pending beside a parallel call, in either result order', () => {
  const prompt = rec('user', [{ type: 'text', text: 'go' }]);
  const calls = rec('assistant', [call('b1', 'Bash'), call('c1', 'mcp__computer-use__request_access')]);
  // the sibling's result arrives first: the last record is a user record, the card is still open
  assert.deepEqual(read(prompt, calls, rec('user', [result('b1', 'ok')])).pending, { id: 'c1', name: 'mcp__computer-use__request_access' });
  // the card is answered first: the Bash call is the open one
  assert.deepEqual(read(prompt, calls, rec('user', [result('c1', 'granted')])).pending, { id: 'b1', name: 'Bash' });
  // both answered: nothing pending
  const both = read(prompt, calls, rec('user', [result('b1', 'ok'), result('c1', 'granted')]));
  assert.equal(both.pending, null);
  assert.deepEqual(both.denials, []);
  // both open: the card that waits on a person wins over the newer call
  const wide = rec('assistant', [call('c2', 'mcp__computer-use__request_access'), call('b2', 'Bash')]);
  assert.equal(read(prompt, wide).pending?.id, 'c2');
});

test('readTranscript: a question beside a parallel call is still read, and a denied access card is listed', () => {
  const prompt = rec('user', [{ type: 'text', text: 'go' }]);
  const asked = rec('assistant', [call('q1', 'AskUserQuestion', { question: 'which?' }), call('b1', 'Bash')]);
  assert.equal(read(prompt, asked, rec('user', [result('b1', 'ok')])).question, 'which?');
  const card = rec('assistant', [call('c1', 'mcp__computer-use__request_access')]);
  const denied = read(prompt, card, rec('user', [result('c1', [{ type: 'text', text: 'user_denied' }])]));
  assert.deepEqual(denied.denials, ['c1']);
  // a granted result carries an empty denied list: not a denial (the false positive that made granted runs ungradable)
  const granted = '{"granted":[{"bundleId":"com.apple.iCal"}],"denied":[],"screenshotFiltering":"native"}';
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', granted)])).denials, []);
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', [{ type: 'text', text: granted }])])).denials, []);
  // a denied list with an app, as JSON or as text around it, is one
  const partly = '{"granted":[],"denied":[{"bundleId":"com.apple.TextEdit","reason":"user_denied"}]}';
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', partly)])).denials, ['c1']);
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', `Access: ${partly}`)])).denials, ['c1']);
  // a string result, another tool's mention of "denied" and a non-text result are not denials
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', 'Granted')])).denials, []);
  const bash = rec('assistant', [call('b9', 'Bash')]);
  assert.deepEqual(read(prompt, bash, rec('user', [result('b9', 'permission denied')])).denials, []);
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', { odd: true })])).denials, []);
  assert.deepEqual(read(prompt, card, rec('user', [result('c1', [{ type: 'image' }])])).denials, []);
});
