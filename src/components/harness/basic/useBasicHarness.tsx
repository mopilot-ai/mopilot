// What a basic harness's row and its own page both show: its state in a word with the line under it, and the ways
// it signs in (an ACP auth method, or its quirks' terminal login run right there, checked again when it exits).
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useState, type ReactNode } from 'react';
import { get as getState, toast, useStore } from '../../../store/core';
import { dispatchLogin } from '../../../harness/acpLogin';
import {
  TURNED_OFF,
  UNSUPPORTED,
  authenticateBasic,
  cancelBasicSignIn,
  loginCommand,
  recheckBasic,
  type BasicHarness,
  type LoginTerminal,
} from '../../../session/harness/acp';
import { TermView } from '../../panels/TerminalPanel';

const STATE: Record<BasicHarness['state'], [string, string]> = {
  admitted: ['Ready', 'ok'],
  checking: ['Checking…', ''],
  // true whether it never signed in or its sign-in lapsed (#2034)
  signin: ['Not signed in', 'warn'],
  unsupported: ["Can't run", 'warn'],
  missing: ['Not installed', ''],
  off: ['Turned off', 'warn'],
};

export interface BasicHarnessView {
  /** the state in a word, and its dot's tone */
  label: string;
  tone: string;
  /** the line under it: why it can't run, what it needs, or that it is signed in */
  desc: string;
  /** it signs in itself (an auth method or a terminal login); without, a signed-out one needs setting up */
  methods: boolean;
  /** its sign-in, started here or in another window, waits on the harness's own login */
  waiting: boolean;
  /** the ways to sign in: primary on a signed-out harness, "Sign in again" once it is known to have signed in */
  signInButtons: (primary: boolean) => ReactNode;
  /** the terminal a login runs in, while one runs */
  loginTerm: ReactNode;
}

export function useBasicHarness(h: BasicHarness): BasicHarnessView {
  // a terminal login runs right here; the harness is checked again when it exits
  const [login, setLogin] = useState<(LoginTerminal & { id: string }) | null>(null);
  const waiting = useStore((s) => !!s.basicSignIns[h.id]);
  const signIn = (methodId: string | null) => {
    dispatchLogin(loginCommand(h, methodId), {
      terminal: (t) => setLogin({ id: `login-${h.id}-${crypto.randomUUID()}`, ...t }),
      // cannot reject: authenticateBasic says itself why the sign-in failed
      authenticate: () => {
        if (methodId) void authenticateBasic(h, methodId);
      },
      unavailable: (reason) => toast(reason, 'error'),
    });
  };
  // a harness with no sign-in of its own is not said to be signed in, or out: it needs setting up (dsh's key)
  const methods = h.authMethods.length > 0 || !!h.login;
  const [label, tone] = h.state === 'signin' && !methods ? ['Needs setup', 'warn'] : STATE[h.state];
  const desc =
    h.state === 'unsupported'
      ? UNSUPPORTED(h.reason)
      : h.state === 'off'
        ? TURNED_OFF(h.reason)
        : h.state === 'signin'
          ? (h.reason ?? `Sign in to ${h.label}`)
          : h.state === 'checking'
            ? 'Checking that it can run…'
            : methods
              ? 'Signed in'
              : 'Ready';
  const signInButtons = (primary: boolean) => {
    // signed in, its one way in signs in again ("Login with opencode" beside "Signed in" read as signed out, #1870);
    // several ways keep their names: they are choices (a browser login, an API key)
    // only once it is known to have signed in: Checking… and Can't run may be before any sign-in
    const signedIn = !primary && (h.state === 'admitted' || h.state === 'off');
    const again = signedIn && h.authMethods.length === 1;
    return (
      <span className="hs-list">
        {/* while one waits, Cancel stands in for the ways to sign in */}
        {waiting && (
          <button className="btn-pill" onClick={() => cancelBasicSignIn(h.id)}>
            Cancel
          </button>
        )}
        {!waiting &&
          h.authMethods.map((m) => (
            <button
              key={m.id}
              className={`btn-pill ${primary ? 'primary' : ''}`}
              title={(again ? m.name : m.description) ?? undefined}
              onClick={() => signIn(m.id)}
            >
              {again ? 'Sign in again' : m.name}
            </button>
          ))}
        {!h.authMethods.length && h.login && (
          <button className={`btn-pill ${primary ? 'primary' : ''}`} onClick={() => signIn(null)}>
            {signedIn ? 'Sign in again' : 'Sign in'}
          </button>
        )}
      </span>
    );
  };
  const loginTerm = login && (
    <div className="basic-login-term">
      <TermView
        tab={{ id: login.id, cwd: getState().home, title: login.title, command: login.command, env: login.env, signIn: true }}
        visible
        onExit={() => {
          setLogin(null);
          // cannot reject: recheckBasic says itself when the check fails
          void recheckBasic(h.id);
        }}
      />
    </div>
  );
  return { label, tone, desc, methods, waiting, signInButtons, loginTerm };
}
