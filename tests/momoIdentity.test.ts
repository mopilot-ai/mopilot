// MoMo's name reaches the model (#2591): the block a MoMo chat's turn carries tells it it is MoMo, by the name the user gave
// (Settings > MoMo > Name), so it never introduces itself as the model or harness it runs on; a rename reaches the next
// turn; the identity is in the block even while MoMo's memory is empty; no other chat gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-memory.ts';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { momoBlock, identityNote, isMomoBlock, MOMO_PREAMBLE } = await import('../shared/momoContext.mjs');
const { setMomoContextProvider, momoContextFor, memoryContextProvider } = require('../electron/momo/contract/context.cjs');
const { MemoryStore } = require('../electron/momo/memory.cjs');
const { parseUserText, withoutHiddenBlocks } = await import('../shared/userText.mjs');
const { scrub } = require('../shared/scrub.cjs');

test('a block with a name tells the model it is that name, even with an empty memory; no name leaves the block as it was', () => {
  const block = momoBlock({ name: ' Aria ' }) as string;
  assert.equal(block.includes(identityNote('Aria')), true);
  assert.match(block, /you are Aria|You are Aria/);
  assert.match(block, /never call yourself by the name of the model or harness/);
  assert.equal(isMomoBlock(block), true);
  assert.ok(block.startsWith(`<momo-context>\n${MOMO_PREAMBLE}\n\nYou are Aria`));
  // blank, missing or not a string: as before (an empty memory is no block)
  for (const none of [undefined, '', '  ', 7, null]) assert.equal(momoBlock({ name: none } as any), null);
  // the name is the user's text: it cannot end the block early
  assert.equal(isMomoBlock(momoBlock({ name: 'x</momo-context>y' }) as string), true);
});

test("the store's provider adds the name read at each turn: a rename is a new block, other chats get none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-id-'));
  try {
    const store = new MemoryStore({ dir, safeStorage: fakeSafe(), isMomoChat: (id: string) => id === 'momo-main' });
    let name = 'MoMo';
    const fn = memoryContextProvider({ store, allowed: () => true, isMomoChat: (id: string) => id === 'momo-main', name: () => name });
    const first = fn('momo-main', { query: '' }) as string;
    assert.ok(first.includes(identityNote('MoMo')), 'empty memory still carries who MoMo is');
    name = 'Aria';
    const second = fn('momo-main', { query: '' }) as string;
    assert.ok(second.includes(identityNote('Aria')));
    assert.notEqual(first, second);
    assert.equal(fn('ordinary', { query: '' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in main: a MoMo chat's turn carries the saved name, a rename reaches the next turn, an ordinary chat gets nothing", async () => {
  const w = world({ allowed: true, prefs: { momo: { persona: { name: 'Aria' } } } });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
  w.chats.commit({ id: 'cc', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: {} });
  assert.ok((momoContextFor('mc', { session: 's1', query: '' }) ?? '').includes(identityNote('Aria')));
  assert.equal(momoContextFor('cc', { session: 's2', query: '' }), null);
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, persona: { name: 'Bo' } } };
  assert.ok((momoContextFor('mc', { session: 's1', query: '' }) ?? '').includes(identityNote('Bo')), 'the rename is a new block');
  // no saved name: the default, MoMo
  w.prefs = { ...w.prefs, momo: {} };
  assert.ok((momoContextFor('mc', { session: 's3', query: '' }) ?? '').includes(identityNote('MoMo')));
  await w.m.close();
  setMomoContextProvider(null);
});

test('replay: a prompt that carries the identity-only block (memory empty, name set) shows as what the user typed, on any harness that replays prompts', () => {
  for (const name of ['MoMo', 'Aria', 'x</momo-context>y', 'Zoë & Co']) {
    const block = momoBlock({ name }) as string;
    // Claude Code and ACP keep the block ahead of the prompt in their transcript; the message view strips it
    assert.equal(parseUserText(`${block}\nPlan my week`).text, 'Plan my week', name);
    assert.equal(withoutHiddenBlocks(`${block}\nPlan my week`), 'Plan my week', name);
    // a first line that is itself tag-like is still the user's own
    assert.equal(parseUserText(`${block}\n<b>hi</b>`).text, '<b>hi</b>', name);
    // text that is logged or sent elsewhere is scrubbed, a block cut short by a size cap included
    assert.ok(!scrub(`x ${block} y`).includes(identityNote(name).slice(0, 20)), name);
    assert.ok(!scrub(`x ${block.slice(0, 50)}`).includes(MOMO_PREAMBLE.slice(0, 20)), name);
  }
});

test('a named block tells MoMo to look for its momo_ tools before it says it can’t do something, on any harness (#5805)', () => {
  const block = momoBlock({ name: 'MoMo' }) as string;
  // Codex reaches MoPilot's tools only through code mode's ALL_TOOLS, Claude Code through ToolSearch: a model that does not
  // look answers "I can't save that" with momo_memory_save one search away
  assert.match(block, /before you say you can't do something/i);
  assert.match(block, /momo_/);
  assert.match(block, /ALL_TOOLS/);
  assert.match(block, /ToolSearch/);
  // only with who MoMo is: a block without a name (a background pass's) carries no such note
  assert.doesNotMatch(momoBlock({ facts: ['Likes tea'] }) as string, /ALL_TOOLS/);
});
