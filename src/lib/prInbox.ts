// The PR inbox's sorting (the status line's count and its tray): which of a chat family's pull requests need the user,
// which other PRs remain open, and which landed, with the reason and step each shows.
import type { ThreadPullRequest } from './threadPullRequest';
import { pluralize } from './format';

/** What the PR monitor knows of a chat's tracked PR (electron/session/prMonitor.cjs), as far as the inbox reads it. */
export interface InboxMonitor {
  autoFix: boolean;
  /** auto-fix stopped after its tries */
  limited: boolean;
  /** an auto-fix or continuation may not have reached the chat */
  uncertain: boolean;
}

/** One PR of the family with what the window knows of it and of the chat it belongs to. */
export interface InboxSource {
  url: string;
  chatId: string;
  /** the chat's short handle (a linked session's name), or null for the main chat itself */
  session: string | null;
  /** the PR as GitHub last answered, or null before its first read */
  pr: ThreadPullRequest | null;
  /** the session waits on the user (an approval, a question); never the main chat itself, whose box is right there */
  asking?: boolean;
  /** the session is starting, working or waiting its turn, so it may still act on its PR itself */
  busy?: boolean;
  /** the question its wrap-up box asks, with the answers the user can click */
  ask?: { text: string; actions: { label: string; message: string | null }[] } | null;
  monitor?: InboxMonitor | null;
}

export type InboxTag =
  | 'asks'
  | 'review'
  | 'check'
  | 'merge'
  | 'stuck'
  | 'fixing'
  | 'checks'
  | 'train'
  | 'held'
  | 'merging'
  | 'waiting'
  | 'draft'
  | 'unknown'
  | 'landed';
export type InboxGroup = 'needs' | 'moving' | 'landed';
/**
 * Where a PR on its way stands: its checks, its merge, then main; for one the merge robot lands (a gate status), its
 * checks, the gate, the merge train, then main.
 */
export type InboxStep = 'checks' | 'merge' | 'gate' | 'train' | null;

export interface InboxRow extends InboxSource {
  group: InboxGroup;
  tag: InboxTag;
  /** the reason in a few words */
  text: string;
  step: InboxStep;
  /** for a fix the gate holds unverified: what "Ask to verify" sends the PR's chat */
  request?: string;
}

/** The tag's words, as the row's chip shows them. */
export const TAG_WORD: Record<InboxTag, string> = {
  asks: 'Asks you',
  review: 'Your review',
  check: 'Verify fix',
  merge: 'Ready to merge',
  stuck: 'Stuck',
  fixing: 'Fixing',
  checks: 'Checks',
  train: 'Merge train',
  held: 'Held',
  merging: 'Merging',
  waiting: 'Waiting',
  draft: 'Draft',
  unknown: 'Unknown',
  landed: 'Merged',
};

/** Why GitHub holds a PR that passed its checks and isn't ready to merge, by its merge state. */
const MERGE_STATE_WORDS: Record<string, string> = {
  BEHIND: 'Behind its base branch',
  BLOCKED: 'Waiting for a review or a branch rule',
  UNSTABLE: 'Some optional checks failed',
};

/**
 * What the gate found missing in a held bug fix's "Verified the fix" section (scripts/fix-verification.mjs): the row's
 * reason, and the same as words for the request its chat gets. Without them the row said only "needs verifying", which
 * left the user guessing whether to test the fix or edit the PR.
 */
const CHECK_GAPS: { re: RegExp; text: string; lacks: string }[] = [
  {
    re: /has no "Verified the fix" section/,
    text: 'No "Verified the fix" section in its description',
    lacks: 'its description has no "Verified the fix" section',
  },
  { re: /section is empty/, text: '"Verified the fix" section is empty', lacks: 'its "Verified the fix" section is empty' },
  {
    re: /defers the check/,
    text: '"Verified the fix" reads as not done yet',
    lacks: 'its "Verified the fix" section reads as if the check was put off',
  },
];
const UNKNOWN_GAP = { text: "Its fix isn't recorded as verified", lacks: 'its fix is not recorded as verified' };

/** The row and request for a fix the gate holds unverified, by the gate's reason. */
function checkGap(text: string, number: number) {
  const gap = CHECK_GAPS.find((g) => g.re.test(text)) ?? UNKNOWN_GAP;
  const verifyPrompt = `The merge gate holds #${number}: ${gap.lacks}. Verify the fix against its original repro if that is not done yet, record the steps and the result under "Verified the fix", and let the merge gate check it again.`;
  return { text: gap.text, request: verifyPrompt };
}

/**
 * One PR's place, the first rule that matches winning: a session's question, the only thing that needs the user (they
 * chose this: a session decides the rest itself, or a click it offers settles it); then, on its way, what the user
 * may act on (a stopped auto-fix, a review, failing checks or a conflict nothing is fixing, the merge robot's hold or
 * failure, a merge nothing is set to do) before what moves without them. Closed PRs have no place, nor do merges before
 * `since`; a null `since` keeps every merge.
 */
