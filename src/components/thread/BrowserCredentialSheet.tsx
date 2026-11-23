// Above the composer while an agent waits on browser_request_credentials, for every harness: the exact site and fields MoPilot fills, the user's login (typed, or saved in MoPilot), and Fill, "I'll sign in myself" or Decline.
//
// The values go from here to main only (native.browser.credentialAnswer), which fills them into the
// page (electron/capabilities/browser/credentials.cjs); they never enter the chat, the agent's tool
// result or the thread. Saved logins are listed by username only: their passwords stay in main.
import { useEffect, useState, type FormEvent } from 'react';
import { chatOf } from '../../store/chats';
import { native, type CredentialAnswer, type CredentialRequestView } from '../../lib/native';
import { hostOf } from '../../lib/agentNarration';
import { KeyRound } from '../ui/icons';

type Kind = CredentialRequestView['fields'][number]['kind'];

const LABEL: Record<Kind, string> = { username: 'Username or email', password: 'Password', otp: 'One-time code' };
const INPUT: Record<Kind, { type: string; autoComplete: string }> = {
  username: { type: 'text', autoComplete: 'username' },
  password: { type: 'password', autoComplete: 'current-password' },
  otp: { type: 'text', autoComplete: 'one-time-code' },
};

/** The open sheets, kept in step with main. */
function useCredentialRequests(): CredentialRequestView[] {
  const [list, setList] = useState<CredentialRequestView[]>([]);
  useEffect(() => {
    let live = true;
    void native.browser.credentialRequests().then((l) => {
      // an older main without the sheet answers nothing
      if (live) setList(Array.isArray(l) ? l : []);
    });
    const off = native.browser.onCredentialRequests(setList);
    return () => {
      live = false;
      off();
    };
  }, []);
  return list;
}

export function BrowserCredentialSheet({ threadId }: { threadId: string }) {
  const req = useCredentialRequests().find((r) => r.chatId === threadId || chatOf(r.chatId) === threadId);
  // a new sheet starts empty: nothing typed for one site carries over to another
  return req ? <CredentialForm key={req.id} req={req} /> : null;
}

/** The fill answer: the typed values of the fields shown, or a saved login (with a typed one-time code). */
export function fillAnswer(
  fields: CredentialRequestView['fields'],
  values: Partial<Record<Kind, string>>,
  savedId: string,
  save: boolean,
): CredentialAnswer {
  const picked: Partial<Record<Kind, string>> = {};
  for (const f of fields) if (values[f.kind] && (!savedId || f.kind === 'otp')) picked[f.kind] = values[f.kind];
  return { action: 'fill', values: picked, savedId: savedId || null, save: !savedId && save };
}

function CredentialForm({ req }: { req: CredentialRequestView }) {
  const [values, setValues] = useState<Partial<Record<Kind, string>>>({});
  const [savedId, setSavedId] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = hostOf(req.origin);
  // a saved login fills the username and password; only a one-time code is still typed
  const shown = req.fields.filter((f) => !savedId || f.kind === 'otp');
  const ready = !!savedId || shown.some((f) => values[f.kind]);
  const send = (answer: CredentialAnswer) => {
    setBusy(true);
    setValues({});
    void native.browser.credentialAnswer(req.id, answer);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !busy) send(fillAnswer(req.fields, values, savedId, save));
  };
  return (
    <form className="credential-sheet" role="dialog" aria-label={`Sign in to ${host}`} onSubmit={submit}>
      <div className="credential-head">
        <span className="credential-icon">
          <KeyRound size={14} />
        </span>
        <div>
          <div className="credential-title">Sign in to {host}</div>
          <div className="credential-origin">
            {req.origin}
            {req.frameOrigin && <> · fields from {req.frameOrigin}</>}
          </div>
        </div>
      </div>
      {req.reason && <div className="credential-reason">{req.reason}</div>}
      <div className="credential-note">MoPilot fills this into the page. The agent never sees it.</div>
      {req.saved.length > 0 && (
        <div className="credential-saved">
          <select aria-label="Saved login" value={savedId} onChange={(e) => setSavedId(e.target.value)}>
            <option value="">Type a login</option>
            {req.saved.map((s) => (
              <option key={s.id} value={s.id}>
                {s.username || 'Saved login'}
              </option>
            ))}
          </select>
          {savedId && (
            <button
              type="button"
              className="btn-pill"
              onClick={() => {
                void native.browser.credentialForget(savedId);
                setSavedId('');
              }}
            >
              Forget
            </button>
          )}
        </div>
      )}
      {shown.map((f) => (
        <label key={f.kind} className="credential-field">
          <span>{f.label || LABEL[f.kind]}</span>
          <input
            {...INPUT[f.kind]}
            aria-label={LABEL[f.kind]}
            value={values[f.kind] ?? ''}
            spellCheck={false}
            onChange={(e) => setValues((v) => ({ ...v, [f.kind]: e.target.value }))}
          />
        </label>
      ))}
      {req.canSave && !savedId && req.fields.some((f) => f.kind === 'password') && (
        <label className="credential-save">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save in MoPilot for {host}
        </label>
      )}
      <div className="credential-actions">
        <button type="button" className="btn-pill" disabled={busy} onClick={() => send({ action: 'decline' })}>
          Decline
        </button>
        <button type="button" className="btn-pill" disabled={busy} onClick={() => send({ action: 'takeover' })}>
          I'll sign in myself
        </button>
        <button type="submit" className="btn-pill primary" disabled={!ready || busy}>
          Fill
        </button>
      </div>
    </form>
  );
}
