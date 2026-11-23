// What a harness's row in Settings › All harnesses says, the same for every harness family: quiet while it is ready,
// else one line for its state and at most one thing to do, only when the user can do something. Pure; the row
// components (components/harness/HarnessRows.tsx) render it and map an action to its call.
import type { Account } from './accounts';
import type { HarnessAccountView } from './accountView';

export type RowStateKind = 'ready' | 'checking' | 'first-use' | 'signin' | 'limit' | 'cant-run' | 'missing';

/** What the row's one button does: the row component calls the harness's own way of doing it. */
export type RowAction =
  | { do: 'signin'; label: string }
  | { do: 'relogin'; label: string; account: Account }
  | { do: 'use'; label: string; account: Account }
  | { do: 'location'; label: string }
  | { do: 'recheck'; label: string };

export interface RowState {
  kind: RowStateKind;
  /** the line under the name; null keeps the account line */
  line: string | null;
  action: RowAction | null;
}

const SIGN_IN_LINE = 'Sign in once, then MoPilot can use it.';
const CHECKING: RowState = { kind: 'checking', line: 'Checking…', action: null };

/** "daxhill6@" for an email, else the account's name as shown. */
const shortName = (name: string) => {
  const at = name.indexOf('@');
  return at > 0 ? `${name.slice(0, at)}@` : name;
};

/** A first-class harness's row, from its account view; `customBin`: a CLI location was set for it. */
export function firstClassRowState(v: HarnessAccountView, customBin: boolean): RowState {
  const { label, active } = v;
  switch (v.phase) {
    case 'missing':
      return { kind: 'missing', line: null, action: null };
    case 'checking':
      return CHECKING;
    case 'not-started': {
      const n = v.accounts.length;
      return { kind: 'first-use', line: `Starts with your first ${label} chat${n > 1 ? ` · ${n} accounts` : ''}`, action: null };
    }
    case 'signed-out':
      return { kind: 'signin', line: SIGN_IN_LINE, action: { do: 'signin', label: `Sign in to ${label}` } };
    case 'error':
      return {
        kind: 'cant-run',
        line: v.error ?? `${label} can't start`,
        // a refused key or credits is not the CLI's location: choosing another install fixes nothing
        action: customBin && !v.rejected ? { do: 'location', label: 'Choose location…' } : { do: 'recheck', label: 'Re-check' },
      };
  }
  // ready: the login in use says how it is
  if (active?.state === 'lapsed')
    return { kind: 'signin', line: null, action: { do: 'relogin', label: `Sign in to ${label}`, account: active.account } };
  if (active?.state === 'limited') {
    const next = v.accounts.find((r) => !r.active && r.state === 'signed-in');
    return {
      kind: 'limit',
      line: null,
      action: next ? { do: 'use', label: `Use ${shortName(next.name)}`, account: next.account } : null,
    };
  }
  return { kind: 'ready', line: null, action: null };
}

/** The basic-harness fields the row reads. */
export interface BasicRowInput {
  label: string;
  state: 'admitted' | 'signin' | 'checking' | 'unsupported' | 'off' | 'missing';
  reason: string | null;
  /** it has a sign-in of its own (ACP auth methods or a terminal login) */
  signsIn: boolean;
}

/** A basic (ACP) harness's row, from its admission. */
export function basicRowState(b: BasicRowInput): RowState {
  switch (b.state) {
    case 'admitted':
      return { kind: 'ready', line: `Signed in and billed by ${b.label}`, action: null };
    case 'checking':
      return CHECKING;
    case 'missing':
      return { kind: 'missing', line: null, action: null };
    case 'signin':
      // one with no sign-in of its own needs setting up (dsh's key): the reason says how, then it is checked again
      return b.signsIn
        ? { kind: 'signin', line: SIGN_IN_LINE, action: { do: 'signin', label: `Sign in to ${b.label}` } }
        : { kind: 'cant-run', line: b.reason ?? `${b.label} needs setting up`, action: { do: 'recheck', label: 'Re-check' } };
    case 'unsupported':
      return {
        kind: 'cant-run',
        line: b.reason || `${b.label} can't run in MoPilot`,
        action: { do: 'recheck', label: 'Re-check' },
      };
    case 'off':
      // turned off by MoPilot itself: nothing for the user to do
      return { kind: 'cant-run', line: b.reason ?? 'Turned off for now', action: null };
  }
}
