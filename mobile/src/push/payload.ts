// Parse the data a push carries (APNs custom keys or an FCM data message): untrusted strings in, a typed payload or null out.
import { isPushKind, type PushKind } from './kinds';

/** `card` names the MoMo card a needs-you push was raised for, as chatRef(pair, card id): opaque to the relay. */
export type PushPayload = {
  kind: PushKind;
  ref: string;
  count: number;
  sealedTitle?: string;
  /** MoMo's opt-in body (`sb`), sealed on the Mac; only on a momoNeedsYou. */
  sealedBody?: string;
  card?: string;
  requestId?: string;
};
// `requestId` is set after a Host card blob opened (the controller adds it), never read from the wire.

const MAX_REF = 128;
const MAX_SEALED = 2048; // the relay forwards at most this much (relay/src/pushPayload.mjs)

const text = (value: unknown, max: number) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);

/** Returns null unless the data names a known kind and a bounded opaque ref; everything else is optional and dropped when malformed. */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const ref = text(raw.ref, MAX_REF);
  if (!isPushKind(raw.kind) || !ref) return null;
  const count = Number(raw.count);
  return {
    kind: raw.kind,
    ref,
    count: Number.isSafeInteger(count) && count >= 1 && count <= 99 ? count : 1,
    sealedTitle: text(raw.st, MAX_SEALED),
    ...(raw.kind === 'momoNeedsYou' && text(raw.card, MAX_REF) ? { card: text(raw.card, MAX_REF) } : {}),
    ...(raw.kind === 'momoNeedsYou' && text(raw.sb, MAX_SEALED) ? { sealedBody: text(raw.sb, MAX_SEALED) } : {}),
  };
}
