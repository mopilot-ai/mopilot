// What the pairing-by-code protocol tests share (tests/codePair*.test.ts): the two primitive sets the product runs it on, two devices that can sign, machines on one offer, a whole walk, and message helpers.
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import * as cp0 from '../../../shared/host/codePair.mjs';
// @ts-ignore
import { createCrypto } from '../../../shared/remote/crypto.mjs';
// @ts-ignore
import { createNodePrimitives } from '../../../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../../../electron/remote/sodiumPrimitives.cjs');
/** The two primitive sets the product runs this on: libsodium in the app (sodium-native), and Node's own crypto in the Host (shared/remote/nodePrimitives.mjs). The phone's react-native-libsodium is not run here. */
export const SETS: Record<string, () => any> = { sodium: createSodiumPrimitives, node: createNodePrimitives };
export const crypto = createCrypto(createSodiumPrimitives());
export const ID = 'r_AAAAAAAAAAAAAAAAAAAAAA';
export const OTHER = 'r_BBBBBBBBBBBBBBBBBBBBBB';
export const HINT = 'K7Q';
export const device = (name: string, c = crypto) => {
  const { pk, sk } = c.prim.edKeypair();
  return { pub: pk, name, sign: (m: Uint8Array) => c.prim.edSign(sk, m) };
};
export const A = device('Work MacBook');
export const B = device('Studio Mac');
export const run = (over: Record<string, any> = {}) => {
  const claims = over.claims ?? 1;
  const a = cp.createInitiator({
    crypto,
    secret: 'MX2F9',
    hint: HINT,
    rendezvousId: ID,
    claims,
    device: A,
    budget: cp.createRunBudget(),
    ...over.a,
  });
  const b = cp.createResponder({
    crypto,
    secret: 'MX2F9',
    hint: HINT,
    rendezvousId: ID,
    claims,
    device: B,
    budget: cp.createRunBudget(),
    ...over.b,
  });
  return { a: a as any, b: b as any };
};
export const walk = () => {
  const { a, b } = run();
  const m1 = a.first();
  const m2 = b.receive(m1);
  const m3 = a.second(m2);
  const seen = b.receive3(m3);
  return { a, b, m1, m2, m3, seen };
};
export const json = (m: string) => JSON.parse(Buffer.from(m, 'base64url').toString());
export const shape = (o: object) => cp.b64u(new TextEncoder().encode(JSON.stringify(o)));

export const cp = cp0;
export { createCrypto, createNodePrimitives, createSodiumPrimitives };
