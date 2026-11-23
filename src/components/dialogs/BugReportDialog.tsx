// The bug report dialog (/bug, /feedback, Help → Report a Bug…, Settings → About, a bad response): what happened and
// Send to MoPilot. A report that can't be sent can be retried or saved to a file; a build without the MoPilot service
// saves it and opens a new issue for it instead.
import { useEffect, useRef, useState } from 'react';
import { toast, toastFailure } from '../../store/core';
import { native } from '../../lib/native';
import type { BugInput, BugKind } from '../../lib/native/app';
import { userError } from '../../lib/ignored';
import { copyText } from '../../session/clipboard';
import { chatSnapshot, reportFileName, reportFileText } from '../../session/bugReport';
import type { BugReportRequest } from '../../lib/bugReportEvent';
import { Modal } from '../ui/Modal';
import { busyField } from '../../lib/focus';
import { hasMoPilotService } from '../../lib/mopilotService';
import { NEW_ISSUE_URL } from '../../../shared/community.mjs';

const KINDS: { value: BugKind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'bad_result', label: 'Bad result' },
  { value: 'other', label: 'Other' },
];

/** How a send ended: MoPilot names the report it stored. */
type Outcome = { state: 'sent'; shortId: string } | { state: 'failed'; message: string };
type Send = { state: 'idle' | 'sending' } | Outcome;

export function BugReportDialog({ request, onClose }: { request: BugReportRequest; onClose: () => void }) {
  // read once, when the dialog opens: a chat that changes, switches harness or closes meanwhile sends what was shown
  const [snap] = useState(() => chatSnapshot(request.threadId));
  const [kind, setKind] = useState<BugKind>(request.kind ?? 'bug');
  const [text, setText] = useState('');
  const [mopilot, setMopilot] = useState<Send>({ state: 'idle' });
  // false once the dialog is closed or replaced: a send still running then reports through a toast
  const alive = useRef(false);
  // one send at a time: a second click while one runs does nothing
  const inflight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const input = (): BugInput => ({ kind, description: text, harness: snap.harness, model: snap.model, transcript: snap.transcript });

  const sendToMoPilot = async (i: BugInput) => {
    setMopilot({ state: 'sending' });
    const r: Outcome = await native.app.bug.submit(i).then(
      (res) => (res.ok ? { state: 'sent', shortId: res.shortId } : { state: 'failed', message: userError(res.error) }),
      (e) => ({ state: 'failed', message: userError(e) }),
    );
    if (alive.current) return setMopilot(r);
    if (r.state === 'sent') toast(`Bug report ${r.shortId} sent`);
    else toast(`Your bug report wasn't sent: ${r.message}`, 'error');
  };
  const send = async () => {
    if (inflight.current) return;
    inflight.current = true;
    const i = input();
    try {
      await sendToMoPilot(i);
    } finally {
      inflight.current = false;
    }
  };
  // the report as it would be sent now, scrubbed by main like a send, description included
  const saveToFile = async () => {
    const report = await native.app.bug.preview(input());
    const path = await native.dialog.saveText(reportFileName(), reportFileText(report));
    if (path) toast(`Saved the report to ${path}`);
    return path;
  };
  // no MoPilot service to send to: the saved report goes on an issue the user opens
  const saveForIssue = async () => {
    if (await saveToFile()) await native.shell.openExternal(NEW_ISSUE_URL);
  };
  const attachedLine = snap.attached ? "This chat's transcript is included." : 'No chat attached.';
  if (!hasMoPilotService())
    return (
      <Modal title="Report a bug" onClose={onClose}>
        <BugFields kind={kind} setKind={setKind} text={text} setText={setText} locked={false} />
        <p className="acct-dialog-hint">
          {attachedLine} Diagnostics (version, environment and recent errors) are included too. Secrets and personal paths are removed
          before the report is saved. Attach the file to the issue that opens.
        </p>
        <div className="sketch-foot">
          <button className="btn-pill" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-white" onClick={() => saveForIssue().catch(toastFailure("Couldn't save the report"))}>
            Save and open an issue
          </button>
        </div>
      </Modal>
    );

  const sending = mopilot.state === 'sending';
  const done = mopilot.state === 'sent';
  const failed = mopilot.state === 'failed';
  const locked = mopilot.state !== 'idle' && mopilot.state !== 'failed';
  return (
    <Modal title="Report a bug" onClose={onClose}>
      <BugFields kind={kind} setKind={setKind} text={text} setText={setText} locked={locked} />
      <p className="acct-dialog-hint">
        {attachedLine} Diagnostics (version, environment and recent errors) are included too. Secrets and personal paths are removed before
        anything is sent.
      </p>
      <div className="bug-results" role="status">
        <SendLine send={mopilot} />
      </div>
      <div className="sketch-foot">
        {mopilot.state === 'failed' && (
          <button className="btn-pill" onClick={() => saveToFile().catch(toastFailure("Couldn't save the report"))}>
            Save report to file
          </button>
        )}
        {done ? (
          <button className="btn-white" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn-pill" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-white" disabled={sending} onClick={() => void send()}>
              {failed ? 'Retry' : 'Send'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** What the report is (its kind) and what happened, in the user's words: fixed while it is being sent. */
function BugFields(p: { kind: BugKind; setKind: (k: BugKind) => void; text: string; setText: (t: string) => void; locked: boolean }) {
  return (
    <>
      <div className="dialog-chips">
        {KINDS.map((k) => (
          <button
            key={k.value}
            className={`dialog-chip ${p.kind === k.value ? 'on' : ''}`}
            disabled={p.locked}
            onClick={() => p.setKind(k.value)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <textarea
        className="text-area settings-textarea"
        rows={5}
        autoFocus
        placeholder="What happened?"
        value={p.text}
        {...busyField(p.locked)}
        onChange={(e) => p.setText(e.target.value)}
      />
    </>
  );
}

/** The MoPilot report's result and its receipt ID. */
function SendLine({ send }: { send: Send }) {
  switch (send.state) {
    case 'sending':
      return <p className="acct-dialog-hint">Sending to MoPilot…</p>;
    case 'sent':
      return (
        <>
          <p className="acct-dialog-hint">{`Report ${send.shortId} sent to MoPilot`}</p>
          <button className="btn-pill" onClick={() => copyText(send.shortId, 'Copied report ID')}>
            Copy ID
          </button>
        </>
      );
    case 'failed':
      return <p className="acct-dialog-hint bug-failed">{`Couldn't send to MoPilot: ${send.message}`}</p>;
    default:
      return null;
  }
}
