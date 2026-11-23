// Native assistant authentication, goal and review messages keep their public translated outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, use } from './support/claude-translator-kit.ts';
const asst = (content: any[], extra: any = {}) => ({
  type: 'assistant',
  uuid: extra.uuid,
  message: { id: extra.id ?? 'm1', content, model: extra.model },
  ...extra,
});

test('assistant messages: authentication failures, goal notes and synthetic review findings', () => {
  const { tr, events, items } = mk();
  tr.onMessage({
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Please log in' }, { type: 'x' }] },
  });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Please log in');
  tr.onMessage({ type: 'assistant', error: 'authentication_failed', message: {} });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Failed to authenticate');
  tr.onMessage({ type: 'assistant', error: 'authentication_failed' });
  // the provider's organization refusal ends the turn the same way, with its sentence or the default one
  tr.onMessage({
    type: 'assistant',
    error: 'oauth_org_not_allowed',
    message: { content: [{ type: 'text', text: 'Your organization does not allow this login' }] },
  });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Your organization does not allow this login');
  tr.onMessage({ type: 'assistant', error: 'oauth_org_not_allowed', message: {} });
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Failed to authenticate');
  tr.onMessage(asst([{ type: 'text', text: 'Goal set: ship it' }]));
  tr.onMessage(asst([{ type: 'text', text: 'Goal set: again' }], { uuid: 'gu' }));
  assert.deepEqual(
    items('item/completed').map((i) => [i.type, i.text]),
    [
      ['statusNote', 'Goal set: ship it'],
      ['statusNote', 'Goal set: again'],
    ],
  );
  assert.equal(items('item/completed')[1].id, 'gu');
  const rv = mk();
  rv.tr.beginTurn('r', { id: 'u', clientId: null, content: [{ type: 'text', text: '/review' }] });
  rv.tr.onMessage(asst([{ type: 'text', text: 'Finding 1' }, use('Bash', {}, 'zz')], { model: '<synthetic>' }));
  rv.tr.onMessage(asst([{ type: 'text', text: 'Finding 2' }], { model: '<synthetic>', uuid: 'rv' }));
  rv.tr.onMessage({ type: 'assistant', message: { model: '<synthetic>' } });
  rv.tr.onMessage(asst([{ type: 'text', text: '  ' }], { model: '<synthetic>', id: 'm5' }));
  const reviews = rv.items('item/completed').filter((i) => i.type === 'exitedReviewMode');
  assert.deepEqual(
    reviews.map((r) => r.review),
    ['Finding 1', 'Finding 2'],
  );
  assert.match(reviews[0].id, /^review-/);
  assert.equal(reviews[1].id, 'rv');
  assert.equal(rv.items('item/completed').at(-1).type, 'agentMessage');
  assert.equal(events[0][0], 'turn/started');
});
