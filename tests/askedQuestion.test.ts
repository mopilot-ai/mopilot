// A question asked from Quick Chat, as Quick Chat's view of MoMo's chat shows it (src/components/momo/askedQuestion.ts,
// #2288): its own copy at once, in a finished turn of its own after the chat's turns; gone when taken back; and found
// held once another turn of the chat has it, so it shows once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { get, patchRuntime } = await import('../src/store/core.ts');
const { showAsked, dropAsked, heldAsked } = await import('../src/components/momo/askedQuestion.ts');

const turns = (chatId: string) => get().runtime[chatId]?.turns ?? [];

test('shown at once after the chat’s turns, finished; again is the same copy; dropped when taken back', () => {
  patchRuntime('c1', () => ({ turns: [{ id: 't0', status: 'completed', items: [] } as any] }));
  showAsked('c1', 'r1', 'What drink do I prefer?');
  showAsked('c1', 'r1', 'What drink do I prefer?');
  const shown = turns('c1');
  assert.deepEqual(
    shown.map((t) => t.id),
    ['t0', 'pending-r1'],
  );
  assert.equal(shown[1].status, 'completed');
  assert.deepEqual(shown[1].items, [
    {
      type: 'userMessage',
      id: 'local-r1',
      clientId: 'r1',
      content: [{ type: 'text', text: 'What drink do I prefer?', text_elements: [] }],
    },
  ]);
  assert.equal(get().runtime.c1.activeTurnId ?? null, null, 'no running turn for it');
  dropAsked('c1', 'r1');
  assert.deepEqual(
    turns('c1').map((t) => t.id),
    ['t0'],
  );
});

test('held once another turn has the message (with what main put around it); not before, and not for a copy already gone', () => {
  const asked = new Map([
    ['r1', 'Green tea?'],
    ['r2', 'Lunch?'],
    ['r3', 'Gone?'],
  ]);
  const own = (id: string, text: string) => ({ id: `pending-${id}`, items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] });
  const list: any[] = [
    own('r1', 'Green tea?'),
    own('r2', 'Lunch?'),
    { id: 'ct-1', items: [{ type: 'userMessage', content: [{ type: 'text', text: '<momo-context>…</momo-context>\nGreen tea?' }] }] },
    { id: 'ct-2', items: [{ type: 'agentMessage', text: 'Lunch?' }, { type: 'userMessage', content: 'Lunch?' }, { type: 'userMessage' }] },
    { id: 'ct-3', items: [{ type: 'userMessage', content: [null, { type: 'image' }, { type: 'text' }] }] },
    { id: 'ct-4', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Gone?' }] }] },
  ];
  assert.deepEqual(heldAsked(list, asked), ['r1']);
  assert.deepEqual(heldAsked(undefined, asked), []);
});
