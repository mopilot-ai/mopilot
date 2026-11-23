// The browser pane's notice frame: a message with its pill actions and the close button every notice has, as ChatGPT's browser banners do (#1523 §2).
import type { ReactNode } from 'react';
import { X } from '../../ui/icons';

/**
 * A notice band above the page. `onClose` is required, so no notice can ship without a way to put it away; what closing
 * means (dismiss, cancel, wait) is the notice's own. Its actions go in a `.browser-notice-actions` row, drawn as pills.
 */
export function PaneNotice({
  children,
  onClose,
  closeLabel = 'Close',
  className,
  role = 'status',
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
  role?: 'status' | 'alert' | 'alertdialog' | 'region' | 'group';
  label?: string;
}) {
  return (
    <div className={className ? `browser-notice ${className}` : 'browser-notice'} role={role} aria-label={label}>
      <div className="browser-notice-body">{children}</div>
      <button type="button" className="browser-notice-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
