// Mobile Remote end to end: older history. A phone follows a chat that has more rows than a snapshot holds and pages the rest with its own code over the real relay, sealed channel and Mac stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, client, phoneEarlier, phoneThread, type Relay } from './support/mobileStack.ts';

/** `n` turns of one question and one answer, with the ids a harness saves them under. */
const turnsOf = (n: number, text = (i: number) => `${i}`) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    sourceSession: 's',
    items: [
      { type: 'userMessage', id: `u${i}`, content: [{ type: 'text', text: `question ${text(i)}` }] },
      { type: 'agentMessage', id: `a${i}`, text: `answer ${text(i)}` },
    ],
  }));

async function online(relay: Relay, history: Record<string, any[]>) {
  const mac = await startMac(relay, { history });
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('c1');
  return { mac, phone, request: client.ownedRequest(phone.runtime) };
}

/** The snapshot's rows, then every page back to the start, the way the chat screen asks for them. */
async function pageBack(request: any) {
  const thread = phoneThread.snapshot(await request('chat.follow', { chatId: 'c1', items: 50 }));
  const shown: string[] = thread.items.map((r: any) => r.text);
  let before = phoneEarlier.oldestId(thread);
  let pages = 0;
  for (let more = true; more && before; pages++) {
    const page = await phoneEarlier.readEarlier(request, 'c1', before);
    shown.unshift(...page.rows.map((r: any) => r.text));
    before = page.rows[0]?.id ?? null;
    more = page.more;
    if (pages > 50) assert.fail('paging did not end');
  }
  return { shown, pages, held: thread.items.length };
}

test('a phone pages a long chat from its snapshot back to the first message, with no gap and no repeat', async () => {
  const relay = await startRelay();
  const { request } = await online(relay, { c1: turnsOf(130) });
  const { shown, pages, held } = await pageBack(request);
  assert.equal(held, 50, 'the snapshot holds the last 50 rows');
  assert.ok(pages >= 5, `${pages} pages of ${phoneEarlier.PAGE}`);
  assert.deepEqual(shown, Array.from({ length: 130 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat());
});

test('rows of 20,000 characters page in frames that fit, fewer to a page and none lost', async () => {
  const relay = await startRelay();
  const { phone, request } = await online(relay, { c1: turnsOf(30, (i) => `${i}:${'x'.repeat(20_000)}`) });
  const { shown, pages } = await pageBack(request);
  assert.equal(shown.length, 60);
  assert.deepEqual(
    shown.map((t) => t.split(':')[0]),
    Array.from({ length: 30 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat(),
  );
  assert.ok(pages > 3, `${pages} pages: a frame holds a few of these rows`);
  assert.equal(phone.snap().phase, 'online', 'no page was too large for the relay');
});

test('a chat whose history changed asks for a refresh, and a short chat has nothing before its snapshot', async () => {
  const relay = await startRelay();
  const { mac, request } = await online(relay, { c1: turnsOf(60), c2: turnsOf(5) });
  const thread = phoneThread.snapshot(await request('chat.follow', { chatId: 'c1', items: 50 }));
  const before = phoneEarlier.oldestId(thread);
  mac.history.c1.splice(0, mac.history.c1.length, ...turnsOf(60).slice(50));
  await assert.rejects(phoneEarlier.readEarlier(request, 'c1', before), /Refresh it to read earlier messages/);
  mac.known.add('c2');
  const short = phoneThread.snapshot(await request('chat.follow', { chatId: 'c2', items: 50 }));
  const first = phoneEarlier.oldestId(short);
  assert.deepEqual(await phoneEarlier.readEarlier(request, 'c2', first), { rows: [], more: false, omitted: false });
});
