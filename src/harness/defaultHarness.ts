// The default harness for new chats: the one rule that turns the saved choice ('codex', 'claude' or 'acp:<id>')
// into the harness the next new chat starts on, and says when that is not the saved one and why.
import type { HarnessKind } from './adapter';
import type { BasicHarness } from './types';
import { otherFirstTier } from './family';
import { harnessInfo } from './registry';
import { acpHarnessOf, type HarnessId } from './types';

/** Why the default can't start a new chat now: a basic harness's state, or a first-tier harness that can't run. */
export type DefaultFallback = 'missing' | 'signin' | 'checking' | 'unsupported' | 'off' | 'unusable';

export interface DefaultHarnessInput {
  saved: HarnessKind;
  /** Codex and Claude Code: whether each can run a chat, and whether each is still being looked for */
  usable: Record<HarnessId, boolean>;
  pending: Record<HarnessId, boolean>;
  /** why each one can't run when it can't (signed out, not installed, turned off); unsaid: it just can't */
  why?: Partial<Record<HarnessId, DefaultFallback>>;
  basics: readonly Pick<BasicHarness, 'id' | 'state'>[];
}

export interface DefaultHarness {
  /** the user's choice, as saved */
  saved: HarnessKind;
  /** what the next new chat starts on */
  kind: HarnessKind;
  /** the first-tier harness for what only Codex or Claude Code does (a review, a plugin list): `kind` when it is one */
  firstTier: HarnessId;
  /** why `kind` is not `saved`, or null when it is */
  fallback: DefaultFallback | null;
}

/** The basic harness id a kind names ('opencode' for 'acp:opencode'), or null for Codex and Claude Code. */
export const basicIdOf = (k: HarnessKind) => acpHarnessOf(k);

/**
 * The saved first-tier harness while it can run, else the other one when it can (or is still being looked for while
 * the saved one isn't). The fallback is for this run only: prefs keep the user's choice.
 */
function firstTierFor(want: HarnessId, { usable, pending }: DefaultHarnessInput): HarnessId {
  const other = otherFirstTier(want);
  if (usable[want]) return want;
  return usable[other] || (pending[other] && !pending[want]) ? other : want;
}

/**
 * Resolve the default harness. A basic harness runs while it is admitted; one that isn't falls back to Codex or Claude
 * Code, with the reason it fell back. With neither of those usable, the first admitted basic harness runs instead.
 */
export function resolveDefaultHarness(input: DefaultHarnessInput): DefaultHarness {
  const { saved, usable, basics } = input;
  const admitted = basics.filter((b) => b.state === 'admitted');
  const anyFirstTier = usable.codex || usable.claude;
  const basicId = basicIdOf(saved);
  const firstTier = firstTierFor(basicId ? 'codex' : (saved as HarnessId), input);
  // nothing first-tier can run: the first admitted basic harness can
  const lastResort: HarnessKind = !anyFirstTier && admitted[0] ? `acp:${admitted[0].id}` : firstTier;
  if (basicId) {
    const own = basics.find((b) => b.id === basicId);
    if (own?.state === 'admitted') return { saved, kind: saved, firstTier, fallback: null };
    const kind = anyFirstTier ? firstTier : lastResort;
    return { saved, kind, firstTier, fallback: own ? (own.state as DefaultFallback) : 'missing' };
  }
  // one still being looked for (Claude Code detecting, Codex connecting) may yet come up: it is being checked
  const fallback = input.pending[saved as HarnessId] ? 'checking' : (input.why?.[saved as HarnessId] ?? 'unusable');
  return { saved, kind: lastResort, firstTier, fallback: lastResort === saved ? null : fallback };
}

const FALLBACK_TEXT: Record<DefaultFallback, string> = {
  missing: 'isn’t installed',
  // true whether it never signed in or its sign-in lapsed (#2034: a new install read "Codex is signed out")
  signin: 'isn’t signed in',
  checking: 'is being checked',
  unsupported: 'can’t run in MoPilot',
  off: 'is turned off',
  unusable: 'can’t run right now',
};

/** What a harness is called ('Codex', 'opencode'); one this build doesn't know goes by its id. */
export const harnessKindLabel = (k: HarnessKind) => harnessInfo(k)?.label ?? k.replace(/^acp:/, '');

/** What a page showing the default says when it fell back ("opencode isn’t signed in; new chats start in Codex"), or null. */
export function defaultHarnessNote(d: Pick<DefaultHarness, 'saved' | 'kind' | 'fallback'>): string | null {
  if (!d.fallback) return null;
  return `${harnessKindLabel(d.saved)} ${FALLBACK_TEXT[d.fallback]}; new chats start in ${harnessKindLabel(d.kind)}`;
}
