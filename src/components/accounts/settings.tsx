// Account settings, login-terminal state and usage rows for Codex and Claude.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useEffect, type ReactNode } from 'react';
import { useEffectOn } from '../../lib/effects';
import { useStore, toast, toastFailure } from '../../store/core';
import { addAccount, refreshAccountsUsage, login } from '../../store/accounts';
import { ensureCodex } from '../../store/connection';
import { errorText, noteIgnored } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { ClaudeLoginTerm } from './claudeLoginTerm';
import { Group, Row } from '../pages/Settings';
import { chooseAccount, removeHarnessAccount, useHarnessStatus, verifyAccount } from '../../session/harness/select';
import { useAccountView } from '../../session/harness/useAccountView';
import type { AccountRowView } from '../../harness/accountView';
import { COPY } from '../../harness/copy';
import {
  addClaudeAccount,
  cancelClaudeLogin,
  recheckClaude,
  refreshClaudeAccounts,
  refreshClaudeUsage,
  useClaudeLoginTerm,
} from '../../session/harness/claude';
import { Ellipsis, Plus, RefreshCw } from '../ui/icons';
import { Menu, MenuItem, useAnchor } from '../ui/Popover';

import { AccountAvatar, accountAvatars, type AvatarLabel } from './presentation';
import { LimitMeters } from './meters';
import { signInHarness } from '../harnessPicker/HarnessPicker';
import { pluralize } from '../../lib/format';

/** What goes under a harness's accounts, given its Add account button (null while it has none): Accounts & billing's
 * Use an API key and automatic switching. Without it the button stands alone. */
type Footer = (add: ReactNode) => ReactNode;

export function AccountsSettings({ only, footer = (add) => add }: { only?: 'codex'; footer?: Footer }) {
  const { accounts: managed } = useStore((s) => s.accounts);
  const view = useAccountView('codex');
  useEffect(() => {
    // the page is about who Codex runs as: a Codex left for first use starts, so "not signed in" is known, not assumed.
    // Cannot reject: a start that fails is shown as the connection's error
    void ensureCodex();
    // usage figures are optional; the next refresh retries
    refreshAccountsUsage('surface').catch((e) => noteIgnored("refresh the Codex accounts' usage for Settings", e));
  }, []);

  if (view.empty && !view.accounts.length) {
    return (
      <>
        <Group>
          <Row title={`Codex: ${view.empty.title}`} desc={view.empty.hint ?? undefined}>
            <button className="btn primary sm" onClick={() => login().catch(toastFailure("Couldn't start signing in to Codex"))}>
              Sign in
            </button>
          </Row>
          {footer(null)}
        </Group>
        {!only && <ClaudeAccount />}
      </>
    );
  }

  const avatars = accountAvatars(view.accounts.map((r) => r.account));
  // the CLI's own login itself; an added account it is folded into goes alone, and the CLI login stays (#1312)
  const signsOut = (r: AccountRowView) => !!r.cli && !Object.values(view.same).includes(r.account.id);
  const confirmRemove = (r: AccountRowView) => {
    const who = r.account.email ?? 'this account';
    const msg = signsOut(r) ? `Sign ${who} out of Codex on this computer?` : `Remove ${who} from Codex on this computer?`;
    if (confirm(msg)) removeHarnessAccount(r.account).catch((e) => toast(errorText(e), 'error'));
  };

  return (
    <>
      <Group>
        {view.accounts.map((r, i) => (
          <AccountListRow
            key={r.key}
            row={r}
            avatar={avatars[i]}
            onAction={() => chooseAccount(r.account)}
            // the app-server's own login before the account manager lists it is not one it can remove
            removeLabel={managed.length ? (signsOut(r) ? 'Sign out' : 'Remove') : null}
            onRemove={() => confirmRemove(r)}
          />
        ))}
        {footer(
          <button type="button" className="acct-add" onClick={() => addAccount()}>
            <Plus size={13} /> Add account
          </button>,
        )}
      </Group>
      {!only && <ClaudeAccount />}
    </>
  );
}

/** Read every Codex account's usage again: the button beside the OpenAI heading. */
export function RefreshCodexButton() {
  return (
    <button
      className="btn-pill icon"
      onClick={() => refreshAccountsUsage('now').catch((e) => toast(errorText(e), 'error'))}
      title="Refresh usage"
      aria-label="Refresh usage"
    >
      <RefreshCw size={13} />
    </button>
  );
}

/** Read the Claude Code logins, their sign-in and usage again: the button beside the Anthropic heading. */
export function RefreshClaudeButton() {
  return (
    <button
      className="btn-pill icon"
      onClick={() =>
        (
          // the user asked for it: a list that couldn't be read again says so (recheckClaude reports sign-in)
          refreshClaudeAccounts().catch((e) => toast(`Couldn't refresh the Claude Code accounts: ${errorText(e)}`, 'error')),
          recheckClaude()
        )}
      title="Re-check sign-in and usage"
      aria-label="Re-check sign-in and usage"
    >
      <RefreshCw size={13} />
    </button>
  );
}

/**
 * Claude Code's accounts. The first is the CLI's own login; added ones each run the CLI with their
 * own config folder. Sage never stores the logins: sign-in and sign-out run `claude auth …` in a terminal.
 */
