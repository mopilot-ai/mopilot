// The confirmation before uninstalling a plugin or removing a marketplace on the shared Plugins page.
import { useEffect } from 'react';
import { X } from '../ui/icons';
import { imeComposing } from '../../lib/focus';

export function ConfirmDialog({
  title,
  detail,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  detail: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mk-dialog" role="dialog" aria-label={title}>
        <button type="button" className="mk-close" onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </button>
        <div className="mk-title">{title}</div>
        <div className="mk-sub">{detail}</div>
        <div className="mk-foot">
          <button type="button" className="mk-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="mk-btn primary" onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
