// What a MoMo push opens its sealed lease stamp with: the signed-in account and the stamp key of every Host enrollment, derived from the pair roots that stay in the encrypted vault.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import './support/phone/register.ts';

const requireCjs = createRequire(import.meta.url);
const prim = requireCjs('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const storage = (() => {
  let row: string | null = null;
  let key: string | null = null;
  return {
    key: { get: async () => key, set: async (v: string) => void (key = v) },
    transaction: async (fn: any) => fn({ read: async () => row, write: async (v: string) => void (row = v) }),
  };
})();
mock.module('../mobile/src/platform/vault.ts', { namedExports: { openVaultStorage: async () => storage } });
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => prim } });

const vaultPath = '../shared/remote/phoneVault.mjs';
const sealPath = '../shared/remote/stampSeal.mjs';
const envPath = '../shared/remote/envelope.mjs';
const contextPath = '../mobile/src/platform/pushStampContext.ts';
const { createPhoneVault } = await import(vaultPath);
const { createStampSeal } = await import(sealPath);
const { toBase64 } = await import(envPath);
const { momoStampContext } = await import(contextPath);

test('a signed-in phone with a Host enrollment opens a stamp sealed for that enrollment, and nothing else', async () => {
  const vault = createPhoneVault({ prim, ...storage });
  assert.equal(await momoStampContext(), null, 'nobody signed in');
  await vault.setAccount({ user: { id: 'u1' }, deviceId: 'd1' });
  assert.equal(await momoStampContext(), null, 'no Host enrolled');
  const root = new Uint8Array(32).fill(7);
  await vault.putHost('mini', { root: toBase64(root), pairId: 'p', hostKey: 'k' });
  await vault.putHost('broken', { pairId: 'p2', hostKey: 'k2' });
  const seal = createStampSeal(prim);
  const ctx = await momoStampContext();
  assert.equal(ctx.user, 'u1');
  const mine = seal.seal({ key: seal.stampKey(root), ref: 'r', homeId: 'mini', leaseEpoch: 3 });
  assert.deepEqual(ctx.open(mine, 'r'), { homeId: 'mini', leaseEpoch: 3 });
  assert.equal(ctx.open(mine, 'other'), null);
  const other = seal.seal({ key: seal.stampKey(new Uint8Array(32).fill(8)), ref: 'r', homeId: 'x', leaseEpoch: 3 });
  assert.equal(ctx.open(other, 'r'), null, 'sealed for a pair this phone is not in');
});
