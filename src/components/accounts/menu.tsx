// Harness-neutral account menus: the account switcher (the profile submenu and a harness page's Switch
// menu share it), each harness's row in the profile menu, and the row of an installed basic harness.
import { useEffect } from 'react';
import { useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { savedDefaultHarness } from '../../store/chats';
import { chooseDefaultHarness } from '../../store/connection';
import { noteIgnored } from '../../lib/ignored';
import { accountRowTab } from '../../lib/settingsNav';
import { MenuItem, MenuLabel, MenuSeparator, SubMenu } from '../ui/Popover';
import { signInHarness } from '../harnessPicker/HarnessPicker';
import { PARTS } from '../harness/parts';
import { addHarnessAccount, chooseAccount } from '../../session/harness/select';
import { useAccountView } from '../../session/harness/useAccountView';
import { basicAccountView, type AccountRowView } from '../../harness/accountView';
import type { BasicHarness } from '../../harness/types';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { BasicHarnessIcon, HarnessIcon } from '../harnessPicker/HarnessPicker';
import { Check, Plus, AlertTriangle, SquarePen, UserRound } from '../ui/icons';

import { AccountAvatar, accountAvatars } from './presentation';

/** Open Accounts & billing on a harness's account row, or on the page when there is none yet. */
export function manageAccounts(h: HarnessId, accountId: string | null | undefined) {
  navigate({ name: 'settings', section: 'accounts', ...(accountId ? { tab: accountRowTab(h, accountId) } : {}) });
}

/**
 * A harness's accounts as menu items, the one in use checked in a column on the left, each with its plan and
 * what it has left in which window; then Add account (or Sign in when there is none). Picking an account makes
 * it the one new chats use, or signs it in again when its login lapsed.
 */
export function AccountChoices({ h }: { h: HarnessId }) {
  const view = useAccountView(h);
  const { accounts } = view;
  const avatars = accountAvatars(accounts.map((r) => r.account));
  return (
    <>
      {accounts.map((r, i) => (
        <MenuItem
          key={r.key}
          dataAccount={r.key}
          icon={
            <span className="acct-choice">
              <span className="acct-choice-check">{r.active && <Check size={13} strokeWidth={2.2} aria-label="In use" />}</span>
              <AccountAvatar account={r.account} label={avatars[i]} />
            </span>
          }
          description={<span className={`acct-status ${r.status.tone}`}>{[r.plan, r.status.text].filter(Boolean).join(' · ')}</span>}
          right={r.state === 'lapsed' ? <AlertTriangle size={13} className="acct-warn" /> : undefined}
          onSelect={() => chooseAccount(r.account)}
        >
          <span className="acct-email">{r.name}</span>
        </MenuItem>
      ))}
      {view.phase !== 'missing' && (
        <MenuItem
          icon={<Plus size={15} />}
          onSelect={() => (accounts.length || PARTS[h].addsAccountDirectly ? addHarnessAccount(h) : signInHarness(h))}
        >
          {!accounts.length ? 'Sign in…' : view.multi ? 'Add account…' : 'Sign in with another account…'}
        </MenuItem>
      )}
    </>
  );
}

export function HarnessAccountsMenu({ h }: { h: HarnessId }) {
  const view = useAccountView(h);
  const { active, accounts } = view;
  const isDefault = useStore((s) => savedDefaultHarness(s) === h);
  const refreshUsage = PARTS[h].refreshUsage;
  // The profile popover mounts its contents each time it opens.
  useEffect(() => {
    if (view.phase === 'ready' && !view.apiKey)
      // usage figures are optional; the row shows without them
      void refreshUsage?.().catch((e) => noteIgnored(`refresh ${HARNESS_LABEL[h]} usage for the profile menu`, e));
  }, [h, refreshUsage, view.phase, view.apiKey]);
  // the row says who the harness runs as; a login that is lapsed, being checked or not confirmed says so instead
  const description = active ? (
    active.state === 'lapsed' || active.state === 'checking' || active.state === 'unverified' ? (
      <span data-account={active.key} className={`acct-line acct-status ${active.status.tone}`}>
        {active.status.text}
      </span>
    ) : (
      <AccountLine row={active} />
    )
  ) : (
    <span>{[view.empty?.title, view.empty?.hint].filter(Boolean).join(' · ')}</span>
  );
  const n = accounts.length;
  return (
    <SubMenu
      icon={<HarnessIcon h={h} size={15} />}
      label={HARNESS_LABEL[h]}
      description={description}
      shortcut={active && (active.state === 'signed-in' || active.state === 'limited') ? (active.short ?? undefined) : undefined}
      width={290}
    >
      <MenuLabel>{n > 1 ? `${HARNESS_LABEL[h]} · ${n} accounts` : `${HARNESS_LABEL[h]} account`}</MenuLabel>
      <AccountChoices h={h} />
      <MenuSeparator />
      <MenuItem
        icon={<SquarePen size={15} />}
        right={isDefault ? <Check size={14} aria-label="Default" /> : undefined}
        disabled={view.phase === 'missing'}
        onSelect={() => chooseDefaultHarness(h)}
      >
        Default for new chats
      </MenuItem>
      <MenuItem icon={<UserRound size={15} />} onSelect={() => manageAccounts(h, active?.account.id)}>
        Manage accounts…
      </MenuItem>
    </SubMenu>
  );
}

/** "a@x.com · Pro Lite" on one line: a long name ends in an ellipsis, the plan always shows whole. */
function AccountLine({ row }: { row: AccountRowView }) {
  return (
    <span data-account={row.key} className="acct-line acct-split">
      <span className="acct-split-who">{row.name}</span>
      {row.plan && <span className="acct-split-plan"> · {row.plan}</span>}
    </span>
  );
}

/**
 * An installed basic (ACP) harness in the profile menu: it signs in and bills on its own, so its row says that and
 * whether it is signed in, and opens Other harnesses, where its sign-in lives.
 */
export function BasicHarnessMenuRow({ b: harness }: { b: BasicHarness }) {
  const b = basicAccountView(harness);
  return (
    <MenuItem
      dataAccount={`acp:${b.id}`}
      icon={<BasicHarnessIcon id={b.id} size={15} />}
      description={<span className={`acct-line acct-status ${b.tone}`}>{b.line}</span>}
      right={b.signedOut ? <AlertTriangle size={13} className="acct-warn" /> : undefined}
      onSelect={() => navigate({ name: 'settings', section: 'other-harnesses' })}
    >
      {b.label}
    </MenuItem>
  );
}
