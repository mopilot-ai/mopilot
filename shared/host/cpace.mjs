// The public door of CPace (draft-irtf-cfrg-cpace-20, CPACE-RISTR255-SHA512, initiator-responder; the whole of it is in shared/host/cpaceInternal.mjs, which only this file and its tests may import). What a caller can do here and no more: start a run as the initiator or the responder with the OS CSPRNG (no replacement of the random source, no scalar in or out), get the run's ISK, and exchange the two confirmation tags of draft section 9.4, each direction checked by its own function. No function here returns K or a scalar, and a tag can only be checked as the other side's, over the other side's message. See the internal file's header for the library facts and the must-not list every caller is held to.
import { randomBytes } from '@noble/hashes/utils';
import {
  CPACE_SPEC,
  CpaceAbort,
  confirmationKey,
  confirmationTag,
  initiateWith,
  lvCat,
  prependLen,
  respondWith,
  sidOutput,
  verifyTag,
} from './cpaceInternal.mjs';

export { CPACE_SPEC, CpaceAbort, lvCat, prependLen };

/** @typedef {import('./cpaceInternal.mjs').Run} Run */

/**
 * The initiator's first step: the message `{ Y, ad }` to send, and `finish(peerMessage)`, to call once, for the run.
 * @param {{ prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, ad: Uint8Array }} inputs
 */
export const initiate = ({ prs, ci, sid, ad }) => initiateWith(randomBytes, { prs, ci, sid, ad });

/**
 * The responder's whole run: the message to send back and the run, from the initiator's message.
 * @param {{ prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, ad: Uint8Array }} inputs @param {{ Y: Uint8Array, ad: Uint8Array }} peer
 */
export const respond = ({ prs, ci, sid, ad }, peer) => respondWith(randomBytes, { prs, ci, sid, ad }, peer);

/** The tag this side sends over the message it sent (draft 9.4). The responder sends its tag first; the initiator sends its own only after `verifyPeerConfirmation` accepted the responder's. @param {Run} run */
export const ownConfirmation = (run) => confirmationTag(confirmationKey(run.sid, run.isk), run.own.Y, run.own.ad);

/** Whether `tag` is the one the other side's message makes: only that, in constant time. This side's own tag, sent back, is refused. @param {Run} run @param {Uint8Array} tag */
export const verifyPeerConfirmation = (run, tag) => verifyTag(confirmationKey(run.sid, run.isk), run.peer.Y, run.peer.ad, tag);

/** The labelled hash of the run's whole transcript, H("CPaceSidOutput" || transcript) (draft 9.6): both sides get the same 64 bytes, and nothing else of the run is needed to bind a later key or a displayed number to it. @param {Run} run */
export const sessionIdOf = (run) => sidOutput(run.transcript);
