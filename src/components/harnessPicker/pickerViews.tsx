// The model picker's rows as props-driven views: This Mac's harness, account and model rows and a machine chat's are the
// same markup and CSS, fed by their own data (rows.tsx reads This Mac's stores, MachinePicker a machine's report).
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Tooltip } from '../ui/Popover';
import { MenuRow } from '../ui/MenuList';
import { Check, ChevronDown, ChevronRight, Spinner } from '../ui/icons';

export interface HarnessRowViewProps {
  icon: ReactNode;
  title: string;
  /** the state word beside the title when the harness cannot be used yet ("Signed out", "Not installed") */
  badge?: { text: string; tone: '' | 'ok' | 'warn' | 'err' } | null;
  /** right after the title: the Limited badge of a basic harness */
  titleBadge?: ReactNode;
  /** the usage / state line under the title; `usageKey` is its account's key for tests and the usage refresh */
  usage?: string | null;
  usageKey?: string;
  /** 'warn': the usage line is something wrong (an expired login), in the warning colour; none: as it always was */
  usageTone?: string;
  /** what a harness that cannot be used yet says instead (its sign-in action, why it is missing) */
  extra?: ReactNode;
  /** after the lines inside the label (an update note) */
  trailing?: ReactNode;
  /** cannot be used yet: the row only shows why */
  disabled: boolean;
  /** a disabled row whose `extra` holds actions (Install, Update, Sign in, a command to copy): the choice is disabled, its actions are not, so the row is not `aria-disabled` (that would read every control inside as disabled to assistive technology) and says `data-disabled` instead */
  actions?: boolean;
  current: boolean;
  hovered: boolean;
  /** byKey: opened from the keyboard, so the models list takes focus */
  onOpen: (el: HTMLElement, byKey: boolean) => void;
  rowRef: (el: HTMLElement | null) => void;
}

/** One harness in the picker's first level: icon, name, state or usage, a chevron to its models, and a check on the current one. */
export function HarnessRowView(p: HarnessRowViewProps) {
  const el = useRef<HTMLElement | null>(null);
  const ref = (n: HTMLElement | null) => {
    el.current = n;
    p.rowRef(n);
  };
  const parts = (
    <>
      <span className="menu-icon hp-icon">{p.icon}</span>
      <span className="menu-label">
        <span className="menu-title hp-heading">
          {/* the name alone, so the row's title reads exactly the agent's name; the badges beside it */}
          <span className="hp-title">{p.title}</span> {p.titleBadge}
          {p.badge && <span className={`hp-badge ${p.badge.tone}`}>{p.badge.text}</span>}
        </span>
        {!p.disabled && p.usage && (
          <span className={p.usageTone ? `menu-desc acct-status ${p.usageTone}` : 'menu-desc'} data-account={p.usageKey}>
            {p.usage}
          </span>
        )}
        {p.extra}
        {p.trailing}
      </span>
      {!p.disabled && <ChevronRight size={13} className="menu-chevron" />}
      <span className="menu-check">{p.current ? <Check size={15} strokeWidth={2} /> : null}</span>
    </>
  );
  // a harness that can't be used yet only shows why, with its sign-in action as the group's own row
  if (p.disabled)
    return (
      <div
        ref={ref}
        className="menu-item has-desc hp-row"
        role="group"
        aria-label={p.title}
        {...(p.actions ? { 'data-disabled': true } : { 'aria-disabled': true })}
      >
        {parts}
      </div>
    );
  const open = (e: MouseEvent) => el.current && p.onOpen(el.current, e.type === 'click' && e.detail === 0);
  return (
    <MenuRow
      ref={ref}
      className={`has-desc hp-row ${p.hovered ? 'open' : ''}`}
      aria-haspopup="menu"
      aria-expanded={p.hovered}
      // opens as the pointer moves over it, not on mouseenter: Chromium sends that when the layout moves rows under a
      // still pointer (a line loading in above), which would swap the flyout for the row that slid under it
      onMouseMove={p.hovered ? undefined : open}
      onClick={open}
    >
      {parts}
    </MenuRow>
  );
}

