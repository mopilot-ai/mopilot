// A turn accepted into the ledger while a move's begin lands (host/src/momoChats.mjs): it never runs on a paused home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/host/momoChatsWorld.ts';

test('a begin that lands while a turn is being written means the turn never runs: it ends cancelled and the chat is not left busy', async () => {
  const w = await world();
  try {
    const { chatId } = await w.chats.start({ harness: 'claude' });
    const turns = w.home.stores()!.turns;
    const accept = turns.accept.bind(turns);
    turns.accept = async (t: any) => {
      const out = await accept(t);
      // the move's begin lands between the check and the end of the write
      await w.home.swap(1, (h: any) => {
        h.state = 'moving';
        return false;
      });
      return out;
    };
    await assert.rejects(
      w.chats.rules.guard('chat.send', { chatId, key: 'key-00000001', text: 'hi' }, { fingerprint: 'phone' }),
      (e: any) => e.code === 'momo_home_away',
    );
    turns.accept = accept;
    // the turn is settled, not open: nothing is busy when the home runs again
    await w.home.swap(1, (h: any) => {
      h.state = 'running';
      return false;
    });
    assert.equal(((await w.home.turn('key-00000001')) as any).state, 'cancelled');
  } finally {
    await w.home.close();
  }
});
