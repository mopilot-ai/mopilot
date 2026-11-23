// GitHub check-rollup decoding and the sidebar's PR lifecycle, health and readiness presentation.
import type { ThreadPullRequest } from './threadPullRequest';

export interface PullRequestDetails {
  checks: 'none' | 'passing' | 'pending' | 'failing' | 'unknown';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;
  /** something will merge it without the user: GitHub auto-merge is armed, or it carries a landing label */
  landing?: true;
  /** its author holds it back with a hold label: nobody, the user included, should merge it yet */
  held?: true;
  /** where the merge robot has it, from its own commit status (GATE_STATUS), when it posts one */
  gate?: PullRequestGate;
  /** the robot's status is unsettled but its words couldn't be read: where it has the PR is not known this read */
  gateUnread?: true;
  /** GitHub asks the signed-in user to review it */
  review?: true;
}

/**
 * The commit status this repository's merge gate and train post on a PR (scripts/merge-on-green.mjs,
 * scripts/merge-train.mjs): where the PR stands in landing, never one of its checks.
 */
export const GATE_STATUS = 'merge-on-green';

/** Where the merge robot has a PR: in a train with others, held (and why), its train failed, or its merge failed. */
export type PullRequestGate =
  | { at: 'train'; others: number }
  | { at: 'held'; why: 'red' | 'unverified' | 'other'; text: string }
  | { at: 'failed' }
  | { at: 'stuck'; text: string };

