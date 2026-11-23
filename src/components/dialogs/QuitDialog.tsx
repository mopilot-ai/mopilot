// The exit gate's dialog (electron/platform/exitGate.cjs): Quit and Restart to update list what they
// would stop and wait for the user. Main pauses Claude goals itself (exitGate.cjs pauseClaude).
import { useEffect, useState } from 'react';
import { native, type ExitGateRequest } from '../../lib/native';
import { toastFailure } from '../../store/core';
import { imeComposing } from '../../lib/focus';

export function QuitDialog() {
  const [ask, setAsk] = useState<{ id: number; req: ExitGateRequest } | null>(null);
  useEffect(() => native.exitGate.onConfirm((id, req) => setAsk({ id, req })), []);
  if (!ask) return null;
  const answer = (ok: boolean | 'stop') => {
    native.exitGate.answer(ask.id, ok);
    setAsk(null);
  };
  const update = ask.req.reason === 'update';
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && answer(false)}>
      <div className="dialog acct-dialog" role="alertdialog" aria-labelledby="quit-title" aria-describedby="quit-detail">
        <div className="dialog-head">
          <span id="quit-title">{update ? 'Restart to update?' : 'Quit MoPilot?'}</span>
        </div>
        {ask.req.text && (
          <p id="quit-detail" className="acct-dialog-hint" style={{ fontSize: 'var(--fs-ui)' }}>
            {ask.req.text}
          </p>
        )}
        <div className="acct-dialog-actions">
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => answer(false)}>
            Cancel
          </button>
          {update && ask.req.text && (
            // the restart waits for the running work to end, then goes through this gate again without asking
            <button
              className="btn sm"
              onClick={() => {
                answer(false);
                native.updates.install({ when: 'idle' }).catch(toastFailure("Couldn't schedule the restart to update"));
              }}
            >
              Restart when idle
            </button>
          )}
          {!!ask.req.keeps && (
            // the chats on this Mac's background Host end with it; the first quit with such chats says so once
            <button className="btn sm" onClick={() => answer('stop')}>
              Quit and stop them
            </button>
          )}
          <button className="btn primary sm" autoFocus onClick={() => answer(true)}>
            {update ? 'Restart now' : 'Quit'}
          </button>
        </div>
      </div>
    </div>
  );
}
