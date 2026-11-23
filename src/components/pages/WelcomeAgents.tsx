// The welcome page's basic-harness rows, each installed or signed in right in its row, the fold the missing ones wait
// behind, and the row parts every agent shares (Connected, the row's action).
import { useEffect, useState } from 'react';
import { get as getState, toast, useStore } from '../../store/core';
import { dispatchLogin } from '../../harness/acpLogin';
import { navigate } from '../../store/panes';
import { harnessesByTier } from '../../harness/registry';
import { refreshInstallTools } from '../../session/harness/harnessRuns';
import { isFirstTier, type HarnessKind } from '../../harness/adapter';
import type { Presence } from '../../session/harness/installable';
import { HARNESS_LABEL } from '../../harness/types';
import {
  SIGNIN_WAITING,
  TURNED_OFF,
  UNSUPPORTED,
  authenticateBasic,
  cancelBasicSignIn,
  loginCommand,
  recheckBasic,
  type LoginTerminal,
  type BasicHarness,
} from '../../session/harness/acp';
import { basicKind, featuredFirst } from '../../lib/welcome';
import { InstallLines } from '../harness/InstallLines';
import { RECHECK_AFTER_MS, useAfter } from '../harness/installWatch';
import { SignInWaiting } from '../accounts/SignInWaiting';
import { BasicHarnessIcon } from '../harnessPicker/HarnessPicker';
import { TermView } from '../panels/TerminalPanel';
import { Check, ChevronDown, ChevronUp, Spinner } from '../ui/icons';
import { dismissWelcome } from './welcomeState';

/** The basic harnesses MoPilot supports, the ones most people already pay for first. */
const basicAgents = () => featuredFirst(harnessesByTier('basic').map((b) => ({ kind: b.kind, label: b.label, vendor: b.vendor })));

/** What a connected agent is called: a first-class harness's label, else the basic harness's own (main lists it). */
export const agentLabel = (k: HarnessKind, basics: readonly BasicHarness[]) =>
  isFirstTier(k) ? HARNESS_LABEL[k] : basics.find((b) => basicKind(b.id) === k)!.label;

export function Connected() {
  return (
    <span className="welcome-row-state">
      <Check size={13} /> Connected
    </span>
  );
}

/** The row's one action (Connect, Install, Sign in): opens what it takes below the row, and closes it again. */
export function RowAction({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    // a pill, as the Chrome row's step: a row's one action reads as a button, not as its state (#2034)
    <button type="button" className="btn-pill welcome-row-action" aria-expanded={open} onClick={onToggle}>
      {label}
    </button>
  );
}

/** A supported basic harness main has not listed yet reads as not installed. */
const unlisted = (kind: string, label: string): BasicHarness => ({
  id: kind.slice('acp:'.length),
  label,
  state: 'missing',
  reason: null,
  bin: null,
  version: null,
  authMethods: [],
  login: null,
});

/**
 * Every basic harness with main's status for it: the supported ones, the featured first, then any other main lists (a
 * developer build's spike harnesses), so every agent that can be connected has a row.
 */
export const basicRows = (status: readonly BasicHarness[]) => {
  const known = basicAgents();
  const rows = known.map((a) => ({
    kind: a.kind,
    vendor: a.vendor,
    b: status.find((s) => basicKind(s.id) === a.kind) ?? unlisted(a.kind, a.label),
  }));
  const extra = status.filter((s) => !known.some((a) => a.kind === basicKind(s.id)));
  return [...rows, ...extra.map((b) => ({ kind: basicKind(b.id), vendor: '', b }))];
};

