// A simulated phone for Mobile Remote's tests: what the app on the other end does with a QR payload (shared/remote/crypto.mjs over the same primitives), for pairing and for talking over a paired channel.
import * as E from '../../shared/remote/envelope.mjs';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { prim } from './remoteKit.ts';

export const crypto = createCrypto(prim);

export function makePhone(id = 'phone-1', name = 'Du’s iPhone') {
  const sk = prim.randomBytes(32);
  const ephSk = prim.randomBytes(32);
  return { id, name, sk, pk: prim.x25519Base(sk), ed: prim.edKeypair(), eph: { sk: ephSk, pk: prim.x25519Base(ephSk) } };
}
export type Phone = ReturnType<typeof makePhone>;

/** The hello frame a phone sends after scanning `payload`; `tweak` changes the request, the proof or the code it seals with. */
export function helloFor(
  phone: Phone,
  payload: any,
  tweak: { request?: object; proof?: Uint8Array; code?: Uint8Array; pair?: string } = {},
) {
  const code = E.fromBase64(payload.code);
  const macPub = E.fromBase64(payload.macPub);
  const pair = tweak.pair ?? crypto.pairId(code);
  const request = {
    v: 3,
    phoneId: phone.id,
    name: phone.name,
    edPub: E.toBase64(phone.ed.pk),
    proof: E.toBase64(tweak.proof ?? crypto.pairProof(code, macPub, phone.pk)),
    ephPub: E.toBase64(phone.eph.pk),
    ...tweak.request,
  };
  const key = crypto.helloKey(phone.sk, macPub, tweak.code ?? code);
  return crypto.helloFrame(pair, key, phone.pk, E.utf8(JSON.stringify(request)));
}

/** The safety number the phone computes from a QR payload and its own keys, as the app does before the Mac asks to confirm. */
export function phoneSafetyNumber(phone: Phone, payload: any) {
  return crypto.safetyNumber(
    crypto.pairTranscript({
      macId: payload.macId,
      phoneId: phone.id,
      pairId: crypto.pairId(E.fromBase64(payload.code)),
      macPub: E.fromBase64(payload.macPub),
      phonePub: phone.pk,
      macEdPub: E.fromBase64(payload.macEdPub),
      phoneEdPub: phone.ed.pk,
      macEphPub: E.fromBase64(payload.macEphPub),
      phoneEphPub: phone.eph.pk,
    }),
  );
}

/** A hello whose request is the given text. */
export function helloWithText(phone: Phone, payload: any, text: string) {
  const code = E.fromBase64(payload.code);
  const key = crypto.helloKey(phone.sk, E.fromBase64(payload.macPub), code);
  return crypto.helloFrame(crypto.pairId(code), key, phone.pk, E.utf8(text));
}

/** The answer frame the Mac sent, opened as the phone would. */
export function openReply(phone: Phone, payload: any, frame: any) {
  const key = crypto.helloKey(phone.sk, E.fromBase64(payload.macPub), E.fromBase64(payload.code));
  const plain = crypto.openReplyFrame(key, frame);
  return plain ? JSON.parse(E.fromUtf8(plain)) : null;
}

/** The phone's two ratchet ends for a pair, from its own keys and the ephemeral key in the Mac's answer. */
export function phoneEnds(phone: Phone, payload: any, reply: any) {
  const macPub = E.fromBase64(payload.macPub);
  const pair = crypto.pairId(E.fromBase64(payload.code));
  const root = crypto.deriveRoot(phone.sk, macPub, phone.eph.sk, E.fromBase64(payload.macEphPub), payload.macId, phone.id, pair);
  const m2p = crypto.dirKey(root, 'm2p');
  const p2m = crypto.dirKey(root, 'p2m');
  return {
    pair,
    tx: crypto.createSender({ pair, dir: 'p2m', chain: p2m }),
    rx: crypto.createReceiver({ pair, dir: 'm2p', chain: m2p }),
  };
}
