// Pairing another Mac to this Host by an 8-character code, the controlled Mac's side (R2b of #5576, slice 1b; design on the issue): an offer at the relay, a code shown, the four messages of shared/host/codePair.mjs run as the other Mac types the code, and a `controller` added only when the person allowed it with a proof that no process of this OS user can make alone. The 5-character secret lives in this process's memory and nowhere else; each offer has one durable run budget (./codePairBudgets.mjs); an offer belongs to the connection that made it (its events go there, only it may answer, and it ends with it).
import { CodePairError, createResponder, formatCode, newSecret } from '../../shared/host/codePair.mjs';
import { clientNameOf } from '../../shared/host/clients.mjs';
import { parseParams } from '../../shared/host/schema.mjs';
import { approvalTextFrom, carryHashOf, NOT_AFTER_MS } from './codePairApproval.mjs';
import { HostRefusal } from './hostFs.mjs';

/** The most offers open at once on one Host (the relay allows an account three), and the most one Host makes in an hour (the relay allows a caller ten). */
export const MAX_OPEN = 3;
export const MAX_PER_HOUR = 10;
/** How often an open offer is read at the relay (the relay answers a mailbox eight times a second at most), and how long a person has to answer once the other Mac proved the code. */
export const POLL_MS = 500;
export const CONFIRM_MS = 2 * 60_000;
/** How long the other Mac has to prove the code once the Host answered its first message: a Mac that typed a wrong code stops there (it cannot verify the Host's tag) and says nothing, so silence is the failure. */
export const PROVE_MS = 30_000;
/** How long the check of the person's proof may take: it is a signature check on this machine, so a verifier that has not answered by now is no proof. */
export const VERIFY_MS = 5_000;
const HOUR_MS = 3_600_000;
/** What a Host that cannot take the person's proof says, by the reason (the app turns it into one sentence and the fix in place). */
const UNAVAILABLE = {
  no_approval_helper: 'Set up pairing by code in MoPilot on this Mac first.',
  unsupported_platform: 'Pairing by code is available on Macs.',
};
/** How long the relay's offer is kept after the last message (the answer) is sent: the other Mac reads it from the same mailbox, and the relay forgets everything of an offer that is closed. */
export const LINGER_MS = 30_000;

/** The name as the controller's record stores it, and as the proof names it: cleaned the way every client's name is (control characters, trim, 80 UTF-16 units), then without a half of a character the 80 units cut (a lone surrogate would hash differently in every language), cleaned again so the result is its own fixed point. @param {string} name */
export const approvedNameOf = (name) => clientNameOf(clientNameOf(name).replace(/[\ud800-\udbff]$/, ''));

/** The Ed25519 public key as the base64 SPKI DER the Host's client table holds. @param {Uint8Array} raw */
const spkiOf = (raw) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]).toString('base64');

/**
 * @typedef {{ id: string, hint: string, secret: string, ticket: string, base: string, expiresAt: number, owner: object, emit: (m: object) => unknown, phase: string, claims: number, after: number, stage: number, responder: any, seen: any, timer: any, confirmTimer: any, approvalText: string | null, done: boolean }} Offer
 */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./rendezvousClient.mjs').createRendezvousClient>} o.relay the relay's rendezvous
 * @param {ReturnType<typeof import('../../shared/remote/crypto.mjs').createCrypto>} o.crypto
 * @param {{ pub: Uint8Array, name: string, sign: (m: Uint8Array) => Uint8Array }} o.device this Host's device key for the proofs of the protocol
 * @param {ReturnType<typeof import('./codePairBudgets.mjs').createCodePairBudgets>} o.budgets
 * @param {{ allowsClient: (kind: 'controller') => boolean }} o.policy managed policy: an organization may forbid controllers
 * @param {{ add: (key: string, o: { name: string, kind: 'controller', addedBy: string, link?: string, approval?: { text: string, sig: string } }) => string, remove: (fingerprint: string) => boolean }} o.pairing the client table
 * @param {(params: object) => object} o.enroll the Host's relay links: takes the credential the other Mac minted, answers this Host's half of the pair
 * @param {(p: { hostId: string }) => unknown} o.forget takes a relay link back (a pairing that failed after it was enrolled)
 * @param {() => boolean} o.open whether this Host accepts connections at all ("Allow connections"): a Host that does not makes no code
 * @param {{ status: () => { available: boolean, reason?: string, weak?: boolean }, hostId: () => string, verify?: (text: string, approval: unknown) => Promise<boolean> | boolean, enrol?: (p: { key: string, weak: boolean, signature: string }) => object }} o.approvals the person's own proof (./codePairApproval.mjs): whether a pairing can be accepted here at all, this Host's name, and whether a signature is the person's proof of exactly the text the Host made (a signature only the app's native helper makes, after Touch ID or the password); without `verify` no pairing is ever accepted
 * @param {(e: object) => void} [o.audit] @param {(m: string) => void} [o.report]
 * @param {() => number} [o.now] @param {(fn: () => void, ms: number) => any} [o.setTimer] @param {(n: number) => Uint8Array} [o.random]
 */
