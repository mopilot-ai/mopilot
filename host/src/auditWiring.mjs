// The audit record as the Host's CLI builds it (./audit.mjs): its settings and the generation each line names come from the policy, which is made after it, so they are read through a getter.
import { createAudit } from './audit.mjs';

/**
 * What the pairing tells the audit record: a controller's connection is a governed line (with `audit.required`, a line that cannot be written ends the connection), everything else a note.
 * @param {{ note: (e: any) => void, governed: (e: any) => boolean }} audit
 */
export const pairingAuditOf = (audit) => (/** @type {{ kind: string }} */ e) =>
  e.kind === 'controller.connected' ? audit.governed(e) : audit.note(e);

/** @param {{ dataDir: string, report: (m: string) => void, policy: () => ReturnType<typeof import('./policy.mjs').createPolicy> }} o */
export function auditFor({ dataDir, report, policy }) {
  return createAudit({
    dir: `${dataDir}/audit`,
    settings: () => policy().auditSettings(),
    generation: () => policy().generation(),
    report,
  });
}
