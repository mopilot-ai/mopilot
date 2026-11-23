// Shared Settings controls: groups, rows, toggles, selects and segmented controls.

import { useId, useState, type ReactNode } from 'react';
import { APPLIES, type Applies } from '../../../lib/settingsNav';
import { Menu, MenuItem, useAnchor } from '../../ui/Popover';
import { ChevronDown } from '../../ui/icons';
import { onActivate } from '../../../lib/focus';
import { titleIfClipped } from '../../../lib/clippedTitle';

export function Group({
  title,
  children,
  action,
  desc,
  id,
}: {
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  desc?: ReactNode;
  /** names a group without a title, for links and tests */
  id?: string;
}) {
  return (
    <section className="settings-group" id={id}>
      {(title || action) && (
        <div className="settings-group-head">
          <div>
            {title && <h2 className="settings-group-title">{title}</h2>}
            {desc && <div className="settings-group-desc">{desc}</div>}
          </div>
          {action}
        </div>
      )}
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function Row({
  title,
  desc,
  children,
  mono,
  onClick,
  applies,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  mono?: boolean;
  onClick?: () => void;
  applies?: Applies;
}) {
  const titleId = useId();
  return (
    <div
      className={`settings-row ${onClick ? 'clickable' : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      // named by its title alone, not by the controls inside it
      aria-labelledby={onClick && titleId}
      onClick={onClick}
      onKeyDown={onClick && onActivate(onClick)}
    >
      <div className="settings-row-text">
        <div className={`settings-row-title ${mono ? 'mono' : ''}`} id={titleId}>
          {title}
          {applies && (
            <span className="applies-to" title="Applies to">
              {APPLIES[applies]}
            </span>
          )}
        </div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/**
 * An on/off switch. When `onChange` returns a promise (a write and the re-read that updates `on`), the switch shows
 * the value being written and takes no click until the promise settles, so a second click acts on what the user sees
 * rather than on an `on` that the re-read has not updated yet. It then shows `on` again, whether the write went
 * through or failed. A pending switch is aria-disabled rather than disabled, so it keeps keyboard focus.
 */
export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => unknown;
  disabled?: boolean;
  /** names the switch when its row's title is not next to it */
  label?: string;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? on;
  const click = () => {
    if (pending !== null) return;
    const next = !shown;
    const run = onChange(next);
    if (!isThenable(run)) return;
    setPending(next);
    // the handler says its own failures: a rejection it let through stays unhandled, and only the pending state ends here
    void Promise.resolve(run).finally(() => setPending(null));
  };
  return (
    <button
      className={`toggle ${shown ? 'on' : ''}`}
      role="switch"
      aria-checked={shown}
      aria-label={label}
      aria-busy={pending !== null || undefined}
      aria-disabled={pending !== null || undefined}
      disabled={disabled}
      onClick={click}
    >
      <span className="toggle-knob" />
    </button>
  );
}
const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  typeof x === 'object' && x !== null && typeof (x as { then?: unknown }).then === 'function';

export function Select<T extends string>({
  value,
  options,
  onChange,
  width,
  icon,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: number;
  icon?: ReactNode;
  /** names the control for assistive technology when no Settings row title does */
  label?: string;
}) {
  const a = useAnchor();
  const cur = options.find((o) => o.value === value);
  // the button keeps its width (CSS caps it) and ellipsizes a long label, so a long one (a folder outside home) can't
  // squeeze its row's title; the cut-off label reads whole on hover, and in the menu
  const tip = (e: { currentTarget: HTMLElement }) => titleIfClipped(e.currentTarget, '.select-label');
  return (
    <>
      <button
        ref={a.ref}
        className="select-btn"
        aria-label={label}
        onClick={a.toggle}
        onPointerEnter={tip}
        onFocus={tip}
        style={{ minWidth: width }}
      >
        {icon}
        <span className="select-label">{cur?.label ?? value}</span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={Math.max(width ?? 0, 180)}>
        {options.map((o) => (
          <MenuItem key={o.value} checked={o.value === value} onSelect={() => onChange(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/**
 * A labelled single-choice control: every segment says what it does, so the choice reads without clicking.
 * `label` names the group for assistive technology (a Settings row names it already, a control standing on its
 * own does not), and `aria-pressed` says which segment is on -- the `on` class only says it in colour.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
  className?: string;
  /** no segment takes a click (a change is being written) */
  disabled?: boolean;
}) {
  return (
    <div className={`segmented ${className ?? ''}`.trim()} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
