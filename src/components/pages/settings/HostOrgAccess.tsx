// Settings › My machines › How machines sign in › My organization (#3361 Tier 2): the admin's sign-in URL and gateway URL, with the client ID, a separate OpenAI gateway and the session length under More; each person signs in on this Mac in the browser, and every machine then runs with a short-lived lease, no sign-in there. No token is ever shown.
import { useEffect, useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import type { HostOrgAccessView } from '../../../lib/native/host';
import { userError } from '../../../../shared/userError.mjs';
import { LEASE_HOURS } from '../../../../shared/host/orgAccess.mjs';

type Field = { id: 'issuer' | 'anthropic' | 'clientId' | 'openai'; title: string; hint: string };
const MAIN: readonly Field[] = [
  { id: 'issuer', title: 'Sign-in URL', hint: 'https://login.example.com/realms/acme' },
  { id: 'anthropic', title: 'Gateway URL', hint: 'https://llm.example.com/anthropic' },
];
const MORE: readonly Field[] = [
  { id: 'clientId', title: 'Client ID', hint: 'mopilot' },
  { id: 'openai', title: 'OpenAI gateway URL', hint: 'https://llm.example.com/openai/v1' },
];
export type OrgDraft = Record<Field['id'], string> & { hours: string };

export const orgDraft = (v: HostOrgAccessView | null): OrgDraft => ({
  issuer: v?.config?.issuer ?? '',
  clientId: v?.config?.clientId ?? '',
  anthropic: v?.config?.access.gateways.anthropic ?? '',
  openai: v?.config?.access.gateways.openai ?? '',
  hours: String(v?.config?.leaseHours ?? LEASE_HOURS.default),
});

/** Whether the draft says something other than what is saved. */
export const orgChanged = (d: OrgDraft, v: HostOrgAccessView | null) => JSON.stringify(d) !== JSON.stringify(orgDraft(v));

/** Keeps the admin's settings; main refuses what is wrong (a missing client ID, a plain-http URL) with what to fix. */
export const saveOrg = (d: OrgDraft) =>
  native.host.setOrgAccess({
    issuer: d.issuer.trim(),
    clientId: d.clientId.trim(),
    leaseHours: Number(d.hours),
    access: { kind: 'gateway', gateways: { anthropic: d.anthropic.trim() || undefined, openai: d.openai.trim() || undefined } },
  });

/** The organization access as main has it, followed while shown; `null` until main answered. */
export function useOrgAccess() {
  const [view, setView] = useState<HostOrgAccessView | null>(null);
  useEffect(() => {
    let live = true;
    const show = (v: HostOrgAccessView) => live && setView(v);
    native.host.orgAccess().then(show, (e) => toast(userError(e), 'error'));
    const off = native.host.onOrgAccess(show);
    return () => {
      live = false;
      off();
    };
  }, []);
  return { view, setView };
}

/** "Managed by Acme", and why the last change of the policy was not taken when it was not. */
export const managedLine = (m: { organization: string; problem: string }) =>
  `${m.organization ? `Managed by ${m.organization}` : 'Managed by your organization'}.${m.problem ? ` ${m.problem}` : ''}`;

/** The line under the choice once settings are saved: signed in as whom, or that a sign-in is needed. */
export function orgState(v: HostOrgAccessView): string {
  if (v.state === 'signedIn') return v.who ? `Signed in as ${v.who}` : 'Signed in';
  return v.state === 'signinRequired' ? 'Sign-in ended. Sign in again.' : 'Not signed in on this Mac.';
}

export function OrgFields({
  draft,
  onChange,
  more,
  onMore,
  managed,
}: {
  draft: OrgDraft;
  onChange: (d: OrgDraft) => void;
  more: boolean;
  onMore: () => void;
  /** set when the organization's managed policy decides these settings: the values show, locked, and say who manages them */
  managed?: { organization: string; problem: string } | null;
}) {
  const input = (f: Field) => (
    <input
      key={f.id}
      className="text-input"
      autoComplete="off"
      spellCheck={false}
      placeholder={`${f.title}  ${f.hint}`}
      value={draft[f.id]}
      readOnly={!!managed}
      onChange={(e) => onChange({ ...draft, [f.id]: e.target.value })}
      aria-label={f.title}
    />
  );
  return (
    <div className="signin-fields">
      {managed && <p className="signin-managed">{managedLine(managed)}</p>}
      {MAIN.map(input)}
      {more || managed ? (
        <>
          {MORE.map(input)}
          <label className="signin-hours">
            Session length
            <input
              className="text-input"
              type="number"
              min={LEASE_HOURS.min}
              max={LEASE_HOURS.max}
              value={draft.hours}
              readOnly={!!managed}
              onChange={(e) => onChange({ ...draft, hours: e.target.value })}
              aria-label="Session length in hours"
            />
            h
          </label>
        </>
      ) : (
        <button className="signin-more" onClick={onMore}>
          More: client ID, OpenAI gateway, session length ({draft.hours} h)
        </button>
      )}
    </div>
  );
}
