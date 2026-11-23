// Known problems with a harness version: a short, curated list of user-facing failures MoPilot's version contract
// found (tests/conformance/results/contract, summarized in matrix.generated.json by scripts/gen-matrix.mjs), each
// with what breaks and how to get out. A harness row shows an entry only while the version on this Mac is in its range
// and no contract run on that exact version passed its rows. MoPilot-side fixes and probe changes don't belong here.
import { compareVersions, MATRIX, type Matrix } from './compat';

export interface KnownIssue {
  /** 'codex', 'claude' or 'acp:<id>' */
  kind: string;
  /** the versions it affects: from `from` (inclusive, open when absent) up to `below` (exclusive, open when absent) */
  versions: { from?: string; below?: string };
  /** what breaks, in the user's words ("may skip the confirmation for payments inside embedded checkout forms") */
  text: string;
  /** the first version that fixes it, or null while none does */
  fixedIn: string | null;
  /** the issue that tracks it */
  issue: string;
  /** the version contract rows (CM ids) that show it */
  rows: string[];
}

/** Curated by hand from the contract results; empty while no failure is the harness version's to fix. */
export const KNOWN_ISSUES: readonly KnownIssue[] = [];

/** A version string the comparison can read ("2.1.302", "0.163.0-alpha.10.2", "v1.2"). */
const readable = (v: string) => /^v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(v.trim());

const inRange = (v: string, { from, below }: KnownIssue['versions']) =>
  (!from || compareVersions(v, from) >= 0) && (!below || compareVersions(v, below) < 0);

/** A contract run on exactly this version that passed every row the entry names: newer evidence than the entry. */
function passedSince(issue: KnownIssue, version: string, contracts: Matrix['contracts']) {
  const run = contracts?.find((c) => c.kind === issue.kind && compareVersions(c.version, version) === 0);
  return !!run && run.verdict !== 'incomplete' && !issue.rows.some((r) => run.failingRows.includes(r));
}

/** The known problem with the version of `kind` installed here, or null. */
export function knownIssueFor(
  kind: string,
  version: string | null | undefined,
  list: readonly KnownIssue[] = KNOWN_ISSUES,
  contracts: Matrix['contracts'] = MATRIX.contracts,
): KnownIssue | null {
  if (!version || !readable(version)) return null;
  return (
    list.find(
      (i) =>
        i.kind === kind &&
        inRange(version, i.versions) &&
        !(i.fixedIn && compareVersions(version, i.fixedIn) >= 0) &&
        !passedSince(i, version, contracts),
    ) ?? null
  );
}

/** How to get out of it: update to the fixed version, or which version to use, or that no fix exists yet. */
export function knownIssueExit(issue: KnownIssue, label: string, canUpdateTo: string | null): string {
  if (issue.fixedIn && canUpdateTo && compareVersions(canUpdateTo, issue.fixedIn) >= 0) return `Update to ${canUpdateTo} to fix it.`;
  if (issue.fixedIn) return `Use ${label} ${issue.fixedIn} or newer to fix it.`;
  return issue.versions.from ? `Use a version before ${issue.versions.from} until it is fixed.` : 'There is no fix yet.';
}