export function createCodePairService({
  relay,
  crypto,
  device,
  budgets,
  policy,
  pairing,
  enroll,
  forget,
  open,
  approvals,
  audit = () => undefined,
  report = () => undefined,
  now = Date.now,
  setTimer = setTimeout,
  random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
}) {
  /** @type {Map<string, Offer>} */
  const offers = new Map();
  /** When this Host made each offer of the last hour. @type {number[]} */
  let made = [];
  const refuse = (/** @type {string} */ code, /** @type {string} */ message) => new HostRefusal(code, message);
  /** A timer that never keeps the Host's process alive. @param {() => void} fn @param {number} ms */
  const timer = (fn, ms) => {
    const t = setTimer(fn, ms);
    t?.unref?.();
    return t;
  };

  /** Tells the connection that made the offer. @param {Offer} o @param {string} phase @param {object} [more] */
  function tell(o, phase, more = {}) {
    o.phase = phase;
    try {
      o.emit({ event: 'codePair', offerId: o.id, phase, expiresAt: o.expiresAt, ...more });
    } catch (error) {
      report(`code pairing: ${error}`);
    }
  }

  /** Ends an offer for good: its timers stop, its secret is let go, and the relay is told (at once, or, when the last message is waiting there for the other Mac, after a short while). @param {Offer} o @param {string} phase @param {object} [more] @param {boolean} [linger] */
  function finish(o, phase, more = {}, linger = false) {
    if (o.done) return;
    o.done = true;
    clearTimeout(o.timer);
    clearTimeout(o.confirmTimer);
    o.responder = null;
    o.seen = null;
    o.secret = '';
    offers.delete(o.id);
    tell(o, phase, more);
    const close = () => void relay.close({ base: o.base, id: o.id, ticket: o.ticket });
    if (linger) timer(close, LINGER_MS);
    else close();
  }

  /** What the person is told when a run ends badly: the neutral words, nothing of how close the code was. @param {Offer} o @param {unknown} error */
  function runFailed(o, error) {
    // every failure of a run is a CodePairError (the protocol wraps what it cannot name); anything else has no code and is a failed run too
    const code = /** @type {{ code?: string }} */ (error).code;
    o.responder = null;
    o.seen = null;
    clearTimeout(o.confirmTimer);
    if (code === 'unrecorded') return finish(o, 'failed', { code });
    if (code === 'burned' || budgets.burned(o.id)) return finish(o, 'used_up');
    tell(o, 'waiting', { retry: true });
  }

  /** @param {Offer} o @param {string} box */
  async function send(o, box) {
    const r = await relay.send({ base: o.base, id: o.id, ticket: o.ticket, claims: o.claims, box });
    if (!r.ok) throw new CodePairError('bad_message', `The relay did not take the message: ${r.reason}`);
  }

  /** The run is stalled: no proof came (the other Mac typed a wrong code, or left). @param {Offer} o */
  function stalled(o) {
    if (!o.done && o.phase === 'proving') runFailed(o, new CodePairError('bad_confirmation', 'No proof of the code came.'));
  }

  /** One message of the run, by its place. @param {Offer} o @param {string} box */
  async function step(o, box) {
    if (o.stage === 0) {
      o.stage = 1;
      await send(o, o.responder.receive(box));
      tell(o, 'proving');
      o.confirmTimer = timer(() => stalled(o), PROVE_MS);
    } else if (o.stage === 1) {
      o.stage = 2;
      clearTimeout(o.confirmTimer);
      const seen = o.responder.receive3(box);
      o.seen = seen;
      // the other Mac knew the code: the person is asked, and a pairing nobody answers is a refusal
      arm(o);
      tell(o, 'confirm', { name: seen.peerName, safety: seen.safety, expiresInMs: CONFIRM_MS });
    }
  }

  /** One look at the offer's mailbox. @param {Offer} o */
  async function look(o) {
    try {
      if (now() >= o.expiresAt) return finish(o, 'expired');
      const r = await relay.read({ base: o.base, id: o.id, ticket: o.ticket, after: o.after });
      if (o.done) return;
      if (!r.ok) {
        if (r.reason === 'gone' || r.reason === 'no_such_code') return finish(o, 'expired');
        return;
      }
      if (r.claims > o.claims) {
        // another Mac typed the code: a new run starts (a run in progress is dropped, and the person is not asked about it)
        clearTimeout(o.confirmTimer);
        o.claims = r.claims;
        o.after = 0;
        o.stage = 0;
        o.seen = null;
        o.responder = null;
        try {
          o.responder = createResponder({
            crypto,
            secret: o.secret,
            hint: o.hint,
            rendezvousId: o.id,
            claims: o.claims,
            device,
            budget: budgets.forOffer(o.id),
          });
          tell(o, 'connecting');
        } catch (error) {
          return runFailed(o, error);
        }
      }
      for (const m of r.messages) {
        if (!o.responder || m.n <= o.after) continue;
        o.after = m.n;
        try {
          await step(o, m.box);
        } catch (error) {
          runFailed(o, error);
          break;
        }
      }
    } finally {
      if (!o.done) o.timer = timer(() => void look(o).catch((error) => report(`code pairing: ${error}`)), POLL_MS);
    }
  }

  /** The question is open again after an answer that could not be taken: the person may try again, say no, or let the clock say it. @param {Offer} o @param {string} code */
  function reopen(o, code) {
    const seen = /** @type {NonNullable<typeof o.seen>} */ (o.seen);
    tell(o, 'confirm', { name: seen.peerName, safety: seen.safety, error: code, expiresInMs: CONFIRM_MS });
    arm(o);
  }

  /** The clock's no for a question nobody answered. @param {Offer} o */
  function arm(o) {
    o.confirmTimer = timer(() => void answerNow(o, false).catch((error) => report(`code pairing: ${error}`)), CONFIRM_MS);
  }

  /** The no (the person's, the clock's, or a policy's): the other Mac is told it was denied, and the relay keeps the answer for it a little while. @param {Offer} o @param {string} [code] */
  async function deny(o, code) {
    const name = /** @type {NonNullable<typeof o.seen>} */ (o.seen).peerName;
    const { message } = o.responder.answer(false);
    await send(o, message).catch((error) => report(`code pairing: ${error}`));
    if (code) finish(o, 'failed', { code }, true);
    else {
      audit({ kind: 'code.refused', by: { fingerprint: '', name, kind: 'controller' } });
      finish(o, 'denied', {}, true);
    }
    return { accepted: false };
  }

  /**
   * The person's answer, or the clock's. One answer at a time: the phase is taken before anything is awaited, so a second answer, the clock, a cancel and a claim that comes in a gap each meet a phase that is not `confirm`; after the one await (the person's proof) the run is looked at again, and everything from there to the end of the Host's own steps is synchronous. The relay link is enrolled last, just before the controller is added, and taken back if anything after it fails.
   * @param {Offer} o @param {boolean} accept @param {unknown} [approval]
   */
  async function answerNow(o, accept, approval) {
    o.phase = 'answering';
    clearTimeout(o.confirmTimer);
    const seen = /** @type {NonNullable<typeof o.seen>} */ (o.seen);
    const { peerDevice, peerName, carry } = seen;
    if (!accept) return deny(o);
    // a pairing is accepted only when policy still lets this Host have a controller
    if (!policy.allowsClient('controller')) return deny(o, 'policy_refused');
    let credential;
    try {
      // what the other Mac chose is a relay credential and nothing else: the client a push would go to is this Host's to name, never the peer's
      const { client: _client, ...rest } = parseParams('host.relayEnroll', carry);
      credential = rest;
    } catch {
      reopen(o, 'bad_credential');
      throw refuse('bad_credential', 'The other Mac did not bring a credential this Host can use.');
    }
    /** @type {unknown} */
    let proof;
    /** @type {any} */
    let late;
    try {
      const asked = Promise.resolve(o.approvalText ? approvals.verify?.(o.approvalText, approval) : false);
      const slow = new Promise((resolve) => (late = timer(() => resolve('timed out'), VERIFY_MS)));
      proof = await Promise.race([asked, slow]);
      if (proof === 'timed out') report('code pairing: the check of the proof did not answer');
    } catch (error) {
      report(`code pairing: ${error}`);
    } finally {
      clearTimeout(late);
    }
    // ended, or another claim took the run, while the proof was awaited: nothing was enrolled, nothing is added
    if (o.done || o.seen !== seen) return { accepted: false };
    if (proof !== true) {
      reopen(o, 'approval_unavailable');
      throw refuse('approval_unavailable', 'This pairing was not allowed in person on this Mac.');
    }
    let enrolled;
    try {
      enrolled = enroll(credential);
    } catch {
      reopen(o, 'bad_credential');
      throw refuse('bad_credential', 'The other Mac did not bring a credential this Host can use.');
    }
    /** @type {string} */
    let fingerprint;
    /** @type {string} */
    let message;
    try {
      ({ message } = o.responder.answer(true, enrolled));
      fingerprint = pairing.add(spkiOf(peerDevice), {
        name: approvedNameOf(peerName),
        kind: 'controller',
        addedBy: 'code',
        link: credential.hostId,
        approval: { text: /** @type {string} */ (o.approvalText), sig: String(/** @type {{ sig?: unknown }} */ (approval).sig) },
      });
    } catch (error) {
      forget({ hostId: credential.hostId });
      finish(o, 'failed', { code: 'failed' });
      throw refuse('failed', `The pairing could not be made: ${error}`);
    }
    try {
      await send(o, message);
    } catch (error) {
      // the other Mac was not told: it is no controller, and the relay link it brought is gone with it
      pairing.remove(fingerprint);
      forget({ hostId: credential.hostId });
      finish(o, 'failed', { code: 'relay' });
      throw refuse('relay', `The other Mac could not be told: ${error}`);
    }
    finish(o, 'done', { fingerprint, name: peerName }, true);
    return { accepted: true, fingerprint };
  }

  return {
    /**
     * Makes an offer at the relay and answers the code to show. The offer belongs to the connection that made it.
     * @param {{ relayUrl: string, token: string }} p @param {{ owner: object, emit: (m: object) => unknown, ends?: Set<() => void> }} who
     */
    async offer({ relayUrl, token }, { owner, emit, ends }) {
      if (!open()) throw refuse('connections_off', 'Connections are off on this Mac.');
      const can = approvals.status();
      if (!can.available)
        throw refuse(
          /** @type {string} */ (can.reason),
          /** @type {Record<string, string>} */ (UNAVAILABLE)[/** @type {string} */ (can.reason)] ??
            'Pairing by code is not available here.',
        );
      if (!policy.allowsClient('controller'))
        throw refuse('policy_refused', 'Your organization does not allow another Mac to control this one.');
      if (budgets.pausedUntil() > 0) throw refuse('paused', 'Pairing by code is paused for a few minutes.');
      made = made.filter((t) => now() - t < HOUR_MS);
      if (offers.size >= MAX_OPEN || made.length >= MAX_PER_HOUR)
        throw refuse('limited', 'Too many codes were made. Try again in a few minutes.');
      made.push(now());
      const got = await relay.offer({ base: relayUrl, token });
      if (!got.ok) throw refuse(got.reason === 'unauthorized' ? 'unauthorized' : 'relay', `The relay did not make a code: ${got.reason}`);
      let budgetBurned = false;
      try {
        budgetBurned = budgets.forOffer(got.id).burned;
      } catch (error) {
        void relay.close({ base: relayUrl, id: got.id, ticket: got.ticket });
        throw refuse('relay', `The relay made an offer this Host cannot use: ${error}`);
      }
      if (budgetBurned) {
        void relay.close({ base: relayUrl, id: got.id, ticket: got.ticket });
        throw refuse('burned', 'That code was used up.');
      }
      /** @type {Offer} */
      const o = {
        id: got.id,
        hint: got.hint,
        secret: newSecret(random),
        ticket: got.ticket,
        base: relayUrl,
        expiresAt: got.expiresAt,
        owner,
        emit,
        phase: 'waiting',
        claims: 0,
        after: 0,
        stage: 0,
        responder: null,
        seen: null,
        timer: null,
        confirmTimer: null,
        approvalText: null,
        done: false,
      };
      offers.set(o.id, o);
      // the connection ending ends the offer, unless an answer is being taken (it completes, and nobody is told)
      ends?.add(() => (o.phase === 'answering' ? undefined : finish(o, 'cancelled')));
      o.timer = timer(() => void look(o).catch((error) => report(`code pairing: ${error}`)), POLL_MS);
      audit({ kind: 'code.offered', by: { fingerprint: '', name: '', kind: 'cli' } });
      return { offerId: o.id, code: formatCode(o.hint, o.secret), expiresAt: o.expiresAt };
    },
    /** @param {{ offerId: string, accept: boolean, approval?: unknown }} p @param {{ owner: object }} who */
    async answer({ offerId, accept, approval }, { owner }) {
      const o = offers.get(offerId);
      if (!o || o.owner !== owner) throw refuse('no_such_offer', 'That code is not open here.');
      if (o.phase !== 'confirm') throw refuse('not_asked', 'Nobody is waiting to be allowed.');
      return answerNow(o, accept, approval);
    },
    /**
     * The text the person approves, made now and for this question only (the helper signs it after the system's prompt; `answer` takes the signature). It names this Host, the offer, the number both Macs show, the other Mac's key and name, the credential it brought, and runs out in two minutes.
     * @param {{ offerId: string }} p @param {{ owner: object }} who
     */
    approvalText({ offerId }, { owner }) {
      const o = offers.get(offerId);
      if (!o || o.owner !== owner) throw refuse('no_such_offer', 'That code is not open here.');
      if (o.phase !== 'confirm') throw refuse('not_asked', 'Nobody is waiting to be allowed.');
      const { peerDevice, peerName, safety, carry } = /** @type {NonNullable<typeof o.seen>} */ (o.seen);
      const notAfter = now() + NOT_AFTER_MS;
      // the relay link the other Mac brought is part of what is allowed (and of the record kept), judged the way the answer judges it
      let link;
      try {
        link = parseParams('host.relayEnroll', carry).hostId;
      } catch {
        throw refuse('bad_credential', 'The other Mac did not bring a credential this Host can use.');
      }
      const fields = {
        hostId: approvals.hostId(),
        offerId,
        safety,
        peer: Buffer.from(peerDevice).toString('hex'),
        name: approvedNameOf(peerName),
        carryHash: carryHashOf(carry),
        link,
        notAfter,
        accepted: true,
      };
      o.approvalText = approvalTextFrom(fields);
      // the helper takes the fields, builds the prompt and this text itself, and signs only that
      return { text: o.approvalText, notAfter, fields };
    },
    /** @param {{ offerId: string }} p @param {{ owner: object }} who */
    cancel({ offerId }, { owner }) {
      const o = offers.get(offerId);
      // an answer that is being taken is not cancelled: it ends as done or failed
      if (!o || o.owner !== owner || o.phase === 'answering') return { cancelled: false };
      finish(o, 'cancelled');
      return { cancelled: true };
    },
    /** What this connection's offers are doing (never a code). @param {{ owner: object }} who */
    status({ owner }) {
      return {
        approval: approvals.status(),
        paused: budgets.pausedUntil() > 0,
        offers: [...offers.values()]
          .filter((o) => o.owner === owner)
          .map((o) => ({ offerId: o.id, phase: o.phase, expiresAt: o.expiresAt })),
      };
    },
    /** Keeps the helper's approval key (once, with its proof of holding it): the method of the CLI that runs the helper. @param {{ key: string, weak: boolean, signature: string }} p */
    enrol: (p) => {
      if (!approvals.enrol) throw refuse('no_approval_helper', UNAVAILABLE.no_approval_helper);
      return approvals.enrol(p);
    },
    /** Ends every offer at once (the Host is stopping): the relay is told, no timer is left. */
    close() {
      for (const o of [...offers.values()]) finish(o, 'cancelled');
    },
    /** How many offers are open (for tests and the Host's status). */
    open: () => offers.size,
  };
}
