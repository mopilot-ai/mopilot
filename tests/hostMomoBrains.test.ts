// MoMo's main chat on every harness family (host/src/momoChats.mjs `start`): the same rule for each, a typed cause and fix where one cannot be kept apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoChats } from '../host/src/momoChats.mjs';
import { PROVIDER_ENV, world } from './support/host/momoChatsWorld.ts';

test('S6: every family is held to the same rule: a Codex chat starts, with its own id form, only where the Host keeps its chats apart, and says why and what to do where it does not', async () => {
  const w = await world();
  try {
    const kept = { ...w.h.sessions, isolated: (f: string) => ['claude', 'codex', 'acp'].includes(f) };
    const chats = createMomoChats({ home: w.home, sessions: kept, epochs: w.epochs, env: PROVIDER_ENV });
    w.home.chats = chats;
    const codex = await chats.start({ harness: 'codex' });
    assert.match(codex.chatId, /^codex:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-c0de[0-9a-f]{8}$/);
    assert.equal(chats.isMomoChat(codex.chatId), true, 'tagged, and kept apart like the others');
    assert.equal((await chats.start({ harness: 'codex' })).chatId, codex.chatId, 'the same main chat again');
    const claude = await chats.start({ harness: 'claude' });
    assert.match(claude.chatId, /^claude:/);
    assert.notEqual(claude.chatId, codex.chatId);
    // a Host that does not keep Codex's chats apart refuses it with the cause and the fix, as it does any other agent
    const without = createMomoChats({
      home: w.home,
      sessions: { ...w.h.sessions, isolated: (f: string) => f !== 'codex' },
      epochs: w.epochs,
      env: PROVIDER_ENV,
    });
    await assert.rejects(
      without.start({ harness: 'codex' }),
      (e: any) => e.code === 'momo_brain_unavailable' && e.details.fix === 'use_another_agent' && e.details.agent === 'codex',
    );
    // what is not an agent is refused too
    await assert.rejects(
      without.start({ harness: 'gemini' as any }),
      (e: any) => e.code === 'momo_brain_unavailable' && /not an agent/.test(e.message),
    );
  } finally {
    await w.h.close();
  }
});
