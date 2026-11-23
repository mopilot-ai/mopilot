// A card read that fails after a card change is tried again, a bounded number of times, so a phone is not left without its card until the next change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './support/waitFor.ts';
import { card, followed } from './support/card-update-kit.ts';

test('a failed card read after a change is retried and the card reaches the phone; the notes say only the last failure', async () => {
  const { r, p } = await followed();
  r.service.cardUpdates.retryMs = [1, 1];
  let reads = 0;
  r.ops.cardsOf = async () => {
    if (++reads < 3) throw new Error(`history ${reads} failed`);
    return [card('a')];
  };
  const noted: string[] = [];
  r.service.note = (what: string) => void noted.push(what);
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: {} }], turn: 'awaitingUser' });
  await waitFor(() => p.events('cards.changed').length === 1, 'the card after two failed reads');
  assert.deepEqual(noted, [], 'a read that finally worked is not a failure');
  assert.equal(reads, 3);
});

test('a read that keeps failing is noted once after its retries, and a retry for a chat no longer followed does nothing', async () => {
  const { r, p } = await followed();
  r.service.cardUpdates.retryMs = [1];
  let reads = 0;
  r.ops.cardsOf = async () => {
    reads++;
    throw new Error('history is gone');
  };
  const noted: string[] = [];
  r.service.note = (what: string) => void noted.push(what);
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: {} }] });
  await waitFor(() => noted.length === 1, 'the failure noted after the retries');
  assert.equal(reads, 2, 'one try and one retry');
  assert.equal(p.events('cards.changed').length, 0);

  r.service.cardUpdates.retryMs = [20];
  reads = 0;
  r.state.patch('c1', { approvals: [{ id: 'a2', method: 'x', params: {} }] });
  await waitFor(() => reads === 1, 'the first try');
  await p.ask('chat.unfollow', { chatId: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads, 1, 'no retry once nobody follows the chat');
});
