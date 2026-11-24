// The question before something that cuts a device off: what it does to the device and to a session that is open now, then the one action. Shared by Allow connections (off), Revoke access for a phone and for a ChatGPT device.
import { useId } from 'react';
import { imeComposing } from '../../../lib/focus';

export function ConsequenceConfirm({
  title,
  lines,
  action,
  onConfirm,
  onCancel,
}: {
  title: string;
  lines: readonly string[];
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const label = useId();
  const detail = useId();
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && onCancel()}>
      <div className="dialog acct-dialog" role="alertdialog" aria-labelledby={label} aria-describedby={detail}>
        <div className="dialog-head">
          <span id={label}>{title}</span>
        </div>
        <div id={detail} className="acct-dialog-hint">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="acct-dialog-actions">
          <button className="btn sm" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn danger sm" onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
