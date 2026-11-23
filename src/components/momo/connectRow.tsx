// The look of a row on MoMo's setup card (#2607): its icon, name and line (red when something failed), and what the user can do (a button, as children) or has done (Done, a check). NotificationsStep's row is the one user of it.
import type { ReactNode } from 'react';
import { Check } from '../ui/icons';

export const ICON = { size: 22, strokeWidth: 1.8 };

/** One row: its icon, name and line, and what the user can do (a button) or has done (a check). */
export function ConnectRow({
  icon,
  title,
  desc,
  tone,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  /** error: something failed (red) */
  tone?: 'error';
  children: ReactNode;
}) {
  return (
    <div className="momo-connect-row">
      <span className="momo-connect-icon">{icon}</span>
      <div className="momo-connect-text">
        <span className="momo-connect-title">{title}</span>
        <span className="momo-connect-desc" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
          {desc}
        </span>
      </div>
      {children}
    </div>
  );
}

export const Done = ({ label }: { label: string }) => (
  <span className="momo-connect-done">
    <Check size={16} strokeWidth={2.4} />
    {label}
  </span>
);
