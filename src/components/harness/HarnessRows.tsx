// The rows of Settings › All harnesses, one shell for every harness family: quiet while the harness is ready (who it
// runs as and what is left), else one line for its state (harness/rowState.ts) and at most one button the user can
// act on: its update, signing in, the next account, its CLI location or a re-check. A known problem with the version
// installed here (harness/knownIssues.ts) adds an amber note under the row. The whole row opens the harness's page.
import type { ReactNode } from 'react';
import { navigate } from '../../store/panes';
import { savedDefaultHarness } from '../../store/chats';
import { toast, useStore } from '../../store/core';
import { useAccountView } from '../../session/harness/useAccountView';
import { chooseAccount, useHarnessStatus } from '../../session/harness/select';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { signInBasic, type BasicHarness } from '../../session/harness/acp';
import { recheckHarness } from '../../session/harness/harnessRuns';
import { errorText } from '../../lib/ignored';
import { basicRowState, firstClassRowState, type RowAction, type RowState } from '../../harness/rowState';
import { knownIssueExit, knownIssueFor } from '../../harness/knownIssues';
import { compareVersions } from '../../harness/compat';
import type { AppState } from '../../store/state';
import { ChevronRight } from '../ui/icons';
import { LimitMeters } from '../accounts/meters';
import { BasicBadge, BasicHarnessIcon, signInHarness } from '../harnessPicker/badges';
import { PARTS } from './parts';
import { UpdateFlow, UpdatePill, useHarnessUpdate, type HarnessUpdate } from './HarnessUpdate';

/** "Default" beside the harness new chats start on, as saved (New chats use above says what runs when it can't). */
function DefaultMark({ kind }: { kind: string }) {
  const on = useStore((s) => savedDefaultHarness(s) === kind);
  return on ? <span className="hrow-default">Default</span> : null;
}

/** Whether a CLI location was set for a first-class harness: then a CLI that can't run is fixed by choosing another. */
const CUSTOM_BIN: Record<HarnessId, (s: AppState) => boolean> = { codex: (s) => !!s.codexBin, claude: (s) => !!s.prefs.claudeBin };

/** A known problem with the installed version: what breaks and how to get out, with Update when that is the way. */
function KnownIssueNote({ kind, label, version, u, button }: Pick<ShellProps, 'kind' | 'label' | 'version' | 'u'> & { button: boolean }) {
  const issue = knownIssueFor(kind, version);
  if (!issue) return null;
  const canUpdateTo = u?.v.updatable ? u.v.latest : null;
  const updates = !!(canUpdateTo && issue.fixedIn && compareVersions(canUpdateTo, issue.fixedIn) >= 0);
  return (
    <div className="hrow-warn" role="note" data-known-issue={kind}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M8 2l6.5 11.5h-13L8 2z" />
        <path d="M8 6.5v3M8 11.5v.01" />
      </svg>
      <span className="hrow-warn-text">
        {label} {version} {issue.text}. {knownIssueExit(issue, label, canUpdateTo)}
      </span>
      {updates && button && (
        <button type="button" className="btn-pill" onClick={() => void u!.update()}>
          Update
        </button>
      )}
    </div>
  );
}

interface ShellProps {
  kind: string;
  label: string;
  version: string | null | undefined;
  icon: ReactNode;
  badge?: ReactNode;
  state: RowState;
  /** the account line, shown while the state has no line of its own */
  who: string | undefined;
  account?: string;
  meters?: ReactNode;
  u: HarnessUpdate | null;
  act: (a: RowAction) => void;
  open: () => void;
}

