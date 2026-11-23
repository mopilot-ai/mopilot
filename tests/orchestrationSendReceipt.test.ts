// A family-message reply waits for actual native acceptance, keeping refused input in the target's main queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';
import { setup as controller, tick } from './support/controller/fixture.ts';

async function family() {
  const h = orchestration();
  h.userTurn();
  const a = (await h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'a', use_worktree: false })).chat_id;
  const b = (await h.orch.start('top', { background: BACKGROUND, title: 'B', prompt: 'b', use_worktree: false })).chat_id;
  const main = controller({ auto: false });
  h.orch.o.controller = main.c;
  h.orch.o.send = (id: string, item: any) => main.c.startOrKeep(id, item);
  return { ...h, ...main, a, b };
}

test('a rejected sibling message reports queued with its cause and retry uses its original delivery identity', async () => {
  const h = await family();
  let settled = false;
  const pending = h.orch.message(h.a, { to: h.b, message: 'keep this' }).then((value: any) => {
    settled = true;
    return value;
  });
  await tick();
  assert.equal(settled, false);
  assert.equal(h.execs.length, 1);
  const item = h.execs[0].item;
  h.execs[0].done({ started: false, error: 'list_turns is not supported yet' });
  const receipt = await pending;
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.error, 'list_turns is not supported yet');
  assert.equal(receipt.message_id, item.id);
  assert.deepEqual(h.s(h.b).queue, [item]);
  assert.equal(Object.keys(h.journal.data.deliveries).filter((id) => id === item.id).length, 1);
  await tick();
  assert.equal(h.execs.length, 1, 'no automatic retry after a refusal');
  const retry = h.c.sendNow(h.b, item.id, null, true);
  await tick();
  assert.equal(h.execs[1].item.id, item.id);
  h.execs[1].done({ started: true, turnId: 'retried' });
  assert.deepEqual(await retry, { status: 'sent' });
  assert.equal(h.s(h.b).queue.length, 0);
});

test('accepted family delivery and independent busy messages preserve their own journal identities', async () => {
  const h = await family();
  const first = h.orch.message(h.a, { to: 'parent', message: 'first' });
  const next = await h.orch.message(h.b, { to: 'parent', message: 'second' });
  assert.equal(next.status, 'queued');
  assert.equal(next.error, undefined);
  assert.equal(h.execs.length, 1);
  h.execs[0].done({ started: true, turnId: 'accepted' });
  const accepted = await first;
  assert.equal(accepted.status, 'delivered');
  assert.notEqual(accepted.message_id, next.message_id);
  assert.deepEqual(
    h.s('top').queue.map((item: any) => item.id),
    [next.message_id],
  );
});

test('a child refusal keeps the same queue owner and never reports delivered', async () => {
  const h = await family();
  const pending = h.orch.message('top', { to: h.b, message: 'child input' });
  await tick();
  h.execs[0].done({ started: false, error: 'child unavailable' });
  const receipt = await pending;
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.error, 'child unavailable');
  assert.equal(h.s(h.b).queue[0].id, receipt.message_id);
  assert.equal(h.journal.data.queue.length, 0);
  assert.equal(h.execs.length, 1);
});

test('scheduler admission never promotes an unacknowledged pumped send into delivered', async () => {
  const h = await family();
  h.state.patch(h.a, { turn: 'running', activeTurn: { id: 'busy', human: true } });
  h.journal.change((data: any) => data.queue.push({ id: 'older', chatId: h.a, item: { id: 'older', text: 'wait' }, at: 1 }));
  const receipt = await h.orch.message('top', { to: h.b, message: 'pumped' });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.queue_position, undefined, 'it is owned by main now, not at a scheduler position');
  assert.equal(h.execs.length, 1);
  h.execs[0].done({ started: false, error: 'refused after dispatch' });
  await tick();
  assert.equal(h.s(h.b).queue.length, 1);
  assert.equal(h.s(h.b).queue[0].id, receipt.message_id);
  assert.equal(h.s(h.b).crashed, 'refused after dispatch');
  assert.equal(h.execs.length, 1);
});

