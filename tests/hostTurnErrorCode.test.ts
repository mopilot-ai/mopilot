// A failed turn's typed code (#4278, shared/host/turnErrorCode.mjs): the harness's own signal where it gives one (Codex's codexErrorInfo through host/src/codexStream.mjs, Claude Code's assistant error through host/src/claudeAcp.mjs and turnBridge.mjs), else its words; only a failure has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAcp } from '../host/src/claudeAcp.mjs';
import { createCodexStream } from '../host/src/codexStream.mjs';
import { TURN_ERROR_CODES, codeOfText, ledAs, turnErrorCode, typedTurnEnd } from '../shared/host/turnErrorCode.mjs';

test('A: a harness signal names the code whatever the words are; an unknown signal leaves it to the words', () => {
  for (const [signal, code] of [
    ['usageLimitExceeded', 'rate_limit'],
    ['rateLimitExceeded', 'rate_limit'],
    ['sessionBudgetExceeded', 'rate_limit'],
    ['unauthorized', 'auth'],
    ['contextWindowExceeded', 'context'],
    ['serverOverloaded', 'model_unavailable'],
    ['flexUnavailable', 'model_unavailable'],
    ['rate_limit', 'rate_limit'],
    ['authentication_failed', 'auth'],
  ] as const) {
    assert.equal(turnErrorCode(signal, 'something else entirely'), code, signal);
    assert.ok(TURN_ERROR_CODES.includes(code));
  }
  // Codex's object form: its one key is the word
  assert.equal(turnErrorCode({ responseStreamConnectionFailed: { httpStatusCode: 502 } }, 'stream failed'), undefined);
  // and the HTTP status it carries says too many requests or unauthorized whatever the words are
  assert.equal(turnErrorCode({ responseStreamConnectionFailed: { httpStatusCode: 429 } }, 'stream failed'), 'rate_limit');
  assert.equal(turnErrorCode({ httpConnectionFailed: { httpStatusCode: 401 } }, 'stream failed'), 'auth');
  assert.equal(turnErrorCode({ httpConnectionFailed: { httpStatusCode: null } }, 'stream failed'), undefined);
  assert.equal(turnErrorCode({}, 'stream failed'), undefined);
  assert.equal(turnErrorCode('other', 'boom'), undefined);
  assert.equal(turnErrorCode(null, undefined), undefined);
  assert.equal(turnErrorCode(7, 'not logged in'), 'auth');
});

test('B: the words alone: limit, sign-in, context and model, in that order, and anything else has no code', () => {
  for (const [text, code] of [
    ['You have hit your usage limit', 'rate_limit'],
    ['429 Too Many Requests', 'rate_limit'],
    ['Authentication required', 'auth'],
    ['Invalid API key · Please run /login', 'auth'],
    ['OAuth token has expired', 'auth'],
    ['API Error: 401 {"type":"error","error":{"message":"Unauthorized"}}', 'auth'],
    ['Prompt is too long', 'context'],
    ['This request exceeds the maximum context length', 'context'],
    ["The model 'gpt-9' does not exist or you do not have access", 'model_unavailable'],
    ['model_not_found', 'model_unavailable'],
    // Claude Code's own words for a model it cannot use, as a real Host said them
    ["There's an issue with the selected model (opus-9). It may not exist or you may not have access to it.", 'model_unavailable'],
    // Codex's, for the same
    [
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-9\' model is not supported"}}',
      'model_unavailable',
    ],
    ['Overloaded', 'model_unavailable'],
    ['the model fell over', undefined],
    // the word alone, somewhere in other words, is not the model's
    ['The disk is overloaded with files', undefined],
    ['', undefined],
  ] as const)
    assert.equal(turnErrorCode(undefined, text), code, text);
});

test('A: only a failed end gets a code; an adapter’s code is kept, a foreign one is replaced by what the words say, a Stop and a clean end are as they were', () => {
  const end = (extra: object): any => ({ kind: 'turnEnd', turnId: 't', ...extra });
  assert.deepEqual(typedTurnEnd(end({ stopReason: 'error', error: { message: 'usage limit reached' } })).error, {
    message: 'usage limit reached',
    code: 'rate_limit',
  });
  assert.deepEqual(typedTurnEnd(end({ stopReason: 'error', error: { message: 'boom', code: 'auth' } })).error, {
    message: 'boom',
    code: 'auth',
  });
  assert.deepEqual(typedTurnEnd(end({ stopReason: 'error', error: { message: 'boom', code: 'made_up' } })).error, { message: 'boom' });
  assert.deepEqual(typedTurnEnd(end({ stopReason: 'error', error: 'not logged in' })).error, { message: 'not logged in', code: 'auth' });
  for (const same of [
    end({ stopReason: 'cancelled', error: { message: 'usage limit reached' } }),
    end({ stopReason: 'end_turn' }),
    end({ stopReason: 'error' }),
  ])
    assert.equal(typedTurnEnd(same), same);
});

