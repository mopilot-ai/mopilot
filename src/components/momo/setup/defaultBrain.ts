// The brain setup starts MoMo on (#2527), from the user's signed-in harnesses and accounts. Pure: the setup screen shows it and applies it on Start.
import type { MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import { accountRemaining } from '../../../../shared/remainingCapacity.mjs';

/** One signed-in harness as setup offers it; its accounts are only those MoMo can run on now (not at their limit, not an API key MoMo can't use). */
export interface BrainCandidate {
  /** 'codex', 'claude' or 'acp:<id>' */
  harness: string;
  label: string;
  accounts: {
    id: string | null;
    name: string;
    /** percent left of its tightest window; null: not known */
    left: number | null;
    /** what its plan holds (HARNESS_TRAITS planUnits); null: the plan's size is not known */
    units: number | null;
  }[];
  /** the model a new brain on it starts on (HARNESS_TRAITS everydayModel); null: the harness's own */
  model: { id: string; label: string } | null;
  /** it keeps several accounts side by side (a brain can move between them) */
  multi: boolean;
}

type Pick = { c: BrainCandidate; a: BrainCandidate['accounts'][number] };

/**
 * What an account has left in absolute terms, in plan units: its plan's size times the fraction left of its tightest
 * window (a Max 20× at 83% holds more than a Pro Lite at 87%); the fraction alone where the plan's size is not known.
 * Null: not known. The same measure harness "auto" ranks harnesses by (shared/remainingCapacity.mjs).
 */
export const remaining = (a: { left: number | null; units: number | null }) => accountRemaining(a);

/** Most remaining first; an account whose usage is not known after every known one. */
const byRemaining = (x: Pick, y: Pick) => (remaining(y.a) ?? -1) - (remaining(x.a) ?? -1);

/**
 * MoMo's default brain: the account with the most remaining capacity (a harness that keeps several accounts before one
 * with a single sign-in), on that harness's everyday model. Null when nothing is signed in.
 */
export function defaultBrain(candidates: BrainCandidate[]): MomoRoleBrain | null {
  const all: Pick[] = candidates.flatMap((c) => c.accounts.map((a) => ({ c, a })));
  const best = [...all.filter((p) => p.c.multi).sort(byRemaining), ...all.filter((p) => !p.c.multi)][0];
  if (!best) return null;
  return {
    harness: best.c.harness,
    account: best.a.id,
    model: best.c.model?.id ?? null,
    modelLabel: best.c.model?.label ?? null,
  };
}
