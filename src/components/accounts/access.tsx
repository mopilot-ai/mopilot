// Browser sign-in dialog and account/app-server recovery banners.
import { useEffect } from 'react';
import { useStore, toast, toastFailure } from '../../store/core';
import { navigate } from '../../store/panes';
import { cancelAccountLogin } from '../../store/accounts';
import { restartCodex } from '../../store/connection';
import { native } from '../../lib/native';
import { openLink } from '../../session/open';
import { PARTS } from '../harness/parts';
import { AlertTriangle, Spinner, X, Copy } from '../ui/icons';
import { codexCopyName } from '../../harness/codexQuit';
import { CodexQuitActions } from '../harness/codex/QuitActions';
import { imeComposing } from '../../lib/focus';

export function AccountSignInDialog() {
  const login = useStore((s) => s.accounts.login);
  const target = useStore((s) => (login?.targetId ? s.accounts.accounts.find((a) => a.id === login.targetId) : null));
  useEffect(() => {
    if (!login) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && cancelAccountLogin();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [login]);
  if (!login) return null;
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancelAccountLogin()}>
      <div className="dialog acct-dialog">
        <div className="dialog-head">
          <span>{target ? `Sign in again as ${target.email ?? 'this account'}` : 'Add a ChatGPT account'}</span>
          <button className="icon-btn xs" onClick={() => cancelAccountLogin()} aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
        <div className="acct-dialog-wait">
          <Spinner size={14} /> Finish signing in in your browser…
        </div>
        <details className="acct-dialog-hint">
          <summary>Having trouble?</summary>
          <p>
            {target
              ? `Sign in with ${target.email ?? 'the same account'} to restore it. Signing in with a different account adds it as a new one.`
              : 'Already signed in? Open the sign-in link in a private window.'}
          </p>
        </details>
        <div className="acct-dialog-actions">
          <button className="btn ghost sm" onClick={() => native.clipboard.write(login.authUrl).then(() => toast('Sign-in link copied'))}>
            <Copy size={13} /> Copy link
          </button>
          <button className="btn ghost sm" onClick={() => openLink(login.authUrl)}>
            Open again
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => cancelAccountLogin()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* banner when the account in use can't be refreshed                  */
/* ------------------------------------------------------------------ */
export function AccountExpiredBanner() {
  // the stack keeps to a share of the window, scrolling past it, so the chat under it keeps room (#2119, #2120)
  return (
    <div className="acct-banners">
      <CodexQuitBanner />
      {Object.entries(PARTS).map(([id, p]) => (p.Banner ? <p.Banner key={id} /> : null))}
    </div>
  );
}

/** Codex's app-server quit: main restarts it a few times with backoff (A23), then asks the user. */
function CodexQuitBanner() {
  const r = useStore((s) => s.codexRestart);
  // the copy that quit as it started, named with what to do about it
  const quit = useStore((s) => s.codexQuit);
  if (!r) return null;
  if (r !== 'gaveUp')
    return (
      <div className="acct-banner" role="status">
        <Spinner size={14} />
        <span className="acct-banner-text">
          <b>Codex</b> quit. Restarting it{r.attempt > 1 ? ` (try ${r.attempt})` : ''}…
        </span>
      </div>
    );
  const restart = () => restartCodex().catch(toastFailure("Couldn't restart Codex"));
  return (
    <div className="acct-banner" role="alert">
      <AlertTriangle size={14} />
      <span className="acct-banner-text">
        <b>{quit ? codexCopyName(quit.copy) : 'Codex'}</b> keeps quitting, so MoPilot stopped restarting it.
        {quit?.pinned ? " It's the copy you picked." : ''}
      </span>
      <span className="acct-banner-actions">
        {quit ? (
          <CodexQuitActions />
        ) : (
          <button className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'codex', tab: 'advanced' })}>
            Settings
          </button>
        )}
        <button className="btn primary sm" onClick={restart}>
          Restart Codex
        </button>
      </span>
    </div>
  );
}