// Claude Desktop 4.29.0 ends a message removed from the recipient's queue as undelivered, and tells the sender not to wait
test('a queued message the user removes before it runs is listed for its sender as removed (#2970)', async () => {
  const h = await family();
  const pending = h.orch.message(h.a, { to: h.b, message: 'keep this' });
  await tick();
  const item = h.execs[0].item;
  h.execs[0].done({ started: false, error: 'busy' });
  const receipt = await pending;
  assert.equal(receipt.status, 'queued');
  assert.match(receipt.note, /user can remove it first.*removed_messages.*Don't wait on it/);
  assert.equal(h.orch.list(h.a).removed_messages, undefined, 'nothing is removed while it waits');
  const taken = h.c.removeQueued(h.b, item.id);
  assert.equal(h.orch.queuedRemoved(h.b, taken), true);
  assert.deepEqual(h.orch.list(h.a).removed_messages, [{ message_id: item.id, to: 'b', reason: 'user', body: 'keep this' }]);
  assert.equal(typeof h.journal.data.deliveries[item.id].removedAt, 'number');
  // a second removal changes nothing, and the recipient's own list has none: it sent nothing
  assert.equal(h.orch.queuedRemoved(h.b, taken), false);
  assert.equal(h.orch.list(h.b).removed_messages, undefined);
});

test('only a family message removed from its own recipient’s queue counts as removed', async () => {
  const h = await family();
  const pending = h.orch.message(h.a, { to: h.b, message: 'x'.repeat(300) });
  await tick();
  const item = h.execs[0].item;
  h.execs[0].done({ started: false, error: 'busy' });
  await pending;
  assert.equal(h.orch.queuedRemoved(h.a, item), false, 'another chat’s queue');
  assert.equal(h.orch.queuedRemoved(h.b, { text: 'typed by the user' }), false, 'an item no session sent');
  assert.equal(h.orch.queuedRemoved(h.b, { sideSession: { id: 'unknown' } }), false, 'an unknown delivery');
  assert.equal(h.orch.queuedRemoved(h.b, undefined), false);
  const brief = Object.keys(h.journal.data.deliveries).find((id) => h.journal.data.deliveries[id].kind === 'brief')!;
  assert.equal(h.orch.queuedRemoved(h.a, { sideSession: { id: brief } }), false, 'a brief is not a message');
  assert.equal(h.orch.queuedRemoved(h.b, item), true);
  assert.equal(h.orch.list(h.a).removed_messages![0].body.length, 120, 'the list quotes the start of it');
});

test('list_sessions reports the five latest removed messages, newest first', async () => {
  const h = await family();
  h.journal.change((d: any) => {
    for (let i = 0; i < 6; i++)
      d.deliveries[`m${i}`] = { kind: 'message', chatId: h.b, from: h.a, body: `m${i}`, at: i, removedAt: 100 + i };
    d.deliveries.kept = { kind: 'message', chatId: h.b, from: h.a, body: 'still queued', at: 7 };
  });
  assert.deepEqual(
    h.orch.list(h.a).removed_messages!.map((m: any) => m.body),
    ['m5', 'm4', 'm3', 'm2', 'm1'],
  );
});

test('a follow-up waiting in the journal queue for a slot carries no remove-it note; one in the recipient’s tray does', async () => {
  const h = await family();
  const asChild = (r: any) => {
    h.orch.deliver = async () => r;
    return h.orch.message('top', { to: h.a, message: 'later' });
  };
  const waiting = await asChild({ queued: true, position: 2 });
  assert.deepEqual([waiting.status, waiting.queue_position, waiting.note], ['queued', 2, undefined]);
  const tray = await asChild({ queued: true });
  assert.equal(tray.status, 'queued');
  assert.match(tray.note, /user can remove it first/);
  const started = await asChild({ started: true });
  assert.deepEqual([started.status, started.note], ['delivered', undefined]);
});

test('a journal that cannot record the removal does not fail it: the item is already out of the queue', async () => {
  const h = await family();
  const pending = h.orch.message(h.a, { to: h.b, message: 'keep this' });
  await tick();
  const item = h.execs[0].item;
  h.execs[0].done({ started: false, error: 'busy' });
  await pending;
  const change = h.journal.change.bind(h.journal);
  h.journal.change = () => {
    throw new Error('journal unavailable');
  };
  assert.equal(h.orch.queuedRemoved(h.b, item), false);
  h.journal.change = change;
  assert.equal(h.orch.list(h.a).removed_messages, undefined, 'nothing was recorded');
  assert.equal(h.orch.queuedRemoved(h.b, item), true, 'a later removal still records');
});
