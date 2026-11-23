// A harness page's header (its mark and name once, its state, its version and update, its own buttons, and a word
// only when the installed version will not work), and the Overview tab's
// account card: who the harness runs as, the Switch menu the profile menu shares, what is left in each window,
// and a link to Accounts & billing. Harness-neutral: what differs comes from the harness's parts.
import { Suspense, useEffect } from 'react';
import { addHarnessAccount, chooseAccount, useHarnessStatus, verifyAccount } from '../../session/harness/select';
import { useAccountView } from '../../session/harness/useAccountView';
import { phaseLabelOf } from '../../harness/accountView';
import { COPY } from '../../harness/copy';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { Menu, MenuItem, MenuSeparator, useAnchor } from '../ui/Popover';
import { ChevronDown, UserRound } from '../ui/icons';
import { AccountAvatar, accountAvatars } from '../accounts/presentation';
import { AccountChoices, manageAccounts } from '../accounts/menu';
import { LimitMeters } from '../accounts/meters';
import { signInHarness } from '../harnessPicker/HarnessPicker';
import { Group } from '../pages/Settings';
import { PARTS } from './parts';
import { harnessInfo } from '../../harness/registry';
import { versionWarning } from '../../harness/compat';
import { HarnessVersionLine } from './HarnessVersionLine';
import { checkHarnessUpdates, useVersionOf } from '../../harness/harnessUpdates';

/** The page's title: the harness's mark and name, then its state, then its version line with any update. */
export function HarnessHeader({ h }: { h: HarnessId }) {
  const st = useHarnessStatus(h);
  // while an update runs that is the harness's state: its error and old version are what it replaces, so they are not
  // said beside it (#3518); one waiting for chats leaves the harness as it is until it starts
  const updating = useVersionOf(h)?.state === 'updating';
  const phaseLabel = updating ? { text: 'Updating', tone: '' } : phaseLabelOf(st);
  const parts = PARTS[h];
  // only a version that will not work is worth a word, one sentence; the error a too-old version starts with says the
  // same, so it is left out; an untested version works as usual
  const warning = updating ? null : versionWarning(harnessInfo(h)?.versions, st.version);
  const error = updating || warning ? null : st.error;
  const binary = parts.useBinary(st);
  // main's own check waits a day after launch: the page reads the versions when it opens, as All harnesses does
  useEffect(() => {
    void checkHarnessUpdates();
  }, []);
  return (
    <div className="harness-head">
      <span className="harness-head-mark">
        <parts.Icon size={28} />
      </span>
      <div className="harness-head-text">
        <h1 className="settings-title harness-head-title">{HARNESS_LABEL[h]}</h1>
        <div className="harness-head-meta" title={st.version ? `Version ${st.version}` : undefined}>
          <span className={`harness-dot ${phaseLabel.tone}`} />
          {phaseLabel.text}
        </div>
        {error && <div className="harness-head-error">{error.split('\n')[0]}</div>}
        {warning && <div className="harness-head-warn">{warning}</div>}
        {/* its version and update live here, not on the All harnesses row */}
        <HarnessVersionLine kind={h} label={HARNESS_LABEL[h]} binary={binary} />
      </div>
      {parts.CardAction && <parts.CardAction />}
    </div>
  );
}

/** Who the harness runs as, with the Switch menu, the usage left and the way to Accounts & billing. */
export function AccountCard({ h }: { h: HarnessId }) {
  const view = useAccountView(h);
  const menu = useAnchor<HTMLButtonElement>();
  const parts = PARTS[h];
  const { accounts, active, empty } = view;
  if (view.phase === 'missing' || !active)
    return (
      <Group title="Account">
        <div className="acct-card">
          <div className="acct-card-head">
            <div className="acct-card-text">
              <div className="acct-card-name">{empty?.title ?? view.phaseLabel.text}</div>
              {view.phase === 'missing' && <div className="acct-card-sub">{parts.missingHint}</div>}
              {empty?.hint && <div className="acct-card-sub">{empty.hint}</div>}
            </div>
            {view.phase === 'signed-out' && (
              <button className="btn-pill primary" onClick={() => signInHarness(h)}>
                {parts.signInLabel}
              </button>
            )}
          </div>
          {/* a sign-in started here runs here, not on another page */}
          {parts.LoginTerm && (
            <Suspense fallback={null}>
              <parts.LoginTerm />
            </Suspense>
          )}
        </div>
      </Group>
    );
  const at = accounts.findIndex((r) => r.active);
  const avatar = at < 0 ? undefined : accountAvatars(accounts.map((r) => r.account))[at];
  // the account in use counts even when the switcher does not list it (MoPilot credits)
  const n = accounts.length + (at < 0 ? 1 : 0);
  // the meters, or the billing note, say how a signed-in login is doing; any other state is said under the name
  const plain = active.state === 'signed-in' || active.state === 'billed';
  return (
    <Group title="Account">
      <div className="acct-card" data-account={active.key}>
        <div className="acct-card-head">
          <AccountAvatar account={active.account} size={36} label={avatar} />
          <div className="acct-card-text">
            <div className="acct-card-name">{active.name}</div>
            <div className={`acct-card-sub acct-status ${plain ? '' : active.status.tone}`}>
              {[active.plan, plain ? null : active.status.text].filter(Boolean).join(' · ')}
            </div>
          </div>
          <span className="acct-card-actions">
            {active.action === 'relogin' && (
              <button className="btn-pill primary" onClick={() => chooseAccount(active.account)}>
                Sign in again
              </button>
            )}
            {active.action === 'verify' && (
              <button className="btn-pill primary" onClick={() => verifyAccount(active.account)}>
                {COPY.accounts.verify}
              </button>
            )}
            {n > 1 ? (
              <button ref={menu.ref} className="btn-pill" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
                Switch <ChevronDown size={13} />
              </button>
            ) : (
              <button className="btn-pill" onClick={() => addHarnessAccount(h)}>
                Add account
              </button>
            )}
          </span>
        </div>
        {active.state !== 'lapsed' &&
          (active.state === 'billed' ? (
            <div className="acct-card-note">{active.status.text}</div>
          ) : active.windows.length ? (
            <LimitMeters windows={active.windows} variant="detail" />
          ) : (
            <div className="acct-card-note">{parts.usageHint}</div>
          ))}
        <div className="acct-card-foot">
          <span>{n === 1 ? '1 account' : `${n} accounts`}</span>
          <button className="text-link" onClick={() => manageAccounts(h, active.account.id)}>
            Manage accounts
          </button>
        </div>
        {parts.LoginTerm && (
          <Suspense fallback={null}>
            <parts.LoginTerm />
          </Suspense>
        )}
      </div>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={290}>
        <AccountChoices h={h} />
        <MenuSeparator />
        <MenuItem icon={<UserRound size={15} />} onSelect={() => manageAccounts(h, active.account.id)}>
          Manage accounts…
        </MenuItem>
      </Menu>
    </Group>
  );
}
