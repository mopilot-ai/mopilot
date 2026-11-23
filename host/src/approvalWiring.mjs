// The approval engine as the Host protocol builds it (./approvals.mjs): its ports (the chat's record, state lane, Stop and epoch), and the release of a chat's cards when it moves to another owner.
import { createApprovals } from './approvals.mjs';

/** The owner's clock: the effective policy's reminder and pause (U2), read as each card opens, so a policy sent meanwhile governs the next card. @param {{ approvalSettings: () => { approvals: { remindMinutes: number, pauseMinutes: number } } }} policy */
const policyTimes = (policy) => () => {
  const { approvals } = policy.approvalSettings();
  return { remindMs: approvals.remindMinutes * 60_000, pauseMs: approvals.pauseMinutes * 60_000 };
};

/**
 * @param {object} o
 * @param {(chatId: string, event: object) => void} o.record
 * @param {{ state: (chatId: string, patch: Record<string, unknown>) => unknown, current: (chatId: string) => Record<string, any> }} o.hub
 * @param {{ host: { cancel: (chatId: string) => unknown } }} o.runtime
 * @param {{ current: (chatId: string) => number, onAdvance: (fn: (chatId: string) => void) => unknown }} o.epochs
 * @param {(chatId: string) => string} o.familyOf
 * @param {(message: string) => void} o.report
 * @param {(chatId: string) => unknown} o.skipped a `skip` run stopped at a card (U3)
 * @param {{ notify?: Parameters<typeof createApprovals>[0]['notify'], approvalTimes?: () => { remindMs: number, pauseMs: number }, approvalClock?: { now?: () => number, after?: (fn: () => void, ms: number) => () => void }, audit?: { governed: (e: any) => boolean, note: (e: any) => void }, policy?: { approvalSettings: () => { approvals: { remindMinutes: number, pauseMinutes: number } } } }} [ports] the push port, the owner's clock (`approvalTimes`, else the effective policy's) and the tests' time
 */
export function approvalsFor(
  { record, hub, runtime, epochs, familyOf, report, skipped },
  { notify, approvalTimes, approvalClock, audit, policy } = {},
) {
  const approvals = createApprovals({
    record: (chatId, event) => record(chatId, event),
    state: (chatId, patch) => hub.state(chatId, patch),
    stop: (chatId) => runtime.host.cancel(chatId),
    epochOf: (chatId) => epochs.current(chatId),
    familyOf,
    saved: (chatId) => hub.current(chatId),
    report,
    skipped,
    ...(notify ? { notify } : {}),
    ...(audit ? { audit } : {}),
    ...(approvalTimes || policy ? { times: approvalTimes ?? policyTimes(/** @type {NonNullable<typeof policy>} */ (policy)) } : {}),
    ...approvalClock,
  });
  // a chat that moves to another owner keeps no card of this Host's
  epochs.onAdvance((chatId) => approvals.forget(chatId));
  return approvals;
}
