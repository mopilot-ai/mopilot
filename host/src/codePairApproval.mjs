// The person's own proof that a pairing was allowed (R2b of #5576, slice 4, Host side; the design is on the issue): a process of this OS user must not be able to accept a pairing, so `accept: true` needs a signature only the app's native helper can make, after the system's own prompt (Touch ID or the password), with a P-256 key it holds in the Secure Enclave (or, where there is none, in the keychain, flagged `weak`). This Host keeps the key's PUBLIC half, enrolled once, and judges two things with it: the proof of one answer, over a text only this Host makes (so it names this Host, this offer, the number the person saw, the other Mac's key, its name and the credential it brought, and runs out in two minutes), and the proof a controller's record carries, so a record written by hand is no controller. The helper itself is a separate piece (native code, not here).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_TAG = 'mopilot-code-pair-approval-v1';
export const ENROL_TAG = 'mopilot-code-pair-enrol-v1';
/** How long a proof the person gave is good for, and the most it may be dated ahead (a clock a little off is not a reason to refuse the person). */
export const NOT_AFTER_MS = 2 * 60_000;
export const SKEW_MS = 60_000;
/** An uncompressed P-256 point (04 || X || Y) as the Secure Enclave gives it; the SPKI prefix that makes it a key Node reads. */
const POINT = /^[A-Za-z0-9+/]{87}=$/;
const SPKI_P256 = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const SIG = /^[A-Za-z0-9+/]{16,200}={0,2}$/;

const sha256 = (/** @type {string} */ s) => crypto.createHash('sha256').update(s).digest('hex');

/** The hash of the credential the other Mac brought, as the text names it: SHA-256 (hex) of its JSON as this Host serializes it, so a helper takes the hash from the Host and never builds the credential's JSON itself. @param {unknown} carry */
export const carryHashOf = (carry) => sha256(JSON.stringify(carry ?? null));

/**
 * The text the person approves, and nothing else is ever signed, from the structured fields the Host gives the helper (which builds the prompt and this text itself from them): this Host, this offer, the number both Macs show, the other Mac's key (hex), the hash of its name, the credential's hash, the relay link it brought (empty when none), the time it runs out, and whether it was allowed. Ten parts joined by `|`; no part may contain one (the Host's values are hex, base64url, digits and a hash).
 * @param {{ hostId: string, offerId: string, safety: string, peer: string, name: string, carryHash: string, link: string, notAfter: number, accepted: boolean }} f
 */
export const approvalTextFrom = ({ hostId, offerId, safety, peer, name, carryHash, link, notAfter, accepted }) =>
  [APPROVAL_TAG, hostId, offerId, safety, peer, sha256(name), carryHash, link, String(notAfter), accepted ? '1' : '0'].join('|');

/** The same from the credential itself. @param {{ hostId: string, offerId: string, safety: string, peer: string, name: string, carry: unknown, link: string, notAfter: number, accepted: boolean }} f */
export const approvalTextOf = ({ carry, ...f }) => approvalTextFrom({ ...f, carryHash: carryHashOf(carry) });

/** The positions of the parts of the text. */
const AT = { tag: 0, host: 1, peer: 4, name: 5, link: 7, notAfter: 8, accepted: 9, parts: 10 };

