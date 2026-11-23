// The test machine's harness results as a plain-text section of "Copy diagnostics" (Settings → About), for support
// only: each version contract run (result, what was found, the fix issue) and each basic harness's admission there. The
// sentences come from the generated matrix (scripts/gen-matrix.mjs, tests/conformance/results/contract-findings.json).
import { ownTable } from '../../shared/ownTable.mjs';
import type { Matrix, MatrixBasic, MatrixContract, MatrixFinding } from './compat';

/** What a run's verdict reads as. */
export const CONTRACT_TEXT: Record<MatrixContract['verdict'], string> = ownTable({
  pass: 'passed',
  fail: 'problems found',
  incomplete: 'not finished',
});

/** One finding: what was found, then its open issue, or the fix that landed and still waits for a re-check. */
const findingLine = (f: MatrixFinding) =>
  `${f.says} (${f.issue !== undefined ? `#${f.issue}` : `fixed in #${f.fixedBy}, re-check pending`}${f.known ? '; also in earlier versions' : ''})`;

/** One run: its result, then each finding on its own line (new before known, open before fixed). An unfinished run claims nothing: only why it stopped. */
export function contractLines(r: MatrixContract): string[] {
  const head = `  ${r.label} ${r.version}: ${CONTRACT_TEXT[r.verdict]}`;
  if (r.verdict === 'incomplete') return [r.incomplete.length ? `${head} (${r.incomplete.join('; ')})` : head];
  const rank = (f: MatrixFinding) => (f.known ? 2 : 0) + (f.issue === undefined ? 1 : 0);
  return [head, ...[...(r.found ?? [])].sort((a, b) => rank(a) - rank(b)).map((f) => `    - ${findingLine(f)}`)];
}

/** One basic harness as the test machine saw it: works (and what it lacks), not checked (and why), or doesn't work. */
export function basicLine(b: MatrixBasic): string {
  const head = `  ${b.label} ${b.probedVersion ?? '(no version)'}`;
  switch (b.admission) {
    case 'admitted': {
      const lacks = [b.imagePrompts === false && 'images', b.sageTools === 'no hello' && 'MoPilot tools'].filter(Boolean);
      return `${head}: works${lacks.length ? `; not supported: ${lacks.join(', ')}` : ''}`;
    }
    case 'signin':
      return `${head}: not checked (no login on the test machine)`;
    case 'unsupported':
      return `${head}: doesn't work${b.reason ? ` (${b.reason})` : ''}`;
    default:
      return `${head}: not checked (not on the test machine)`;
  }
}

/** The section appended to "Copy diagnostics". */
export function harnessChecksText(m: Pick<Matrix, 'contracts' | 'basic'>): string {
  const runs = m.contracts ?? [];
  return [
    "Harness checks (MoPilot's test machine; these versions, not this Mac)",
    ...(runs.length ? runs.flatMap(contractLines) : ['  No version has been checked yet.']),
    'Basic harnesses on the test machine',
    ...m.basic.map(basicLine),
  ].join('\n');
}
