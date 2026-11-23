// A running command's line, whose live output opens only for the command the user chose.

import type { ReactNode } from 'react';
import { Collapse } from '../ui/Presence';
import { ChevronDown } from '../ui/icons';

/** A running command's output opens only for the command the user chose. */
export function RunningCommand({
  id,
  expandedId,
  onExpand,
  icon,
  label,
  children,
}: {
  id: string;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}) {
  const open = expandedId === id;
  return (
    <div className={`step ${open ? 'open' : ''}`}>
      <button className="step-row active expandable" aria-expanded={open} onClick={() => onExpand(open ? null : id)}>
        <span className="step-icon">{icon}</span>
        <span className="step-text">{label}</span>
        <ChevronDown size={14} className="step-chevron" />
      </button>
      <Collapse open={open}>
        <div className="step-body">{children}</div>
      </Collapse>
    </div>
  );
}
