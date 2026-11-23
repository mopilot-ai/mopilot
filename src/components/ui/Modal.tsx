// The app's small modal: a titled box over a backdrop that Escape, a click outside or its close button dismisses.
import { useEffect } from 'react';
import { X } from './icons';
import { imeComposing } from '../../lib/focus';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="dialog-head">
          <span>{title}</span>
          <button className="icon-btn xs" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
