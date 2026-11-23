// Data behind the harness pages and the harness checks in Copy diagnostics: the generated matrix
// (scripts/gen-matrix.mjs writes matrix.generated.json from the registry, the bindings, the conformance and contract
// results) and the version
// policy the page applies to an installed CLI: above min and not known bad works as usual, and shows
// "unverified" when that exact version was never run through conformance.
import raw from './matrix.generated.json' with { type: 'json' };
import type { HarnessKind } from './adapter';
import { compareVersions as versionOrder } from '../../shared/semver.mjs';

export interface MatrixCell {
  via: 'rpc' | 'passthrough' | 'config' | 'polyfill' | 'route' | 'none';
  /** the method, template, option or engine; for none the Why code */
  detail: string;
  /** what controls the entry: the harness, MoPilot, or the other harness for a route; "-" for none */
  source: string;
  /** conformance checks behind it ("C4 partial, C17 pass") */
  verified: string;
  /** none only: the line the app shows */
  why?: string;
}
export interface MatrixRow {
  semantic: string;
  label: string;
  codex: MatrixCell;
  claude: MatrixCell;
}
export interface MatrixBasic {
  id: string;
  label: string;
  vendor: string;
  probedVersion: string | null;
  /** the version the harness reports about itself, which is what the app sees; not always its package version */
  agentVersion?: string | null;
  verified: string;
  admission: string;
  reason: string | null;
  initialize?: string;
  imagePrompts?: boolean | null;
  privacyGate?: string;
  sageTools?: string;
}
/** A failing contract item in plain words (tests/conformance/results/contract-findings.json): its open issue, or the pull request that fixed it. */
export interface MatrixFinding {
  key: string;
  says: string;
  issue?: number;
  fixedBy?: number;
  /** failed in the baseline version too */
  known?: boolean;
}
/** One harness version contract run (bench/contract-run.mjs), as tests/conformance/results/contract/ holds it. */
export interface MatrixContract {
  kind: HarnessKind;
  label: string;
  version: string;
  verdict: 'pass' | 'fail' | 'incomplete';
  date: string;
  regressions: number;
  known: number;
  failingRows: string[];
  /** what failed, in plain words */
  found?: MatrixFinding[];
  /** why the run claims nothing, when incomplete */
  incomplete: string[];
}
export interface Matrix {
  semantics: MatrixRow[];
  basic: MatrixBasic[];
  /** newest first; empty until the VM has run a contract */
  contracts?: MatrixContract[];
}
export const MATRIX = raw as unknown as Matrix;

/** The shared ordering policy, preserving the renderer's string-only public signature. */
export const compareVersions: (a: string, b: string) => number = versionOrder;

export type CompatStatus = 'tested' | 'unverified' | 'tooOld' | 'knownBad';
export function compatStatus(v: { min: string; knownBad: string[]; tested: string[] }, version: string): CompatStatus {
  // equal as versions, as main's versionStatus has it ('v2.1.295' is 2.1.295)
  const listed = (list: string[]) => list.some((x) => compareVersions(x, version) === 0);
  if (listed(v.knownBad)) return 'knownBad';
  if (compareVersions(version, v.min) < 0) return 'tooOld';
  return listed(v.tested) ? 'tested' : 'unverified';
}

export const COMPAT_TEXT: Record<CompatStatus, [label: string, tone: string, detail: string]> = {
  tested: ['Tested with MoPilot', 'ok', 'MoPilot checked this exact version before marking it tested'],
  unverified: [
    'Not yet tested',
    '',
    'Newer than the versions MoPilot has checked. It works as usual; only a feature whose check fails is turned off, with the reason',
  ],
  tooOld: ['Not supported', 'err', 'Older than the oldest version MoPilot works with'],
  knownBad: ['Not supported', 'err', 'This version is known to break something MoPilot relies on'],
};

/** What a harness page's header says about the installed version: nothing while it is fine, else why it is not, in one
 * sentence (the update under it is the way out; #3518). */
export function versionWarning(versions: { min: string; knownBad: string[]; tested: string[] } | null | undefined, version: string | null) {
  if (!versions || !version) return null;
  const st = compatStatus(versions, version);
  if (st === 'tooOld') return `Version ${version} is too old for MoPilot.`;
  return st === 'knownBad' ? `Version ${version} has a known problem with MoPilot.` : null;
}