/** One row: the harness's mark and name, its state's line or account line, meters, one button and its notes. */
function RowShell({ kind, label, version: own, icon, badge, state, who, account, meters, u, act, open }: ShellProps) {
  // the harness's own word for its version, else main's (an idle Codex has not said yet)
  const version = own ?? u?.v.installed;
  const line = state.line ?? who;
  // one button at most: the state's own, else the known problem's Update, else the update pill
  const issue = knownIssueFor(kind, version);
  return (
    <div className="hrow-item" data-harness-row={kind} data-row-state={state.kind}>
      <div className="hrow">
        <span className="hrow-mark">{icon}</span>
        <span className="hrow-text">
          <span className="hrow-name">
            {/* the row's own button: it covers the row, so a click anywhere but another button opens the page */}
            <button type="button" className="hrow-open" onClick={open}>
              {label}
            </button>
            {badge}
            <DefaultMark kind={kind} />
            {u && !state.action && !issue && <UpdatePill u={u} />}
          </span>
          <span className="hrow-sub" data-account={account} title={line}>
            {line}
          </span>
        </span>
        {meters}
        {state.action && (
          <button
            type="button"
            className={`btn-pill hrow-action ${state.kind === 'signin' ? 'primary' : ''}`}
            onClick={() => act(state.action!)}
          >
            {state.action.label}
          </button>
        )}
        <ChevronRight size={15} className="hrow-chevron" />
      </div>
      <KnownIssueNote kind={kind} label={label} version={version} u={u} button={!state.action} />
      {u && <UpdateFlow u={u} />}
    </div>
  );
}

/** Re-check a harness; a check that throws says why. */
const recheck = (kind: string, label: string) =>
  void recheckHarness(kind).catch((e) => toast(`Couldn't check ${label}: ${errorText(e)}`, 'error'));

/** A first-class harness: its state, the account in use and how many there are, and what is left. */
export function HarnessRow({ h }: { h: HarnessId }) {
  const view = useAccountView(h);
  const { version } = useHarnessStatus(h);
  const customBin = useStore(CUSTOM_BIN[h]);
  const u = useHarnessUpdate(h, HARNESS_LABEL[h]);
  const Icon = PARTS[h].Icon;
  const { accounts, active } = view;
  const n = accounts.length;
  const state = firstClassRowState(view, customBin);
  // a login that is not simply signed in says how it is beside its name, never "Signed in"
  const who = active
    ? [
        active.name,
        active.plan,
        active.state === 'signed-in' || active.state === 'billed' ? null : active.status.text,
        n > 1 ? `${n} accounts` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : (view.empty?.hint ?? view.empty?.title);
  const act = (a: RowAction) => {
    if (a.do === 'signin') return void signInHarness(h);
    if (a.do === 'relogin' || a.do === 'use') return void chooseAccount(a.account);
    if (a.do === 'location') return navigate({ name: 'settings', section: h, tab: 'advanced' });
    recheck(h, HARNESS_LABEL[h]);
  };
  const metered = active && (state.kind === 'ready' || state.kind === 'limit');
  return (
    <RowShell
      kind={h}
      label={HARNESS_LABEL[h]}
      version={version}
      icon={<Icon size={20} />}
      state={state}
      who={who}
      account={active?.key}
      meters={metered ? <LimitMeters windows={active.windows} /> : null}
      u={u}
      act={act}
      open={() => navigate({ name: 'settings', section: h })}
    />
  );
}

/** An installed basic harness: it signs in and bills on its own, so its row says so, or what it needs. */
export function BasicRow({ b }: { b: BasicHarness }) {
  const kind = `acp:${b.id}`;
  const u = useHarnessUpdate(kind, b.label);
  const state = basicRowState({ label: b.label, state: b.state, reason: b.reason, signsIn: b.authMethods.length > 0 || !!b.login });
  const act = (a: RowAction) => (a.do === 'signin' ? signInBasic(b.id) : recheck(kind, b.label));
  return (
    <RowShell
      kind={kind}
      label={b.label}
      version={b.version}
      icon={<BasicHarnessIcon id={b.id} size={20} />}
      badge={b.state === 'admitted' ? <BasicBadge id={b.id} /> : null}
      state={state}
      who={undefined}
      account={kind}
      u={u}
      act={act}
      open={() => navigate({ name: 'settings', section: 'other-harnesses' })}
    />
  );
}
