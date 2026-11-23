// Settings › My machines › Sign-in: one row, "How machines sign in › <choice>", that opens a sheet with three choices: Each machine (each signs in from its row), My API keys (lent from this Mac while a chat runs) or My organization (the company's sign-in and LLM gateway); fields show only for the chosen one. Choosing one ends the other: its keys or its organization settings are removed.
import { useState } from 'react';
import { ChevronRight } from '../../ui/icons';
import { Modal } from '../../ui/Modal';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import type { HostOrgAccessView } from '../../../lib/native/host';
import { userError } from '../../../../shared/userError.mjs';
import { ApiKeyFields, saveKeys, useApiKeys } from './HostApiKeys';
import { OrgFields, orgChanged, orgDraft, orgState, saveOrg, useOrgAccess } from './HostOrgAccess';
import { HostSignOut } from './HostSignOut';

export type SigninMethod = 'each' | 'keys' | 'org';
const LABELS: Record<SigninMethod, string> = { each: 'Each machine', keys: 'My API keys', org: 'My organization' };
/** Keys and gateways cover every agent that takes one (Claude Code, Codex, Gemini, Grok), so the sheet names none. */
const LEDE = 'Applies to every machine.';

/** The choice in force: organization access when it is set up (it goes before a key), else saved keys, else each machine. */
export const methodOf = (hints: Record<string, string>, org: HostOrgAccessView | null): SigninMethod =>
  org?.configured ? 'org' : Object.keys(hints).length ? 'keys' : 'each';

type Keys = ReturnType<typeof useApiKeys>;
type Org = ReturnType<typeof useOrgAccess>;

function SigninSheet({ keys, org, onClose }: { keys: Keys; org: Org; onClose: () => void }) {
  const hints = keys.hints;
  const view = org.view;
  const [choice, setChoice] = useState<SigninMethod>(() => methodOf(hints, view));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState(() => orgDraft(view));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, onFail?: () => void) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onFail?.();
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const dropOrg = async () => {
    if (view?.configured) org.setView(await native.host.removeOrgAccess());
  };
  /** Forgets one key, and its hint once main did (a refusal leaves it shown as saved). */
  const forget = async (id: string) => {
    await native.host.removeApiKey(id);
    keys.setHints((h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== id)));
  };
  const dropKeys = async () => {
    for (const id of Object.keys(hints)) await forget(id);
  };
  const removeKey = (id: string) => run(() => forget(id));
  const typedAny = Object.values(typed).some((v) => v.trim());
  const signedIn = view?.configured && view.state === 'signedIn' && !orgChanged(draft, view);
  const primary: { label: string; disabled: boolean; go: () => void } =
    choice === 'each'
      ? { label: 'Done', disabled: false, go: () => void run(async () => (await dropKeys(), await dropOrg(), onClose())) }
      : choice === 'keys'
        ? {
            label: 'Done',
            disabled: !typedAny && !Object.keys(hints).length,
            go: () =>
              void run(async () => {
                await saveKeys(typed, (id, hint) => {
                  keys.setHints((h) => ({ ...h, [id]: hint }));
                  setTyped((t) => ({ ...t, [id]: '' }));
                });
                await dropOrg();
                onClose();
              }),
          }
        : signedIn
          ? { label: 'Done', disabled: false, go: onClose }
          : {
              label: 'Sign in',
              disabled: !draft.issuer.trim(),
              go: () =>
                void run(
                  async () => {
                    const v = view?.configured && !orgChanged(draft, view) ? view : await saveOrg(draft);
                    org.setView(v);
                    if (v.state !== 'signedIn') org.setView(await native.host.orgSignIn());
                    onClose();
                  },
                  // what main refuses is mostly under More (the client ID)
                  () => setMore(true),
                ),
            };
  const option = (id: SigninMethod, desc: string, fields: React.ReactNode, tag?: string) => (
    <div className={`signin-choice ${choice === id ? 'on' : ''}`}>
      <button
        className="signin-choice-head"
        role="radio"
        aria-checked={choice === id}
        disabled={!!view?.managed && id !== 'org'}
        onClick={() => setChoice(id)}
      >
        <span className="signin-radio" aria-hidden="true" />
        <span>
          <span className="signin-choice-title">
            {LABELS[id]}
            {tag && <span className="signin-tag">{tag}</span>}
          </span>
          <span className="signin-choice-desc">{desc}</span>
        </span>
      </button>
      {choice === id && fields}
    </div>
  );
  return (
    <Modal title="How machines sign in" onClose={onClose}>
      <div className="machine-sheet">
        <p className="machine-sheet-lede">{LEDE}</p>
        <div role="radiogroup" aria-label="How machines sign in" className="signin-choices">
          {option('each', 'Sign in once per machine from its row.', null)}
          {option(
            'keys',
            'Kept on this Mac, lent to a machine only while a chat runs.',
            <ApiKeyFields
              hints={hints}
              typed={typed}
              onType={(id, v) => setTyped((t) => ({ ...t, [id]: v }))}
              onRemove={(id) => void removeKey(id)}
              busy={busy}
            />,
          )}
          {option(
            'org',
            'Your company sign-in and LLM gateway.',
            <>
              <OrgFields draft={draft} onChange={setDraft} more={more} onMore={() => setMore(true)} managed={view?.managed} />
              {view?.configured && (
                <div className="signin-saved">
                  <span>{orgState(view)}</span>
                  {view.state === 'signedIn' && (
                    <button
                      className="link-btn"
                      disabled={busy}
                      onClick={() => void run(async () => org.setView(await native.host.orgSignOut()))}
                    >
                      Sign out
                    </button>
                  )}
                </div>
              )}
            </>,
            view?.managed ? 'Managed' : 'Admin',
          )}
        </div>
        <div className="machine-sheet-actions">
          <button className="btn-pill soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-pill primary" disabled={busy || primary.disabled} onClick={primary.go}>
            {busy && choice === 'org' && !signedIn ? 'Signing in…' : primary.label}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function HostSigninMethod() {
  const keys = useApiKeys();
  const org = useOrgAccess();
  const [open, setOpen] = useState(false);
  const loaded = keys.loaded && org.view !== null;
  return (
    <>
      <h3 className="machines-section">Sign-in</h3>
      <div className="machine-list">
        <button className="machine-item machine-link" onClick={() => setOpen(true)}>
          <span className="machine-main">
            <span className="machine-name">How machines sign in</span>
          </span>
          <span className="machine-value">
            {loaded && LABELS[methodOf(keys.hints, org.view)]}
            <ChevronRight size={14} aria-hidden="true" />
          </span>
        </button>
      </div>
      {/* signing out everywhere also forgets the keys here */}
      <HostSignOut onSignedOut={() => keys.setHints({})} />
      {open && <SigninSheet keys={keys} org={org} onClose={() => setOpen(false)} />}
    </>
  );
}
