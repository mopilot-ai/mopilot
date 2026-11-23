// The phone's own enrollment with a Host (#2709, X3 "Use without your Mac"): mint the relay credential, register it on the phone's Host
// lane, have the Mac introduce it (`machines.enroll`), derive the pair root with the Host's half and keep the record. Every step is
// idempotent on the phone-minted relay host id, and a failure at any step takes back what the earlier ones made.
import { createCrypto } from './crypto.mjs';
import { fromBase64, toBase64, toHex, utf8 } from './envelope.mjs';

/** The id of the app's side of every enrollment's pair (host/src/relayLink.mjs APP_ID). */
const APP_ID = 'app';

export class DirectEnrollError extends Error {
  /** @param {'update' | 'cancelled' | 'failed'} code @param {string} message @param {{ relay: boolean, mac: boolean }} [undone] */
  constructor(code, message, undone = { relay: true, mac: true }) {
    super(message);
    this.name = 'DirectEnrollError';
    this.code = code;
    /** Whether what the earlier steps made was taken back on the relay and on the Mac. */
    this.undone = undone;
  }
}

const b64url = (/** @type {import('./crypto.mjs').Primitives} */ prim, /** @type {number} */ n) =>
  toBase64(prim.randomBytes(n)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/**
 * @param {object} o
 * @param {import('./crypto.mjs').Primitives} o.prim
 * @param {{ ed: { pk: Uint8Array } }} o.identity the phone's keys (the vault's identity)
 * @param {string} o.machineId the machine's id on the Mac
 * @param {string} o.name this phone's name, as the Host will list it
 * @param {string} o.relayUrl
 * @param {{ register: (h: { host: string, pair: string, hash: string }) => Promise<unknown>, revoke: (host: string) => Promise<unknown> }} o.lane the phone's Host lane on the relay
 * @param {(params: object) => Promise<{ hostPub: string, hostEphPub: string, hostKey: string, name: string, features: string[] }>} o.enroll `machines.enroll` over the Mac channel
 * @param {() => Promise<unknown>} o.forget `machines.forget`, best effort
 * @param {(record: object) => Promise<unknown>} o.save keeps the record in the vault
 * @param {() => boolean} [o.current] false once the person gave up: a late reply is discarded and what was made goes
 */
export async function enrollDirect({ prim, identity, machineId, name, relayUrl, lane, enroll, forget, save, current = () => true }) {
  const c = createCrypto(prim);
  const host = `h_${b64url(prim, 16)}`;
  const pair = `p_${b64url(prim, 12)}`;
  const secret = b64url(prim, 32);
  const sk = prim.randomBytes(32);
  const ephSk = prim.randomBytes(32);
  await lane.register({ host, pair, hash: toHex(prim.sha256(utf8(secret))) });
  /** A best-effort step: whether it worked. @param {() => Promise<unknown>} step */
  const tried = async (step) => {
    try {
      await step();
      return true;
    } catch {
      return false;
    }
  };
  /** What the steps after the relay's registration take back; says which of them could not be taken back. @param {boolean} onMac */
  const undo = async (onMac) => ({ relay: await tried(() => lane.revoke(host)), mac: onMac ? await tried(forget) : true });
  /** @type {Awaited<ReturnType<typeof enroll>>} */
  let answer;
  try {
    answer = await enroll({
      hostId: machineId,
      relay: { hostId: host, secret, pairId: pair, relayUrl },
      appPub: toBase64(prim.x25519Base(sk)),
      appEphPub: toBase64(prim.x25519Base(ephSk)),
      edPub: toBase64(identity.ed.pk),
      name,
    });
  } catch (error) {
    const left = await undo(false);
    const code = /** @type {any} */ (error)?.code === 'update_host' ? 'update' : 'failed';
    throw new DirectEnrollError(code, error instanceof Error ? error.message : 'The Mac could not introduce this phone.', left);
  }
  if (!current()) {
    const left = await undo(true);
    throw new DirectEnrollError('cancelled', 'Direct access was cancelled.', left);
  }
  const root = c.deriveRoot(sk, fromBase64(answer.hostPub), ephSk, fromBase64(answer.hostEphPub), APP_ID, host, pair);
  const record = {
    machineId,
    hostKey: answer.hostKey,
    name: answer.name,
    features: answer.features,
    hostId: host,
    pairId: pair,
    relayUrl,
    root: toBase64(root),
  };
  try {
    await save(record);
  } catch (error) {
    const left = await undo(true);
    throw new DirectEnrollError('failed', error instanceof Error ? error.message : 'The phone could not keep direct access.', left);
  }
  return record;
}