test('I: Codex: a failed turn carries the code of its codexErrorInfo, or of its words; a turn that did not fail carries none', () => {
  const events: any[] = [];
  const stream = createCodexStream({ emit: (e: any) => events.push(e), chatOf: () => 'chat' } as any);
  const fail = (id: string, error?: object) => {
    stream.started('chat', id);
    stream.notification({
      method: 'turn/completed',
      params: { threadId: 'th', turn: { id, status: 'failed', ...(error ? { error } : {}) } },
    });
    return events.at(-1).error;
  };
  assert.deepEqual(fail('a', { message: 'Out of budget for now', codexErrorInfo: 'usageLimitExceeded' }), {
    message: 'Out of budget for now',
    code: 'rate_limit',
  });
  assert.deepEqual(fail('b', { message: 'Sign in again', codexErrorInfo: 'unauthorized' }), { message: 'Sign in again', code: 'auth' });
  assert.deepEqual(fail('c', { message: 'boom', codexErrorInfo: 'other' }), { message: 'boom' });
  assert.deepEqual(fail('d', { message: 'Your input exceeds the context window of this model' }), {
    message: 'Your input exceeds the context window of this model',
    code: 'context',
  });
  assert.deepEqual(fail('e'), { message: 'The turn failed.' });
  stream.started('chat', 'f');
  stream.notification({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'f', status: 'completed' } } });
  assert.equal(events.at(-1).error, undefined);
});

test('I: Claude Code: the last assistant message’s own error is the signal of a failed result, and of nothing else', () => {
  const said = (messages: object[]) => {
    const acp = createClaudeAcp();
    for (const m of messages) acp.message(m);
    return acp.summary();
  };
  const failed = { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'It did not work.' };
  assert.equal(said([{ type: 'assistant', error: 'rate_limit', message: { content: [] } }, failed]).signal, 'rate_limit');
  assert.equal(
    said([{ type: 'assistant', error: 'authentication_failed', message: { content: [] } }, failed]).signal,
    'authentication_failed',
  );
  // a later message that failed for nothing replaces an earlier one's word; a turn that succeeded has none
  assert.equal(
    said([{ type: 'assistant', error: 'rate_limit', message: { content: [] } }, { type: 'assistant', message: { content: [] } }, failed])
      .signal,
    null,
  );
  assert.equal(
    said([
      { type: 'assistant', error: 'rate_limit', message: { content: [] } },
      { type: 'result', subtype: 'success' },
    ]).signal,
    null,
  );
});

test('#4278: a reader with only the text reaches the Host’s code: a lead wins over whatever the rest of the words would say', () => {
  // words that already read as the code are left as they are
  assert.equal(ledAs('You have hit your usage limit', 'rate_limit'), 'You have hit your usage limit');
  assert.equal(ledAs('boom', undefined), 'boom');
  // every code, over words that say nothing and over words that read as each other code
  const words = ['Try again later.', 'too many requests, retry', 'please run /login', 'Prompt is too long', 'Overloaded'];
  for (const code of TURN_ERROR_CODES)
    for (const text of words) assert.equal(codeOfText(ledAs(text, code)), code, `${code} over “${text}”`);
  assert.equal(
    ledAs('Overloaded: too many requests, retry', 'model_unavailable'),
    'Model unavailable: Overloaded: too many requests, retry',
  );
  // text nobody led is read by its words; text that is no text has no code
  assert.equal(codeOfText('Authentication required'), 'auth');
  assert.equal(codeOfText('boom'), undefined);
  assert.equal(codeOfText(null), undefined);
});

test('#4908: a provider that refuses the stored login for its organization is an auth failure, by the CLI’s own word and by its sentence', () => {
  // what Claude Code recorded on a machine whose login the provider refused (HTTP 403, `oauth_not_allowed_for_organization`)
  assert.equal(turnErrorCode('oauth_org_not_allowed', 'unrelated words'), 'auth');
  const sentence =
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
  assert.equal(turnErrorCode(undefined, sentence), 'auth');
  assert.equal(codeOfText(sentence), 'auth');
  assert.equal(
    turnErrorCode(undefined, 'API Error: 403 {"error":{"type":"permission_error","code":"oauth_not_allowed_for_organization"}}'),
    'auth',
  );
  // the same words do not turn other failures into an auth failure
  assert.equal(turnErrorCode(undefined, 'Your organization has disabled web search for this chat'), undefined);
  assert.equal((typedTurnEnd({ stopReason: 'error', error: { message: sentence } }) as any).error.code, 'auth');
});
