// MoMo's bridges from parallel PRs (src/lib/momoBridges.ts): each one the preload has, else undefined, read when asked so a preload that gains one is seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';

const native: Record<string, unknown> = {};
installNativeStub(native);
const { momoChatBridge, momoMemoryBridge } = await import('../src/lib/momoBridges.ts');

test('a bridge the preload has is handed out; one it lacks is undefined', () => {
  assert.equal(momoChatBridge(), undefined);
  assert.equal(momoMemoryBridge(), undefined);
  const chat = { getBrain: async () => null };
  const memory = { files: async () => ({ ok: true, persona: '' }) };
  Object.assign(native, { momoChat: chat, momoMemory: memory });
  assert.equal(momoChatBridge(), chat);
  assert.equal(momoMemoryBridge(), memory);
});
