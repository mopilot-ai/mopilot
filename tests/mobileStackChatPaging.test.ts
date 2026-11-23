// Mobile Remote end to end: a Mac with more chats than one page. The phone pages through all of them over the relay, each exactly once, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack.ts';

const TOTAL = 230;
/** The Mac's chats, newest first, with titles long enough that a page is a real frame. */
const chats = Array.from({ length: TOTAL }, (_, i) => ({
  id: `chat-${String(i).padStart(3, '0')}`,
  title: `Chat ${i} ${'x'.repeat(120)}`,
  harness: i % 3 === 0 ? 'claude' : 'codex',
  at: 1_000_000 - i,
  project: null,
  pinned: false,
}));

async function paired() {
  const relay = await startRelay();
  const asked: any[][] = [];
  const mac = await startMac(relay, {
    ops: {
      recent: async (limit: number, archived: boolean, offset = 0) => (
        asked.push([limit, archived, offset]), chats.slice(offset, offset + limit)
      ),
    },
  });
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  return { mac, phone, asked };
}

test('the phone pages through every chat on the Mac, 50 at a time, each once and in order', async () => {
  const { phone, asked } = await paired();
  const seen: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await phone.ask('chats.recent', offset ? { limit: 50, offset } : { limit: 50 });
    assert.ok(page.chats.length <= 50);
    seen.push(...page.chats.map((c: any) => c.id));
    offset = seen.length;
    if (!page.more) break;
  }
  assert.equal(seen.length, TOTAL);
  assert.deepEqual(
    seen,
    chats.map((c) => c.id),
  );
  assert.equal(new Set(seen).size, TOTAL);
  // one more row than a page is read to tell whether another follows, and nothing else
  assert.deepEqual(asked, [
    [51, false, 0],
    [51, false, 50],
    [51, false, 100],
    [51, false, 150],
    [51, false, 200],
  ]);
});

test('a full page of 200 arrives whole over the relay and says there is more', async () => {
  const { phone } = await paired();
  const page = await phone.ask('chats.recent', { limit: 200 });
  assert.equal(page.chats.length, 200);
  assert.equal(page.more, true);
  const rest = await phone.ask('chats.recent', { limit: 200, offset: 200 });
  assert.equal(rest.chats.length, TOTAL - 200);
  assert.equal(rest.more, false);
  assert.equal(rest.chats[0].state, 'running', 'each chat carries its turn state, as the Mac reports it');
});

test('the Mac announces that it pages in its hello, and a page start that is nonsense is the first page', async () => {
  const { phone } = await paired();
  assert.equal((await phone.ask('machine.hello')).capabilities.chatsPaging, true);
  const bad = await phone.ask('chats.recent', { limit: 3, offset: -7 });
  assert.deepEqual(
    bad.chats.map((c: any) => c.id),
    ['chat-000', 'chat-001', 'chat-002'],
  );
  assert.equal(bad.more, true);
});
