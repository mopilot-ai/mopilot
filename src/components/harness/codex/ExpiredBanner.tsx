// Codex's lapsed-sign-in banner (its parts' Banner): only where Codex's login is in play, never in another harness's chat.
import { useStore } from '../../../store/core';
import { switchAccount, addAccount } from '../../../store/accounts';
import { focusedChat } from '../../../store/split';
import { useAccountView } from '../../../session/harness/useAccountView';
import { useComposerFamily } from '../../../session/harness/select';
import { AlertTriangle } from '../../ui/icons';

/** The pooled Codex login in use lapsed: shown in a Codex chat, or outside a chat while new chats start on Codex. */
export function CodexExpiredBanner() {
  const view = useAccountView('codex');
  const activeId = useStore((s) => s.accounts.active);
  // a Claude Code or basic harness's chat runs on no ChatGPT login, so Codex's lapsed one is not its banner
  const family = useComposerFamily(useStore(focusedChat));
  // the pooled login in use whose sign-in expired (the app-server's own login signs in on its own page)
  const a = view.active?.account.id === activeId && view.active.account.status === 'expired' ? view.active.account : null;
  // another login that is signed in and has usage left to move to
  const other = view.accounts.find((r) => !r.active && r.state === 'signed-in' && r.account.left != null)?.account;
  if (!a || family !== 'codex') return null;
  return (
    <div className="acct-banner" role="alert">
      <AlertTriangle size={14} />
      <span className="acct-banner-text">
        Your <b>Codex</b> sign-in for <b>{a.email ?? 'this account'}</b> has expired.
      </span>
      <span className="acct-banner-actions">
        {other && (
          <button className="btn-pill" onClick={() => switchAccount(other.id)}>
            Use {other.email}
          </button>
        )}
        <button className="btn primary sm" onClick={() => addAccount(a.id)}>
          Sign in again
        </button>
      </span>
    </div>
  );
}