export function ClaudeAccount({ footer = (add) => add }: { footer?: Footer }) {
  const st = useHarnessStatus('claude');
  const view = useAccountView('claude');
  const pool = useStore((s) => s.claudeAccounts);
  // a sign-in already running in the terminal below
  const loginTerm = useClaudeLoginTerm();
  const n = view.accounts.length;
  const avatars = accountAvatars(view.accounts.map((r) => r.account));
  // read again when Claude Code becomes ready and when an account is added or removed
  useEffectOn([n, st.state], () => {
    if (st.state === 'ready')
      // usage figures are optional; the rows show without them
      refreshClaudeUsage().catch((e) => noteIgnored("refresh the Claude Code accounts' usage for Settings", e));
  });
  const confirmRemove = (r: AccountRowView) => {
    // an unverified login's email may be another account's (harness/claude/loginIdentity.cjs)
    const who = r.account.unverified ? 'this account' : (r.account.email ?? 'this account');
    const msg =
      r.account.id === 'default' ? `Sign ${who} out of Claude Code on this computer?` : `Sign ${who} out and remove it from MoPilot?`;
    // removeClaudeAccount says why the sign-out itself failed; what it does after (re-detecting) can still throw
    if (confirm(msg)) removeHarnessAccount(r.account).catch(toastFailure("Couldn't sign the account out"));
  };
  return (
    <>
      <Group>
        {view.phase === 'missing' ? (
          <Row title="Claude Code isn’t installed" desc="Install Claude Code, or set where it is in Settings → Claude Code.">
            <button className="btn-pill" onClick={() => openLink('https://code.claude.com/docs/en/setup')}>
              Install
            </button>
          </Row>
        ) : (
          <>
            {/* no login yet: what it says is the account view's, as on the harness page and in the profile menu */}
            {view.empty && !n && (
              <Row title={`Claude Code: ${view.empty.title}`} desc={view.empty.hint ?? undefined}>
                {/* as Codex's row: signed out, signing in is what it needs (#1867) */}
                {view.phase === 'signed-out' && !pool.login && !loginTerm && (
                  <button className="btn primary sm" onClick={() => signInHarness('claude')}>
                    Sign in
                  </button>
                )}
              </Row>
            )}
            {view.accounts.map((r, i) => (
              <AccountListRow
                key={r.key}
                row={r}
                avatar={avatars[i]}
                notes={r.active && view.error ? [{ text: view.error, tone: 'warn' }] : r.note ? [{ text: r.note, tone: 'muted' }] : []}
                onAction={() => (r.action === 'verify' ? verifyAccount(r.account) : chooseAccount(r.account))}
                removeLabel={r.account.id === 'default' ? 'Sign out' : 'Remove'}
                onRemove={() => confirmRemove(r)}
              />
            ))}
            {pool.login ? (
              <Row title="Finish signing in in Terminal">
                <button className="btn-pill" onClick={() => cancelClaudeLogin()}>
                  Cancel
                </button>
              </Row>
            ) : (
              footer(
                <button type="button" className="acct-add" onClick={() => addClaudeAccount()} disabled={!st.bin}>
                  <Plus size={13} /> Add account
                </button>,
              )
            )}
          </>
        )}
        <ClaudeLoginTerm />
      </Group>
    </>
  );
}

/** An account row's ⋯ menu: what is done to an account less often than using it (Sign out, Remove). */
function RowMenu({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }) {
  const menu = useAnchor<HTMLButtonElement>();
  return (
    <>
      <button
        ref={menu.ref}
        className="btn-pill icon"
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Ellipsis size={14} />
      </button>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={180}>
        <MenuItem danger onSelect={onRemove}>
          {removeLabel}
        </MenuItem>
      </Menu>
    </>
  );
}

/** A note under an account row, in the tone of an account status. */
interface RowNote {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
}

/**
 * One account in Accounts & billing, for every harness: avatar, name, plan, "In use", what it is and how it is
 * doing, one main action (Use, or Sign in again when its login lapsed), Sign out or Remove, and its usage meters.
 * Everything shown comes from the account view (harness/accountView.ts).
 */
export function AccountListRow({
  row,
  avatar,
  notes = [],
  onAction,
  removeLabel,
  onRemove,
}: {
  row: AccountRowView;
  avatar?: AvatarLabel;
  notes?: RowNote[];
  onAction: () => void;
  /** null: nothing to sign out or remove from here */
  removeLabel: string | null;
  onRemove: () => void;
}) {
  const { name, plan, active, cli, status, chats, action, windows } = row;
  // the meters already say how much is left; the line keeps a status that says something else
  const said = windows.length > 0 && status.tone === 'ok' ? '' : status.text;
  const line = [cli, said, chats > 0 ? pluralize(chats, 'chat') : ''].filter(Boolean).join(' · ');
  return (
    <div data-account={row.key} className={`acct-row ${active ? 'active' : ''}`}>
      <div className="acct-row-main">
        <AccountAvatar account={row.account} size={28} label={avatar} />
        <div className="acct-row-text">
          <div className="acct-row-title">
            <span className="acct-email">{name}</span>
            {plan && <span className="acct-chip">{plan}</span>}
            {active && <span className="acct-chip on">In use</span>}
          </div>
          {line && <div className={`acct-status ${status.tone}`}>{line}</div>}
          {notes.map((n) => (
            <div key={n.text} className={`acct-status ${n.tone}`}>
              {n.text}
            </div>
          ))}
        </div>
        <div className="acct-row-actions">
          {action === 'relogin' && (
            <button className="btn primary sm" onClick={onAction}>
              Sign in again
            </button>
          )}
          {action === 'verify' && (
            <button className="btn primary sm" onClick={onAction}>
              {COPY.accounts.verify}
            </button>
          )}
          {action === 'use' && (
            <button className="btn-pill" onClick={onAction}>
              Use
            </button>
          )}
          {removeLabel && <RowMenu label={name} removeLabel={removeLabel} onRemove={onRemove} />}
        </div>
      </div>
      <LimitMeters windows={windows} variant="detail" />
    </div>
  );
}
