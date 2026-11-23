// Popovers, menus, submenus and tooltips anchored to an element, with keyboard navigation and placement.

import { shortcutLabel } from '../../lib/platform';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from './icons';
import { MenuList, MenuRow } from './MenuList';
import { placePopover, type Placement } from './popoverPlacement';

/* ------------------------------------------------------------------ */
/* Popover: anchored floating layer with outside-click / Esc dismissal */
/* ------------------------------------------------------------------ */
export type { Placement };

/** How many open popovers each anchor has: two layers can share one anchor, and the first to close must not clear the mark. */
const openOn = new WeakMap<HTMLElement, number>();

/** Marks an element anchor `data-popover-open` while a popover hangs off it, so its down chevron reads as up (popovers.css). */
function useAnchorOpenMark(anchor: HTMLElement | null | { x: number; y: number }, open: boolean) {
  useLayoutEffect(() => {
    if (!open || !(anchor instanceof HTMLElement)) return;
    openOn.set(anchor, (openOn.get(anchor) ?? 0) + 1);
    anchor.setAttribute('data-popover-open', '');
    return () => {
      // set above for this anchor, and only this cleanup lowers it
      const left = openOn.get(anchor)! - 1;
      openOn.set(anchor, left);
      if (left === 0) anchor.removeAttribute('data-popover-open');
    };
  }, [anchor, open]);
}

