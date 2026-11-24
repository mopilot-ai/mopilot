// A `home` client (MoMo's home on another machine) is never one that may see MoMo's chats on a Host that is itself a granted home (host/src/momoChats.mjs `seen`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/host/momoChatsWorld.ts';

test("a home client does not see this Host's MoMo chats, though any other paired client does", async () => {
  const w = await world();
  try {
    await w.chats.start({ harness: 'claude' });
    const r = w.chats.rules;
    assert.equal(r.seen({ fingerprint: 'f', kind: 'desktop' }), true);
    assert.equal(r.seen({ fingerprint: 'f', kind: 'home' }), false);
  } finally {
    await w.h.close();
  }
});