/** The fold under the list: "N more" with the marks of the agents behind it, or "Show fewer". */
export function MoreToggle({
  ids,
  names,
  open,
  onToggle,
}: {
  ids: readonly string[];
  /** the agents behind it, said on hover and to screen readers (#2034: the marks alone named none) */
  names: readonly string[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="welcome-row welcome-more"
      aria-expanded={open}
      title={open ? undefined : names.join(', ')}
      aria-label={open ? 'Show fewer' : `${ids.length} more: ${names.join(', ')}`}
      onClick={onToggle}
    >
      <span>{open ? 'Show fewer' : `${ids.length} more`}</span>
      {!open && (
        <span className="welcome-more-marks" aria-hidden="true">
          {ids.map((id) => (
            <BasicHarnessIcon key={id} id={id} size={14} />
          ))}
        </span>
      )}
      {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
  );
}

/** A basic harness: Connected, Install (its official commands) or Sign in (its own sign-in, here or in a terminal). */
export function BasicRow({ b, vendor }: { b: BasicHarness; vendor: string }) {
  // its own login runs in a terminal below, as in Settings → Other harnesses; it is checked again on exit
  const [login, setLogin] = useState<(LoginTerminal & { id: string }) | null>(null);
  const [open, setOpen] = useState(false);
  const signIn = (methodId: string | null) => {
    dispatchLogin(loginCommand(b, methodId), {
      terminal: (t) => setLogin({ id: `login-${b.id}-${crypto.randomUUID()}`, ...t }),
      // cannot reject: authenticateBasic says itself why the sign-in failed
      authenticate: () => {
        if (methodId) void authenticateBasic(b, methodId);
      },
      unavailable: (reason) => toast(reason, 'error'),
    });
  };
  // its ACP sign-in, started here or in another window, waits on the harness's own login
  const waiting = useStore((s) => !!s.basicSignIns[b.id]);
  const item: Presence = { kind: `acp:${b.id}`, label: b.label, vendor, tier: 'basic', state: 'missing', version: null };
  // a sign-in in the terminal or the browser is checked when it ends: Re-check is for one done elsewhere
  const late = useAfter(RECHECK_AFTER_MS, open && b.state === 'signin' && !login && !waiting);
  return (
    <div className="welcome-row" role="listitem">
      <div className="welcome-row-head">
        <BasicHarnessIcon id={b.id} size={18} />
        <span className="welcome-row-label">{b.label}</span>
        {b.state === 'admitted' && <Connected />}
        {b.state === 'checking' && <Spinner size={14} />}
        {b.state === 'unsupported' && <span className="welcome-row-state">{UNSUPPORTED(b.reason)}</span>}
        {b.state === 'off' && <span className="welcome-row-state">{TURNED_OFF(b.reason)}</span>}
        {b.state === 'missing' && <RowAction label="Install" open={open} onToggle={() => setOpen(!open)} />}
        {b.state === 'signin' && <RowAction label="Sign in" open={open} onToggle={() => setOpen(!open)} />}
      </div>
      {open && b.state === 'missing' && (
        <div className="welcome-row-body">
          <Install item={item} />
        </div>
      )}
      {(open || waiting) && b.state === 'signin' && (
        <div className="welcome-row-body">
          {waiting && <SignInWaiting text={SIGNIN_WAITING} onCancel={() => cancelBasicSignIn(b.id)} buttonClass="btn ghost" />}
          {!login && !waiting && (
            <div className="login-actions">
              {b.authMethods.map((m) => (
                <button key={m.id} className="btn primary" title={m.description ?? undefined} onClick={() => signIn(m.id)}>
                  {m.name}
                </button>
              ))}
              {!b.authMethods.length && b.login && (
                <button className="btn primary" onClick={() => signIn(null)}>
                  Sign in
                </button>
              )}
              {late && (
                <button className="btn ghost" onClick={() => recheckBasic(b.id)}>
                  Re-check
                </button>
              )}
            </div>
          )}
          {login && (
            <div className="basic-login-term">
              <TermView
                tab={{ id: login.id, cwd: getState().home, title: login.title, command: login.command, env: login.env, signIn: true }}
                visible
                onExit={() => {
                  setLogin(null);
                  // cannot reject: recheckBasic says itself when the check fails
                  void recheckBasic(b.id);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A basic harness's official install commands; a copy installed elsewhere is pointed at in Settings → Other harnesses. */
function Install({ item }: { item: Presence }) {
  useEffect(() => {
    refreshInstallTools();
  }, []);
  return (
    <InstallLines
      item={item}
      onSetLocation={() => {
        dismissWelcome();
        navigate({ name: 'settings', section: 'other-harnesses' });
      }}
    />
  );
}
