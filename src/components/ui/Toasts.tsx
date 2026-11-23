// Toast notifications with an optional action button.

import { useStore, dismissToast } from '../../store/core';
import { Check, AlertTriangle } from './icons';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? 'info'}`}>
          {t.kind === 'error' ? <AlertTriangle size={14} /> : t.kind === 'success' ? <Check size={14} /> : null}
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
