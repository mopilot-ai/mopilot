// The audit record as the Host's CLI builds it (./audit.mjs): its settings and the generation each line names come from the policy, which is made after it, so they are read through a getter.
import { createAudit } from './audit.mjs';

/** @param {{ dataDir: string, report: (m: string) => void, policy: () => ReturnType<typeof import('./policy.mjs').createPolicy> }} o */
export function auditFor({ dataDir, report, policy }) {
  return createAudit({
    dir: `${dataDir}/audit`,
    settings: () => policy().auditSettings(),
    generation: () => policy().generation(),
    report,
  });
}
