// The question before Codex's Remote Control is turned on: it lets the user's other devices reach this whole computer, not one chat.
import { useId } from 'react';
import { imeComposing } from '../../lib/focus';

export function RemoteControlConfirm({ onAllow, onCancel }: { onAllow: () => void; onCancel: () => void }) {
  const label = useId();
  const detail = useId();
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && onCancel()}>
      <div className="dialog acct-dialog" role="alertdialog" aria-labelledby={label} aria-describedby={detail}>
        <div className="dialog-head">
          <span id={label}>Allow devices to control this computer?</span>
        </div>
        <div id={detail} className="acct-dialog-hint">
          <p>
            Authorized devices, such as your phone, can then connect to this computer and run your chats. Only connect devices you own and
            trust.
          </p>
          <p>It stays on until you turn it off or quit the app.</p>
        </div>
        <div className="acct-dialog-actions">
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn primary sm" autoFocus onClick={onAllow}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
