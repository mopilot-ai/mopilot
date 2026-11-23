// /design-login in a Claude Code chat: Claude Design's sign-in on the chat's account, with the page it opened and a field for a pasted code.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { get as getState, toast } from '../../store/core';
import { errorText, noteIgnored } from '../../lib/ignored';
import { claudeChatAccount } from '../../session/harness/claude/accounts';
import { Modal } from '../ui/Modal';
import { isEnter } from '../../lib/focus';

export { OPEN_DESIGN_LOGIN } from './designLoginEvent';

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; url: string | null; manualUrl: string | null; manualFirst: boolean; sent: boolean }
  | { kind: 'failed'; message: string };

/** Try again starts over with a fresh sign-in (a new mount, so nothing of the failed one is kept). */
export function DesignLoginDialog({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  return <SignIn key={attempt} threadId={threadId} onClose={onClose} onRetry={() => setAttempt((n) => n + 1)} />;
}

/** One sign-in (main's claude:designLogin, one at a time); closing it stops the run if it is still going. */
function SignIn({ threadId, onClose, onRetry }: { threadId: string | null; onClose: () => void; onRetry: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [code, setCode] = useState('');
  const run = useRef<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // a fresh id per run, so the end of a run this dialog stopped (a retry, an effect run twice) is never read as this one's
    const id = crypto.randomUUID();
    run.current = id;
    const off = native.claude.onDesignLogin((e) => {
      if (e.id !== id) return;
      if (e.kind === 'pages')
        return setPhase({ kind: 'waiting', url: e.url, manualUrl: e.manualUrl, manualFirst: e.manualFirst, sent: false });
      if (!e.ok) return setPhase({ kind: 'failed', message: e.message ?? 'The sign-in failed. Try again.' });
      toast('Claude Design is authorized for this account');
      close.current();
    });
    const account = threadId ? claudeChatAccount(threadId) : getState().claudeAccounts.active;
    native.claude
      .designLogin(id, getState().prefs.claudeBin, account)
      .catch((e) => run.current === id && setPhase({ kind: 'failed', message: errorText(e) }));
    return () => {
      off();
      run.current = null;
      // main leaves a run that already ended alone
      native.claude.designLoginCancel(id).catch((e) => noteIgnored('stop a Claude Design sign-in', e));
    };
  }, [threadId]);

  const submit = async () => {
    const id = run.current;
    if (!id || !code.trim()) return;
    try {
      const sent = await native.claude.designLoginCode(id, code);
      if (run.current !== id) return;
      if (!sent) return toast('This sign-in has ended. Try again.', 'error');
      setPhase((p) => (p.kind === 'waiting' ? { ...p, sent: true } : p));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const open = (url: string) => native.shell.openExternal(url).catch((e) => toast(errorText(e), 'error'));

  return (
    <Modal title="Sign in to Claude Design" onClose={onClose}>
      {phase.kind === 'starting' && <p className="acct-dialog-hint">Starting the sign-in…</p>}
      {phase.kind === 'failed' && <p className="acct-dialog-hint">{phase.message}</p>}
      {phase.kind === 'waiting' && <Waiting phase={phase} code={code} setCode={setCode} submit={submit} open={open} />}
      <div className="sketch-foot">
        <button className="btn-pill" onClick={onClose}>
          {phase.kind === 'failed' ? 'Close' : 'Cancel'}
        </button>
        {phase.kind === 'failed' && (
          <button className="btn-white" onClick={onRetry}>
            Try again
          </button>
        )}
        {phase.kind === 'waiting' && (
          <button className="btn-white" disabled={!code.trim()} onClick={submit}>
            Submit code
          </button>
        )}
      </div>
    </Modal>
  );
}

/** The browser has the sign-in page: finish there, or paste the code the page shows. */
function Waiting({
  phase,
  code,
  setCode,
  submit,
  open,
}: {
  phase: Extract<Phase, { kind: 'waiting' }>;
  code: string;
  setCode: (c: string) => void;
  submit: () => void;
  open: (url: string) => void;
}) {
  // the page main opened first, and (when that one signs in by itself) the one that shows a code
  const page = phase.manualFirst ? phase.manualUrl : phase.url;
  const codePage = phase.manualFirst ? null : phase.manualUrl;
  return (
    <>
      <p className="acct-dialog-hint">
        {phase.manualFirst
          ? 'Sign in to claude.ai on the page that opened in your browser, then paste the code it shows here.'
          : 'Finish signing in to claude.ai in your browser. This closes by itself when you are done.'}
      </p>
      <div className="dialog-chips">
        {page && (
          <button className="dialog-chip" onClick={() => open(page)}>
            Open the sign-in page again
          </button>
        )}
        {codePage && (
          <button className="dialog-chip" onClick={() => open(codePage)}>
            Sign in with a code instead
          </button>
        )}
      </div>
      <input
        className="text-input"
        placeholder="Paste the code from the sign-in page"
        aria-label="Code from the sign-in page"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => isEnter(e) && submit()}
      />
      {phase.sent && <p className="acct-dialog-hint">Checking the code…</p>}
    </>
  );
}