/** The gate status's state and words as a place; null for one that says nothing to show (landed, or not yet read). */
export function gateOf(status: Record<string, unknown>): PullRequestGate | null {
  const state = typeof status.state === 'string' ? status.state.toUpperCase() : '';
  const text = typeof status.description === 'string' ? status.description : '';
  if (state === 'PENDING' && text.startsWith('In the merge train'))
    return { at: 'train', others: Math.max(0, (text.match(/#\d+/g)?.length ?? 1) - 1) };
  if (state === 'PENDING' && text.startsWith('Held: ')) {
    const why = /main is red/.test(text) ? 'red' : /Verified the fix/.test(text) ? 'unverified' : 'other';
    return { at: 'held', why, text: text.slice('Held: '.length) };
  }
  if (state === 'FAILURE' || state === 'ERROR')
    return text.startsWith('Tests passed but the merge failed') ? { at: 'stuck', text } : { at: 'failed' };
  return null;
}

const isGate = (c: unknown) => !!c && typeof c === 'object' && (c as Record<string, unknown>).context === GATE_STATUS;
/** Labels that hand a PR to a merge robot (this repository's merge train), so it lands with no one's click. */
export const LANDING_LABELS: ReadonlySet<string> = new Set(['merge-on-green']);

/** Labels that hold a PR back from merging (scripts/auto-merge.mjs HOLD_LABEL): it is not ready, whatever GitHub says. */
export const HOLD_LABELS: ReadonlySet<string> = new Set(['do-not-merge']);

const labelled = (pr: Record<string, unknown>, names: ReadonlySet<string>) =>
  Array.isArray(pr.labels) && pr.labels.some((l) => !!l && typeof l === 'object' && names.has((l as { name?: unknown }).name as string));

function lands(pr: Record<string, unknown>): boolean {
  if (pr.autoMergeRequest && typeof pr.autoMergeRequest === 'object') return true;
  return labelled(pr, LANDING_LABELS);
}
export type PullRequestIndicator = ThreadPullRequest['state'] | 'failing' | 'in_progress' | 'successful' | 'ready';
const failed = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const pending = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING', 'EXPECTED']);
const passed = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function checkState(value: unknown): PullRequestDetails['checks'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const check = value as Record<string, unknown>;
  if (check.__typename === 'CheckRun') {
    if (typeof check.status !== 'string') return 'unknown';
    if (pending.has(check.status)) return 'pending';
    if (check.status !== 'COMPLETED' || typeof check.conclusion !== 'string') return 'unknown';
    if (failed.has(check.conclusion)) return 'failing';
    return passed.has(check.conclusion) ? 'passing' : 'unknown';
  }
  if (check.__typename !== 'StatusContext' || typeof check.state !== 'string') return 'unknown';
  if (failed.has(check.state)) return 'failing';
  if (pending.has(check.state)) return 'pending';
  return check.state === 'SUCCESS' ? 'passing' : 'unknown';
}

/** Missing or unrecognized checks must never count as a green result. */
/**
 * `viewer`: the signed-in GitHub login, for review requests. `gateStatus`: the gate status read with its words (the
 * commit statuses API; the rollup gives its state only), in place of the rollup's.
 */
export function pullRequestDetails(
  pr: Record<string, unknown>,
  {
    viewer = null,
    gateStatus = null,
    gateUnread = false,
  }: { viewer?: string | null; gateStatus?: Record<string, unknown> | null; gateUnread?: boolean } = {},
): PullRequestDetails | undefined {
  if (!('statusCheckRollup' in pr || 'mergeable' in pr || 'mergeStateStatus' in pr)) return undefined;
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : null;
  // the merge robot's status says where the PR stands, not whether it works: it is never a check
  const checks = rollup ? rollup.filter((c) => !isGate(c)).map(checkState) : ['unknown'];
  const rolled = rollup?.find(isGate) as Record<string, unknown> | undefined;
  const gate = rolled ? gateOf(gateStatus ?? rolled) : null;
  const review =
    !!viewer &&
    Array.isArray(pr.reviewRequests) &&
    pr.reviewRequests.some((q) => !!q && typeof q === 'object' && (q as { login?: unknown }).login === viewer);
  return {
    checks: checks.includes('failing')
      ? 'failing'
      : checks.includes('unknown')
        ? 'unknown'
        : checks.includes('pending')
          ? 'pending'
          : checks.length
            ? 'passing'
            : 'none',
    mergeable: pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN',
    mergeState: typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : 'UNKNOWN',
    ...(lands(pr) ? { landing: true as const } : {}),
    ...(labelled(pr, HOLD_LABELS) ? { held: true as const } : {}),
    ...(gate ? { gate } : {}),
    ...(gateUnread && rolled ? { gateUnread: true as const } : {}),
    ...(review ? { review: true as const } : {}),
  };
}

/**
 * The badge's corner dot: a solid dot is the checks' state, a ring a merge that waits on something besides them, so no
 * two states draw the same mark (src/styles/app/sidebar.css styles each).
 */
export type PullRequestDot = 'ready' | 'passing' | 'pending' | 'waiting' | 'failing' | 'conflict' | 'unknown';

/** Terminal lifecycle wins over old check results; reported lifecycle never invents check health. A draft's checks still count. */
export function pullRequestPresentation(pr: ThreadPullRequest): { indicator: PullRequestIndicator; label: string; dot?: PullRequestDot } {
  if (pr.state !== 'open' && pr.state !== 'draft')
    return { indicator: pr.state, label: pr.state === 'unknown' ? 'status unavailable' : pr.state };
  const details = pr.details;
  const lifecycle = pr.state;
  if (!details) return { indicator: lifecycle, label: lifecycle };
  if (details.mergeable === 'CONFLICTING' || details.mergeState === 'DIRTY')
    return { indicator: 'failing', label: `${lifecycle} · merge conflicts`, dot: 'conflict' };
  if (details.checks === 'failing') return { indicator: 'failing', label: `${lifecycle} · checks failing`, dot: 'failing' };
  if (details.checks === 'unknown') return { indicator: lifecycle, label: `${lifecycle} · checks unavailable`, dot: 'unknown' };
  // a draft cannot merge, so with no checks there is nothing more to say about it
  if (lifecycle === 'draft' && details.checks === 'none') return { indicator: 'draft', label: 'draft' };
  const canMerge = lifecycle === 'open' && details.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS'].includes(details.mergeState);
  // held back by its author: GitHub could merge it, but it is not ready
  if (details.held && details.checks !== 'pending')
    return { indicator: lifecycle, label: `${lifecycle} · held, not to merge yet`, dot: 'waiting' };
  if (canMerge && details.checks !== 'pending') return { indicator: 'ready', label: 'open · ready to merge', dot: 'ready' };
  if (details.checks === 'passing') return { indicator: 'successful', label: `${lifecycle} · checks passed`, dot: 'passing' };
  if (details.checks === 'pending') return { indicator: 'in_progress', label: `${lifecycle} · checks pending`, dot: 'pending' };
  return { indicator: 'in_progress', label: 'open · waiting to merge', dot: 'waiting' };
}
