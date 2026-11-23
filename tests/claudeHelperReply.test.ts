// A one-shot Claude Code helper (a chat's title, a harness-switch note) never keeps the CLI's own error reply as its answer:
// at the monthly spend limit the CLI answers with a synthetic assistant message, which used to become the chat's title (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { helperReply } = require('../electron/harness/claude/helperReply.cjs');
const { createQueries } = require('../electron/harness/claude/queries.cjs');
const { readUsage } = require('../electron/harness/claude/usage.cjs');

const LIMIT = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message";

const stream = (...messages: any[]) =>
  (async function* () {
    yield* messages;
  })();
const said = (text: string, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
const limited = (text = LIMIT) => said(text, { error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });

test('a helper reply is the assistant text, joined, up to the result', async () => {
  assert.equal(
    await helperReply(stream(said('A short '), said('title'), { type: 'result', subtype: 'success' }, said('after'))),
    'A short title',
  );
  // no subtype: a plain end of the stream
  assert.equal(await helperReply(stream(said(' note '), { type: 'result' })), 'note');
  assert.equal(await helperReply(stream()), '');
});

test('the CLI’s synthetic error reply is a failure, not the answer', async () => {
  await assert.rejects(helperReply(stream(limited(), { type: 'result', subtype: 'success' })), { message: LIMIT });
  // a reply typed only by its model, and one with no text at all
  await assert.rejects(helperReply(stream(said(LIMIT, { message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] } }))), {
    message: LIMIT,
  });
  await assert.rejects(helperReply(stream({ type: 'assistant', error: 'billing_error', message: { content: [] } })), {
    message: 'billing_error',
  });
  await assert.rejects(helperReply(stream({ type: 'assistant', error: true, message: { content: [] } })), { message: 'true' });
  await assert.rejects(helperReply(stream({ type: 'assistant', message: { model: '<synthetic>', content: [] } })), {
    message: 'Claude Code could not answer',
  });
});

test('a failed result is a failure with its errors, else its text, else its subtype', async () => {
  await assert.rejects(
    helperReply(stream(said('x'), { type: 'result', subtype: 'error_during_execution', errors: ['boom', '[ede_diagnostic] a'] })),
    {
      message: 'boom',
    },
  );
  await assert.rejects(helperReply(stream({ type: 'result', subtype: 'success', is_error: true, result: LIMIT })), { message: LIMIT });
  await assert.rejects(helperReply(stream({ type: 'result', subtype: 'error_max_turns' })), { message: 'error_max_turns' });
  // a result whose only errors are the CLI's diagnostics is not a failure
  assert.equal(
    await helperReply(stream(said('ok'), { type: 'result', subtype: 'error_during_execution', errors: ['[ede_diagnostic] a'] })),
    'ok',
  );
});

/** The Claude queries over a fake SDK that answers every query with `messages`. */
function queriesAnswering(...messages: any[]) {
  const state: any = { sdk: async () => ({ query: () => stream(...messages) }) };
  return createQueries(state, { auth: { cleanEnv: () => ({ PATH: '/bin' }) }, cli: { findBinary: async () => '/bin/claude' } });
}

test('a chat title at the spend limit throws, so the chat keeps its provisional title', async () => {
  const ok = queriesAnswering(said('Fix login bug'), { type: 'result' });
  assert.equal(await ok.title('fix the login bug', '/tmp', null, undefined, 'c1'), 'Fix login bug');
  const empty = queriesAnswering({ type: 'result' });
  assert.equal(await empty.title('fix', '/tmp', null, undefined, 'c1'), null);
  const full = queriesAnswering(limited(), { type: 'result', subtype: 'success' });
  await assert.rejects(full.title('fix the login bug', '/tmp', null, undefined, 'c1'), { message: LIMIT });
});

test("a warm title CLI that fails leaves the title to the chat's own CLI: null, never a rejection", async () => {
  const state: any = {
    sdk: async () => ({
      query: () =>
        Object.assign(stream(), {
          generateSessionTitle: async () => {
            throw new Error(LIMIT);
          },
        }),
    }),
  };
  const q = createQueries(state, { auth: { cleanEnv: () => ({ PATH: '/bin' }) }, cli: { findBinary: async () => '/bin/claude' } });
  assert.equal(await q.title('fix the login bug', '/tmp', null, undefined, 'c1', { helper: true }), null);
  state.titleHelper.closeAll();
});

test('with no Claude Code installed the warm title CLI starts nothing and answers null', async () => {
  let started = 0;
  const state: any = { sdk: async () => ({ query: () => (started++, stream()) }) };
  const q = createQueries(state, { auth: { cleanEnv: () => ({ PATH: '/bin' }) }, cli: { findBinary: async () => null } });
  assert.equal(await q.title('fix the login bug', '/tmp', null, undefined, 'c1', { helper: true }), null);
  assert.equal(started, 0);
});

test('a harness-switch summary at the spend limit fails instead of handing the error over as the note', async () => {
  const ok = queriesAnswering(said('The note'), { type: 'result' });
  assert.equal(await ok.summarize('s1', '/tmp', 'summarize', null, undefined, 'c1'), 'The note');
  const full = queriesAnswering(limited(), { type: 'result', subtype: 'success' });
  await assert.rejects(full.summarize('s1', '/tmp', 'summarize', null, undefined, 'c1'), { message: LIMIT });
});

test('the usage reader skips the CLI’s error reply, so it is no usage text', async () => {
  const sdk =
    (...messages: any[]) =>
    async () => ({ query: () => Object.assign(stream(...messages), { close() {} }) });
  assert.equal(await readUsage(sdk(said('Current week: 40%'), { type: 'result', result: '' }), {}), 'Current week: 40%');
  assert.equal(await readUsage(sdk(limited(), { type: 'result', result: '' }), {}), '');
});
