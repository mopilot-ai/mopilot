// A rail row that does something, set apart from the places above it (Main, Everything, channels), which are links to where MoMo is: a plus and the action's words, full width like a row ("New channel or group"). With two things to make (a channel, a group) it opens a small menu of them (closes on Escape and on a click anywhere else).
import { useEffect, useRef, useState } from 'react';
import { imeComposing } from '../../../lib/focus';
import { Plus } from '../../ui/icons';
import { SHELL_COPY } from './shellCopy';
import styles from './momoShell.module.css';

export function RailAction({ label, onClick, menu }: { label: string; onClick: () => void; menu?: boolean }) {
  return (
    <button type="button" className={styles.railAction} aria-label={label} aria-haspopup={menu ? 'menu' : undefined} onClick={onClick}>
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** The menu of the two things to make, under its trigger: closes on Escape and on a press elsewhere. `small`: Everything's + (an icon button), else the rail's full row. */
export function PlusMenu({
  onNewChannel,
  onNewGroup,
  label,
  small = false,
}: {
  onNewChannel: () => void;
  onNewGroup: () => void;
  label: string;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div ref={box} className={small ? styles.newSmall : styles.newBox}>
      {small ? (
        <button
          type="button"
          className={styles.smallBtn}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : (
        <RailAction label={label} menu onClick={() => setOpen(!open)} />
      )}
      {open ? (
        <div className={styles.newMenu} role="menu" aria-label={label}>
          <button type="button" role="menuitem" className={styles.newOption} onClick={pick(onNewChannel)}>
            {SHELL_COPY.newChannel}
          </button>
          <button type="button" role="menuitem" className={styles.newOption} onClick={pick(onNewGroup)}>
            {SHELL_COPY.newGroup}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** "New channel", or with a group to make too, one row "New channel or group" that opens the two. */
export function RailNew({ onNewChannel, onNewGroup }: { onNewChannel: () => void; onNewGroup?: () => void }) {
  if (!onNewGroup) return <RailAction label={SHELL_COPY.newChannel} onClick={onNewChannel} />;
  return <PlusMenu onNewChannel={onNewChannel} onNewGroup={onNewGroup} label={SHELL_COPY.newChannelOrGroup} />;
}