export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  offset = 6,
  children,
  className = '',
  matchWidth = false,
}: {
  anchor: HTMLElement | null | { x: number; y: number };
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  children: ReactNode;
  className?: string;
  matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number } | null>(null);
  useAnchorOpenMark(anchor, open);

  useLayoutEffect(() => {
    setPos(null);
    if (!open || !anchor) return;
    let retry = 0;
    let frame = 0;
    let below = false;
    const place = () => {
      // the layer is rendered whenever the popover is open, and every call to place() is cancelled on close
      const el = ref.current!;
      const r =
        anchor instanceof HTMLElement
          ? anchor.getBoundingClientRect()
          : ({ left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 } as DOMRect);
      // An anchor inside another popover that hasn't been placed yet sits far off-screen (or has no
      // box); measuring it now would clamp this popover into the top-left corner. Try again next frame.
      if (anchor instanceof HTMLElement && (r.bottom < -1000 || r.right < -1000 || (r.width === 0 && r.height === 0))) {
        setPos(null);
        if (retry++ < 10) frame = requestAnimationFrame(place);
        return;
      }
      const placed = placePopover(
        placement,
        r,
        { w: el.offsetWidth, h: el.offsetHeight },
        offset,
        { w: window.innerWidth, h: window.innerHeight },
        below,
      );
      below = placed.below;
      const { left, top } = placed;
      setPos({ left, top, minWidth: matchWidth && anchor instanceof HTMLElement ? r.width : undefined });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(ref.current!);
    if (anchor instanceof HTMLElement) ro.observe(anchor);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, placement, offset, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      // nested popovers render in their own portal; ignore clicks inside any popover layer
      if ((t as HTMLElement).closest?.('.popover-layer, .tooltip.interactive')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={`popover-layer ${className}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        // matchWidth panels (composer menus) are exactly as wide as their anchor, whatever their content.
        width: pos?.minWidth,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Menu primitives                                                     */
/* ------------------------------------------------------------------ */
const MenuCtx = createContext<{ close: () => void }>({
  close: () => {
    /* no menu above: nothing to close */
  },
});

export function Menu({
  anchor,
  open,
  onClose,
  placement,
  children,
  width,
  className = '',
}: {
  anchor: HTMLElement | null | { x: number; y: number };
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement={placement}>
      <MenuCtx.Provider value={{ close: onClose }}>
        <MenuList className={`menu ${className}`} style={{ width }}>
          {children}
        </MenuList>
      </MenuCtx.Provider>
    </Popover>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  shortcut,
  checked,
  danger,
  disabled,
  hint,
  keepOpen,
  right,
  description,
  dataAccount,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: () => void;
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  keepOpen?: boolean;
  right?: ReactNode;
  description?: ReactNode;
  /** the account the item is about ("claude:<id>"), the same key every account surface marks its row with */
  dataAccount?: string;
  /** shown on hover: what the item's words leave out (a full path) */
  title?: string;
}) {
  const { close } = useContext(MenuCtx);
  return (
    <MenuRow
      data-account={dataAccount}
      title={title}
      className={`${danger ? 'danger' : ''} ${description ? 'has-desc' : ''}`}
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onSelect?.();
        if (!keepOpen) close();
      }}
    >
      {icon !== undefined && <span className="menu-icon">{icon}</span>}
      <span className="menu-label">
        <span className="menu-title">{children}</span>
        {description && <span className="menu-desc">{description}</span>}
      </span>
      {hint && <span className="menu-hint">{hint}</span>}
      {shortcut && <span className="menu-shortcut">{shortcutLabel(shortcut)}</span>}
      {right}
      {checked !== undefined && <span className="menu-check">{checked ? <Check size={15} strokeWidth={2} /> : null}</span>}
    </MenuRow>
  );
}

export function SubMenu({
  icon,
  label,
  children,
  hint,
  description,
  shortcut,
  right,
  width,
}: {
  icon?: ReactNode;
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  shortcut?: string;
  right?: ReactNode;
  width?: number;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  // opened from the keyboard (Enter, Space or ArrowRight on the row): its list takes focus
  const [byKey, setByKey] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { close } = useContext(MenuCtx);
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  // closed, it forgets how it was opened: the pointer opening it next doesn't take focus
  const shut = () => {
    setOpen(false);
    setByKey(false);
  };
  const hide = () => {
    clearTimeout(timer.current);
    // opened from the keyboard, it stays until the keyboard (or a pick, Escape, a press outside) closes it
    if (!byKey) timer.current = setTimeout(shut, 160);
  };
  return (
    <MenuRow
      ref={setEl}
      className={`${open ? 'open' : ''} ${description ? 'has-desc' : ''}`}
      aria-haspopup="menu"
      aria-expanded={open}
      // opens as the pointer moves over it, not on mouseenter: Chromium sends that when the layout moves rows under a
      // still pointer, which would open the submenu of the row that slid under it
      onMouseMove={show}
      onMouseLeave={hide}
      onClick={(e) => {
        // a click inside the open submenu (a portal) reaches this row through React: it isn't the row's
        if (!e.currentTarget.contains(e.target as Node)) return;
        setByKey(e.detail === 0);
        setOpen(true);
      }}
    >
      {icon !== undefined && <span className="menu-icon">{icon}</span>}
      {description ? (
        <span className="menu-label">
          <span className="menu-title">{label}</span>
          <span className="menu-desc">{description}</span>
        </span>
      ) : (
        <span className="menu-label">{label}</span>
      )}
      {hint && <span className="menu-hint">{hint}</span>}
      {shortcut && <span className="menu-shortcut">{shortcutLabel(shortcut)}</span>}
      {right}
      <ChevronRight size={14} className="menu-chevron" />
      <Popover anchor={el} open={open} onClose={shut} placement="right-start" offset={4}>
        <MenuCtx.Provider value={{ close }}>
          <MenuList style={width ? { width } : undefined} autoFocus={byKey} onBack={shut} onMouseEnter={show} onMouseLeave={hide}>
            {children}
          </MenuList>
        </MenuCtx.Provider>
      </Popover>
    </MenuRow>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
export function MenuLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="menu-section-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

/** Hook for a simple anchored open/close state. */
export function useAnchor<T extends HTMLElement = HTMLElement>() {
  const [anchor, setAnchor] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  // One object per state: callers list it in effect deps, and a fresh object every render re-ran those effects (and their setState) on every commit.
  return useMemo(() => ({ ref: setAnchor, anchor, open, setOpen, toggle, close }), [anchor, open, toggle, close]);
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */
const TooltipClose = createContext<() => void>(() => {
  // outside a tooltip there is nothing to close
});
/** Closes the tooltip this is rendered in: an interactive bubble's choice (a file in a list) is done with it. */
export const useCloseTooltip = () => useContext(TooltipClose);

export function Tooltip({
  label,
  shortcut,
  children,
  placement = 'bottom',
  delay = 450,
  interactive = false,
  className = '',
  disabled = false,
}: {
  label: ReactNode;
  shortcut?: string;
  children: React.ReactElement;
  placement?: Placement;
  delay?: number;
  /** the pointer can move onto the bubble (for a link in it); it closes shortly after leaving both */
  interactive?: boolean;
  /** extra classes on the bubble, e.g. `rich` for a list on the menu surface */
  className?: string;
  /** shows nothing (what the anchor opened would sit under it) */
  disabled?: boolean;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <span
      ref={setEl}
      className="tooltip-anchor"
      onMouseEnter={() => {
        clearTimeout(t.current);
        t.current = setTimeout(() => setOpen(true), delay);
      }}
      onMouseLeave={() => {
        clearTimeout(t.current);
        if (interactive) t.current = setTimeout(() => setOpen(false), 150);
        else setOpen(false);
      }}
      onMouseDown={(e) => {
        // a press inside an interactive bubble (portalled, so it reaches here) is a click on its link
        if (interactive && !el?.contains(e.target as Node)) return;
        clearTimeout(t.current);
        setOpen(false);
      }}
    >
      {children}
      {open && el && !disabled && (
        <TooltipBubble
          anchor={el}
          placement={placement}
          interactive={interactive}
          className={className}
          onEnter={() => clearTimeout(t.current)}
          onLeave={(e) => {
            clearTimeout(t.current);
            if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
            t.current = setTimeout(() => setOpen(false), 150);
          }}
        >
          <TooltipClose.Provider
            value={() => {
              clearTimeout(t.current);
              setOpen(false);
            }}
          >
            {label}
          </TooltipClose.Provider>
          {shortcut && <span className="tooltip-kbd">{shortcutLabel(shortcut)}</span>}
        </TooltipBubble>
      )}
    </span>
  );
}

function TooltipBubble({
  anchor,
  placement,
  children,
  interactive,
  className,
  onEnter,
  onLeave,
}: {
  anchor: HTMLElement;
  placement: Placement;
  children: ReactNode;
  interactive: boolean;
  className: string;
  onEnter: () => void;
  onLeave: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    let top = placement.startsWith('top') ? r.top - h - 6 : r.bottom + 6;
    if (placement === 'right-start') {
      left = r.right + 8;
      top = r.top + r.height / 2 - h / 2;
    }
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    if (top < 6 && placement.startsWith('top')) top = r.bottom + 6;
    if (top + h > window.innerHeight - 4) top = r.top - h - 6;
    top = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    setPos({ left, top });
  }, [anchor, placement]);
  return createPortal(
    <div
      ref={ref}
      className={['tooltip', interactive && 'interactive', className].filter(Boolean).join(' ')}
      style={{ left: pos?.left ?? -999, top: pos?.top ?? -999 }}
      onMouseEnter={interactive ? onEnter : undefined}
      onMouseLeave={interactive ? onLeave : undefined}
    >
      {children}
    </div>,
    document.body,
  );
}
