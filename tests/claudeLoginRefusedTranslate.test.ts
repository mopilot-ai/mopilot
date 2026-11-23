// A login the provider refuses for its organization (#4908, core/crates/translate/src/claude/failures.rs): the CLI's own reply (`error: oauth_org_not_allowed`) is the turn's failure, once, as a lapsed login's is; it is not also a reply of the assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk } from './support/claude-translator-kit.ts';

const SAID =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

test('the provider’s refusal of the login ends the turn with its sentence as the error and leaves no reply beside it', () => {
  const { tr, events, items } = mk();
  tr.onMessage({
    type: 'assistant',
    error: 'oauth_org_not_allowed',
    message: { model: '<synthetic>', content: [{ type: 'text', text: SAID }] },
  });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true, result: SAID });
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, SAID);
  assert.deepEqual(
    items('item/completed').filter((i) => i.type === 'agentMessage'),
    [],
    'the sentence is the error, not a reply too',
  );
});

test('an error word the translator does not know stays an ordinary reply, and a refusal with no words says so plainly', () => {
  const other = mk();
  other.tr.onMessage({
    type: 'assistant',
    error: 'something_else',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Odd failure' }] },
  });
  assert.deepEqual(
    other
      .items('item/completed')
      .filter((i) => i.type === 'agentMessage')
      .map((i) => i.text),
    ['Odd failure'],
  );
  const bare = mk();
  bare.tr.onMessage({ type: 'assistant', error: 'oauth_org_not_allowed', message: {} });
  bare.tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  assert.equal(bare.events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Failed to authenticate');
});
