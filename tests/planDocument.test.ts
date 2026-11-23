// Proposal discovery uses the same native items, approval enrichment and plain-message rules as plan cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDocument, pendingPlan, planReply } from '../src/store/plans/document.ts';
import type { TurnState } from '../src/store/types';

const turn = (id: string, items: unknown[], extra = {}): TurnState => ({ id, items, status: 'completed', ...extra }) as TurnState;
const plan = (id: string, text?: string) => ({ id, type: 'plan', text });
const approval = (id: string, input: unknown) =>
  ({ method: 'claude/permission', params: { toolName: 'ExitPlanMode', toolUseID: id, input } }) as any;

test('empty history and task progress alone have no proposal', () => {
  assert.equal(planDocument([], []), null);
  assert.equal(planDocument([turn('t', [], { plan: { steps: [{ step: 'Work', status: 'pending' }] } })], []), null);
  assert.equal(
    planReply([turn('t', [{ type: 'agentMessage', id: 'q', text: 'Choose an option', questions: [{ question: 'Which?' }] }])]),
    null,
  );
});

test('the latest proposal is current; an explicit proposal still reads its exact historical item', () => {
  const turns = [turn('t1', [plan('p1', 'First'), plan('p2', 'Second')]), turn('t2', [plan('p3', 'Latest')])];
  assert.deepEqual(planDocument(turns, []), { id: 'p3', turnId: 't2', text: 'Latest', path: undefined, streaming: false });
  assert.equal(planDocument(turns, [], { turnId: 't1', itemId: 'p1' })?.text, 'First');
  assert.equal(planDocument(turns, [], { turnId: 't1', itemId: 'gone' }), null);
});

test('a pending approval enriches only its own plan, until the tool provides authoritative text', () => {
  const asks = [approval('p', { plan: '# Pending', planFilePath: '/plan.md' })];
  const turns = [turn('t', [plan('p')], { status: 'inProgress' })];
  assert.deepEqual(planDocument(turns, asks, undefined, 't'), {
    id: 'p',
    turnId: 't',
    text: '# Pending',
    path: '/plan.md',
    streaming: true,
  });
  assert.equal(planDocument(turns, [approval('other', { plan: 'Wrong' })], undefined, 't')?.text, '');
  const own = { id: 'p', text: 'Tool text', planFilePath: '/own.md' };
  assert.equal(pendingPlan(own, asks), own);
  assert.deepEqual(pendingPlan({ id: 'p', planFilePath: '/own.md' }, asks), { id: 'p', text: '# Pending', planFilePath: '/own.md' });
});

test('plain-message plans are readable after completion; running messages and review outcomes are not proposals', () => {
  const items = [{ id: 'm', type: 'agentMessage', text: 'A plain proposal' }];
  assert.equal(planDocument([turn('t', items, { planMode: true })], [])?.id, 'm');
  assert.equal(planDocument([turn('t', items, { planMode: true, status: 'inProgress' })], []), null);
  assert.equal(
    planDocument([turn('t', [...items, { id: 'r', type: 'exitedReviewMode', review: 'Review' }], { planMode: true })], []),
    null,
  );
  assert.equal(planDocument([turn('t', items)], []), null);
});

test('opaque item ids are namespaced by turn across mixed native segments', () => {
  const turns = [turn('old', [plan('p', 'Original')]), turn('new', [plan('p', 'New')])];
  assert.equal(planDocument(turns, [], { turnId: 'old', itemId: 'p' })?.text, 'Original');
  assert.equal(planDocument(turns, [], { turnId: 'new', itemId: 'p' })?.text, 'New');
});

test('real ACP transcript output is available only through an explicit reply selection', async () => {
  const { buildAcpTurns } = await import('../electron/harness/items/acpTranslator.cjs');
  const turns = buildAcpTurns(
    [
      { t: 'user', turnId: 't', at: 1, user: { id: 'u', content: [{ type: 'text', text: 'Propose a plan', text_elements: [] }] } },
      {
        t: 'update',
        turnId: 't',
        at: 2,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '1. Review the code.\n2. Add tests.' } },
      },
      { t: 'end', turnId: 't', at: 3, stopReason: 'end_turn' },
    ] as any,
    'acp:agent:native',
    '/repo',
  ) as TurnState[];
  assert.equal(planDocument(turns, []), null);
  const reply = planReply(turns)!;
  assert.match(reply.text, /Add tests/);
  assert.equal(planDocument(turns, [], { turnId: reply.turnId, itemId: reply.id, source: 'reply' })?.text, reply.text);
  assert.equal(planDocument(turns, [], { turnId: reply.turnId, itemId: 'gone', source: 'reply' }), null);
  assert.equal(planReply([turn('running', [{ type: 'agentMessage', id: 'm', text: 'Still working' }], { status: 'inProgress' })]), null);
  assert.equal(planReply([turn('empty', [{ type: 'agentMessage', id: 'm', text: '', questions: null }])]), null);
});

test('historical empty plans never adopt a newer turn’s pending approval with the same item id', () => {
  const turns = [turn('old', [plan('p')]), turn('new', [plan('p')], { status: 'inProgress' })];
  const asks = [approval('p', { plan: 'Current proposal' })];
  assert.equal(planDocument(turns, asks, { turnId: 'old', itemId: 'p' }, 'new')?.text, '');
  assert.equal(planDocument(turns, asks, { turnId: 'new', itemId: 'p' }, 'new')?.text, 'Current proposal');
});