export function classify(src: InboxSource, since: number | null): InboxRow | null {
  const row = (group: InboxGroup, tag: InboxTag, text: string, step: InboxStep = null): InboxRow => ({ ...src, group, tag, text, step });
  const pr = src.pr;
  if (pr?.state === 'closed') return null;
  if (pr?.state === 'merged')
    return since === null || (pr.mergedAt !== undefined && pr.mergedAt >= since) ? row('landed', 'landed', 'Merged') : null;
  if (src.asking) return row('needs', 'asks', src.ask?.text ?? 'Waiting for your answer or approval');
  if (src.monitor?.limited) return row('moving', 'stuck', 'Auto-fix stopped after several tries');
  if (src.monitor?.uncertain) return row('moving', 'stuck', 'Auto-fix may not have reached the session');
  const d = pr?.details;
  if (!pr || pr.state === 'unknown' || !d) return row('moving', 'unknown', 'Status unavailable');
  if (d.review) return row('moving', 'review', 'GitHub asks for your review');
  const conflict = d.mergeable === 'CONFLICTING' || d.mergeState === 'DIRTY';
  if (conflict || d.checks === 'failing') {
    const what = conflict ? 'Merge conflict' : 'Checks failing';
    if (src.monitor?.autoFix || src.busy) return row('moving', 'fixing', `${what} · being fixed`);
    return row('moving', 'stuck', `${what} · auto-fix is off`);
  }
  const g = d.gate;
  if (g?.at === 'stuck') return row('moving', 'stuck', g.text);
  if (g?.at === 'held' && g.why === 'unverified')
    // a session at work fills in its own verification; one that ended leaves the check to the user
    return src.busy
      ? row('moving', 'held', 'Waiting for its fix to be verified', 'gate')
      : { ...row('moving', 'check', ''), ...checkGap(g.text, pr.number) };
  if (g?.at === 'held') return row('moving', 'held', g.why === 'red' ? 'Main is red' : g.text, 'gate');
  if (g?.at === 'failed') return row('moving', 'fixing', 'The merge train failed · it retries on a new check', 'train');
  if (g?.at === 'train') return row('moving', 'train', g.others ? `In a train with ${g.others} more` : 'In the merge train', 'train');
  if (pr.state === 'draft') return row('moving', 'draft', 'Draft', 'checks');
  if (d.checks === 'pending' || d.checks === 'unknown')
    return row('moving', 'checks', d.checks === 'pending' ? 'Checks running' : 'Checks unavailable', 'checks');
  // its author labelled it not to merge yet: nothing for the user to click, and the robot leaves it too
  if (d.held) return row('moving', 'held', 'Held · do-not-merge', 'merge');
  if (d.landing) return row('moving', 'merging', 'Merges once it can', 'merge');
  const ready = d.mergeable === 'MERGEABLE' && (d.mergeState === 'CLEAN' || d.mergeState === 'HAS_HOOKS');
  // a session still working may yet hand it to the merge robot itself
  if (ready && !src.busy) return row('moving', 'merge', 'Checks passed · nothing set to merge it');
  return row('moving', 'waiting', MERGE_STATE_WORDS[d.mergeState] ?? 'Waiting to merge', 'merge');
}

const NEEDS_ORDER: InboxTag[] = ['asks'];
// what the user may act on comes first, though none of it waits on them
const MOVING_ORDER: InboxTag[] = [
  'stuck',
  'review',
  'check',
  'merge',
  'train',
  'merging',
  'held',
  'waiting',
  'fixing',
  'checks',
  'draft',
  'unknown',
];

export interface InboxView {
  needs: InboxRow[];
  moving: InboxRow[];
  landed: InboxRow[];
}

/**
 * The family's PRs by group, each PR once (the first source for a URL wins, the chats in family order): needs-you by
 * reason, then family order; on its way nearest to landing first; landed newest first, a merge of unknown date last.
 * `since`: how far back merges count (classify).
 */
export function inboxView(sources: InboxSource[], since: number | null): InboxView {
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  for (const src of sources) {
    if (seen.has(src.url)) continue;
    seen.add(src.url);
    const r = classify(src, since);
    if (r) rows.push(r);
  }
  const by = (order: InboxTag[]) => (a: InboxRow, b: InboxRow) => order.indexOf(a.tag) - order.indexOf(b.tag);
  return {
    needs: rows.filter((r) => r.group === 'needs').sort(by(NEEDS_ORDER)),
    moving: rows.filter((r) => r.group === 'moving').sort(by(MOVING_ORDER)),
    landed: rows.filter((r) => r.group === 'landed').sort((a, b) => (b.pr!.mergedAt ?? 0) - (a.pr!.mergedAt ?? 0)),
  };
}

/** The family's open inventory includes PRs waiting on input; a landed PR no longer counts as open. */
export function openPrCount(v: InboxView): number {
  return v.needs.length + v.moving.length;
}

/** What the status line's count says and reads out; nothing while the family has no PR to list. */
export interface InboxCount {
  label: string;
  aria: string;
}

export function inboxCount(v: InboxView): InboxCount | null {
  const counts = [
    { count: v.landed.length, state: 'merged' },
    { count: openPrCount(v), state: 'open' },
  ].filter(({ count }) => count > 0);
  if (!counts.length) return null;
  return {
    label: counts.map(({ count, state }) => pluralize(count, `${state} PR`)).join(' · '),
    aria: `Pull requests: ${counts.map(({ count, state }) => `${count} ${state}`).join(', ')}`,
  };
}

/** How many merged PRs a list shows before "Show N more": merged is what it opens for, so it stays unfolded. */
export const MERGED_SHOWN = 5;

/** When a PR merged, as a row says it: today's with its time, yesterday, else its date (and year, if not this year). */
export function landedWhen(mergedAt: number, now: number): string {
  const when = new Date(mergedAt);
  const today = startOfDay(now);
  if (mergedAt >= today) return `Today ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  if (mergedAt >= startOfDay(today - 1)) return 'Yesterday';
  const year = when.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return when.toLocaleDateString('en', { month: 'short', day: 'numeric', year });
}

/** The local midnight before `now`: what "landed today" counts from. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
