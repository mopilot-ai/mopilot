// Types for code review findings shared by main and renderer.
export interface ReviewFinding {
  /** as the review named it: repository-relative (Claude Code) or absolute (Codex) */
  file: string;
  line: number | null;
  endLine?: number;
  /** one sentence: the defect */
  summary: string;
  /** the row's label */
  shortSummary?: string;
  /** concrete inputs or state and the wrong result */
  failureScenario?: string;
  /** a kind ("correctness") or a priority ("P1") */
  category?: string;
  /** CONFIRMED or PLAUSIBLE, when a verify pass ran */
  verdict?: string;
  /** fixed, skipped or no_change_needed, when findings are reported again after fixes */
  outcome?: string;
}
/** open, fixing (a fix was asked), addressed (fixed, or needed no change), dismissed (in the diff) */
export type FindingStatus = 'open' | 'fixing' | 'addressed' | 'dismissed';
export function reportedFindings(input: unknown): { level: string | null; findings: ReviewFinding[] };
export function findingLocation(f: ReviewFinding): string;
export function isReReport(findings: ReviewFinding[]): boolean;
export function rowLabel(f: ReviewFinding): string;
export function scenarioOf(f: ReviewFinding): string | undefined;
export function findingsMarkdown(findings: ReviewFinding[]): string;
export function parseCodexReview(text: string): { intro: string; findings: ReviewFinding[] } | null;
export function reviewFindingsOf(item: {
  review?: unknown;
  findings?: unknown;
  level?: unknown;
}): { intro: string; level: string | null; findings: ReviewFinding[] } | null;
export function applyFixesRequest(findings: ReviewFinding[], opts: { reportTool: boolean }): string;
export function isFixRequest(text: string): boolean;
export function fixRequestFindings(text: string, findings: ReviewFinding[]): number[];
export const APPLY_REVIEW_REQUEST: string;
export function findingStatuses(
  findings: ReviewFinding[],
  state?: {
    stored?: Record<number, FindingStatus>;
    reReports?: { findings: ReviewFinding[]; afterFix: boolean }[];
    fix?: { ended: boolean; ok: boolean; reported: boolean } | null;
  },
): FindingStatus[];
export function outcomeSummary(findings: ReviewFinding[]): string | null;
export function categoryLabel(category: string): string;
export function findingsByFile(findings: ReviewFinding[]): { file: string; rows: { finding: ReviewFinding; index: number }[] }[];