/** @param {string} b64 a point as base64 @returns {crypto.KeyObject | null} */
const keyOf = (b64) => {
  try {
    if (!POINT.test(b64)) return null;
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_P256, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
};

/** Whether `sig` (an ECDSA signature in DER, base64) signs `text` under `key`; a signature that is not one is not a proof (`crypto.verify` answers false for it, it does not throw). @param {crypto.KeyObject | null} key @param {string} text @param {unknown} sig */
const signs = (key, text, sig) =>
  !!key &&
  typeof sig === 'string' &&
  SIG.test(sig) &&
  crypto.verify('sha256', Buffer.from(text), { key, dsaEncoding: 'der' }, Buffer.from(sig, 'base64'));

/**
 * @param {object} o
 * @param {string} o.configDir where `approval-key.json` (0600) lives
 * @param {() => string} o.hostId this Host's own name
 * @param {() => number} o.controllers how many controllers this Host has (a key is not enrolled while it has any)
 * @param {NodeJS.Platform} [o.platform] @param {() => number} [o.now]
 */
export function createApprovalKeys({ configDir, hostId, controllers, platform = process.platform, now = Date.now }) {
  const file = path.join(configDir, 'approval-key.json');
  /** The enrolled key, or null: a file that is not exactly this is no key (fail closed: the pairing is not available until it is enrolled again). @returns {{ key: string, weak: boolean } | null} */
  const enrolled = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return saved?.v === 1 && keyOf(saved.key) && typeof saved.weak === 'boolean' ? { key: saved.key, weak: saved.weak } : null;
    } catch {
      return null;
    }
  };
  /** @param {string} message @param {string} code */
  const refusal = (code, message) => Object.assign(new Error(message), { code });
  return {
    /** Whether a pairing can be accepted here and why not: only a Mac with an enrolled approval key can. @returns {{ available: true, weak: boolean } | { available: false, reason: 'unsupported_platform' | 'no_approval_helper' }} */
    status() {
      if (platform !== 'darwin') return { available: false, reason: 'unsupported_platform' };
      const key = enrolled();
      return key ? { available: true, weak: key.weak } : { available: false, reason: 'no_approval_helper' };
    },
    /**
     * Keeps the helper's public key, once: it proves it holds the private half by signing the enrolment text (the system prompt is shown for it), and it is refused while a key is enrolled (a different one is made only by the owner on this machine, who also removes every controller) or while any controller exists.
     * @param {{ key: string, weak: boolean, signature: string }} p
     */
    enrol({ key, weak, signature }) {
      if (platform !== 'darwin') throw refusal('unsupported_platform', 'Pairing by code is available on Macs.');
      if (enrolled()) throw refusal('already_enrolled', 'This Mac already has an approval key.');
      if (controllers() > 0) throw refusal('controllers_exist', 'A key is not enrolled while another Mac can control this one.');
      if (!signs(keyOf(key), [ENROL_TAG, hostId(), key, weak ? 'weak' : 'strong'].join('|'), signature))
        throw refusal('bad_proof', 'The helper did not prove it holds that key.');
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ v: 1, key, weak, at: now() }), { mode: 0o600 });
      return { enrolled: true, weak };
    },
    /** Whether `approval` is the person's proof of exactly `text`: signed by the enrolled key, for this Host, accepted, and not run out. Never throws. @param {string} text @param {unknown} approval */
    verify(text, approval) {
      const key = enrolled();
      if (!key) return false;
      const parts = text.split('|');
      const until = Number(parts[AT.notAfter]);
      if (parts.length !== AT.parts || parts[AT.tag] !== APPROVAL_TAG || parts[AT.host] !== hostId() || parts[AT.accepted] !== '1')
        return false;
      if (!Number.isFinite(until) || until < now() || until > now() + NOT_AFTER_MS + SKEW_MS) return false;
      return signs(keyOf(key.key), text, /** @type {{ sig?: unknown } | null} */ (approval)?.sig);
    },
    /**
     * Whether a controller's record carries the person's proof: the text names this Host and the record's own key, was accepted, and is signed by the enrolled key (when it ran out is no concern: it was good when it was given).
     * @param {{ key: string, name: string, link?: string, approval?: { text?: unknown, sig?: unknown } }} record the record, with its key as base64 SPKI DER
     */
    verifyRecord(record) {
      const key = enrolled();
      const { text, sig } = record.approval ?? {};
      if (!key || typeof text !== 'string') return false;
      const parts = text.split('|');
      const raw = Buffer.from(String(record.key), 'base64').subarray(-32).toString('hex');
      if (
        parts.length !== AT.parts ||
        parts[AT.tag] !== APPROVAL_TAG ||
        parts[AT.host] !== hostId() ||
        parts[AT.peer] !== raw ||
        parts[AT.accepted] !== '1'
      )
        return false;
      // the record's own fields are what was signed: a renamed record, or one pointed at another relay link, is not the person's
      if (parts[AT.name] !== sha256(String(record.name)) || parts[AT.link] !== (record.link ?? '')) return false;
      return signs(keyOf(key.key), text, sig);
    },
  };
}