export interface AccountChoiceRowProps {
  rowKey: string;
  name: string;
  /** the second line: plan and standing */
  desc: string;
  tone: string;
  checked: boolean;
  dim?: boolean;
  disabled?: boolean;
  /** none: a row that only reports (a machine's login, which This Mac does not switch) */
  onPick?: () => void;
}

/** One account (a login) in the harness's account list: its name, plan and standing, a check on the one in use. */
export function AccountChoiceRow(p: AccountChoiceRowProps) {
  const label = (
    <>
      <span className="menu-label">
        <span className="menu-title acct-email">{p.name}</span>
        <span className={`menu-desc acct-status ${p.tone}`}>{p.desc}</span>
      </span>
      <span className="menu-check">{p.checked ? <Check size={15} strokeWidth={2} /> : null}</span>
    </>
  );
  if (!p.onPick)
    return (
      <div className="menu-item has-desc" data-account={p.rowKey} role="group" aria-label={p.name}>
        {label}
      </div>
    );
  return (
    <MenuRow
      data-account={p.rowKey}
      className={`has-desc ${p.dim ? 'dim' : ''}`}
      role="menuitemradio"
      aria-checked={p.checked}
      disabled={p.disabled}
      onClick={p.onPick}
    >
      {label}
    </MenuRow>
  );
}

export interface ModelChoice {
  id: string;
  label: string;
  /** the hint shown on hover */
  description?: string;
  /** a quiet line under the label (what the default is, a version the machine did not report) */
  note?: string;
  /** a pinned version, listed under "More versions" */
  more?: boolean;
}

export interface ModelRowsViewProps {
  models: ModelChoice[];
  current: string | null;
  onPick: (m: ModelChoice) => void;
  /** no models yet: still loading, or listed none (with the action that helps) */
  loading?: boolean;
  empty?: { text: string; action: string; onAction: () => void };
}

/** The harness's models: the main ones, then "More versions" folded; a loading line or an empty line with its action. */
export function ModelRowsView(p: ModelRowsViewProps) {
  const [more, setMore] = useState(false);
  const main = p.models.filter((m) => !m.more);
  const rest = p.models.filter((m) => m.more);
  const row = (m: ModelChoice) => {
    const item = (
      <MenuRow
        key={m.id}
        role="menuitemradio"
        aria-checked={m.id === p.current}
        className={m.note ? 'has-desc' : undefined}
        onClick={() => p.onPick(m)}
      >
        <span className="menu-label">
          <span className="menu-title">{m.label}</span>
          {m.note && <span className="menu-desc">{m.note}</span>}
        </span>
        <span className="menu-check">{m.id === p.current ? <Check size={15} strokeWidth={2} /> : null}</span>
      </MenuRow>
    );
    // The suggestion ("Best for everyday tasks…") is only shown on hover, keeping the list compact.
    return m.description ? (
      <Tooltip key={m.id} label={m.description} delay={250}>
        {item}
      </Tooltip>
    ) : (
      item
    );
  };
  if (!p.models.length && p.loading)
    return (
      <div className="menu-item hp-models-loading" role="status" aria-busy="true">
        <Spinner size={12} /> Loading models…
      </div>
    );
  if (!p.models.length)
    return (
      <div className="menu-item hp-models-empty" role="status">
        <span className="menu-desc">{p.empty?.text}</span>
        {p.empty && (
          <MenuRow bare className="hp-mini primary" onClick={p.empty.onAction}>
            {p.empty.action}
          </MenuRow>
        )}
      </div>
    );
  return (
    <div className="menu-scroll hp-models">
      {main.map(row)}
      {rest.length > 0 && (
        <>
          <div className="menu-sep" role="separator" />
          <MenuRow aria-expanded={more} onClick={() => setMore((x) => !x)}>
            <span className="menu-label">
              <span className="menu-title hp-more">More versions</span>
            </span>
            <ChevronDown size={13} className="menu-chevron" style={{ transform: more ? 'rotate(180deg)' : undefined }} />
          </MenuRow>
          {more && rest.map(row)}
        </>
      )}
    </div>
  );
}
