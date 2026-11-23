// Menus and listboxes (WAI-ARIA, aria-activedescendant): the list or its search field keeps focus, arrows move the active row, Enter picks it.
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { listKey, stepIndex } from '../../lib/focus';
import { titleIfClipped } from '../../lib/clippedTitle';

/*
 * One pattern for every menu and listbox in the app:
 * - focus stays on one owner: the search field that filters the list (role combobox), or else the list itself,
 *   which takes focus when it opens and gives it back to where it came from (the menu's button) when it closes;
 * - rows are `MenuRow` buttons with the role the list requires (menuitem, menuitemcheckbox, menuitemradio,
 *   option). They are never focused themselves: the owner names the active one with aria-activedescendant;
 * - ArrowDown/ArrowUp move the active row, Home/End jump, Enter (not an input method's) or Space picks it,
 *   ArrowRight opens a row's submenu and ArrowLeft goes back from one; Escape closes (Popover).
 * A row's own click handler is all it needs: the keyboard reaches it through the owner.
 */

/** The rows the keyboard moves over: the roles a menu or listbox owns, without the disabled ones. */
const ROWS = ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'].map((r) => `[role="${r}"]:not([aria-disabled="true"])`).join(',');

const isText = (el: Element) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!(el as HTMLElement).isContentEditable;

/** Shows `row` as the list's active row (null: none is). */
function setActive(list: Element, row: HTMLElement | null) {
  for (const x of list.querySelectorAll('.kbd-active')) x.classList.remove('kbd-active');
  if (!row) return list.removeAttribute('aria-activedescendant');
  row.classList.add('kbd-active');
  list.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Keyboard for a list of rows while it is mounted (a menu's list is mounted only while the menu is open). Keys go to
 * the list that holds focus, so a submenu that opened on hover does not take its parent's keys; with nothing
 * focused they go to the newest list. Keys an embedded field already handled are left alone.
 */
function useMenuKeys(ref: RefObject<HTMLDivElement | null>, autoFocus: boolean, onBack?: () => void) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // mounted while this listener is installed
      const list = ref.current!;
      const lists = document.querySelectorAll('[data-menu-keyboard]');
      // the page has a body, so something (the body at least) has focus
      const now = document.activeElement as Element;
      const focused = now.closest('[data-menu-keyboard]');
      if (list !== (focused ?? lists[lists.length - 1])) return;
      // focus on anything outside every menu (a link beside the list, a page button, another text field): its keys
      // are its own
      if (!focused && now !== document.body) return;
      const move = listKey(e, isText(e.target as Element));
      if (!move) return;
      if (move === 'back') {
        if (!back.current) return;
        e.preventDefault();
        return back.current();
      }
      const rows = [...list.querySelectorAll<HTMLElement>(ROWS)];
      const idx = rows.findIndex((r) => r.id === list.getAttribute('aria-activedescendant'));
      if (move === 'pick' || move === 'open') {
        const row = rows[idx];
        if (!row || (move === 'open' && !row.hasAttribute('aria-haspopup'))) return;
        e.preventDefault();
        // a click with detail 0 is the keyboard's: a submenu it opens takes focus
        return row.click();
      }
      if (!rows.length) return;
      e.preventDefault();
      setActive(list, rows[stepIndex(move, idx, rows.length)]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref]);
  useFocusWhileOpen(ref, autoFocus);
}

/**
 * Moves focus into `ref` once it can take it (a popover is hidden until its first measure, and a hidden element
 * cannot be focused), and gives focus back to the element that had it when `ref` goes away, unless whatever closed
 * it put focus somewhere on purpose.
 */
export function useFocusWhileOpen(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    // the page has a body, so something (the body at least) has focus
    const before = document.activeElement as HTMLElement;
    let tries = 0;
    let frame = 0;
    const take = () => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el && ++tries < 10) frame = requestAnimationFrame(take);
    };
    frame = requestAnimationFrame(take);
    return () => {
      cancelAnimationFrame(frame);
      const now = document.activeElement;
      const lost = ([null, document.body] as (Element | null)[]).includes(now) || !!ref.current?.contains(now);
      if (lost && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref, enabled]);
}

/** The list a row is in, so it can keep the keyboard's highlight through its own re-renders. */
const ListCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** A menu's list of rows (role menu): it takes focus when shown and owns the keyboard while it has it. */
export function MenuList({
  className = 'menu',
  style,
  label,
  autoFocus = true,
  onBack,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  label?: string;
  /** false: shown without taking focus (a submenu the pointer opened) */
  autoFocus?: boolean;
  /** ArrowLeft: back to the menu this one came from */
  onBack?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeys(ref, autoFocus, onBack);
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-menu-keyboard=""
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <ListCtx.Provider value={ref}>{children}</ListCtx.Provider>
    </div>
  );
}

type RowRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option';
/**
 * A row of a menu or listbox: a button that is never focused itself (its list or search field keeps focus).
 * `bare`: without the menu row look (a small action inside a menu, such as a sign-in button).
 */
export const MenuRow = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'disabled'> & { role?: RowRole; disabled?: boolean; bare?: boolean }
>(function MenuRow(
  {
    role = 'menuitem',
    className = '',
    disabled = false,
    bare = false,
    onClick,
    onMouseEnter,
    onMouseMove,
    onPointerEnter,
    children,
    ...rest
  },
  ref,
) {
  const id = useId();
  const list = useContext(ListCtx);
  const own = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  // a re-render sets className afresh: the row its menu names as active keeps the keyboard's highlight (a
  // listbox's rows carry theirs in className)
  useLayoutEffect(() => {
    const el = own.current!;
    if (list?.current?.getAttribute('aria-activedescendant') === el.id) el.classList.add('kbd-active');
  });
  return (
    <button
      ref={setRef}
      id={id}
      type="button"
      role={role}
      tabIndex={-1}
      className={bare ? className : `menu-item ${className}`.trim()}
      aria-disabled={disabled || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseMove={(e) => {
        // the pointer moving takes over from the keyboard's highlight; a row sliding under a still pointer does not
        const list = e.currentTarget.closest('[data-menu-keyboard]');
        if (list?.getAttribute('aria-activedescendant')) setActive(list, null);
        onMouseMove?.(e);
      }}
      onPointerEnter={(e) => {
        // a row without words of its own reads its title whole on hover when the menu's width cut it short
        if (rest.title === undefined) titleIfClipped(e.currentTarget, '.menu-title');
        onPointerEnter?.(e);
      }}
      onClick={disabled ? undefined : onClick}
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * A list filtered by a search field that keeps focus (a combobox and its listbox): arrows move the active option
 * and stop at the ends, Enter (not an input method's) picks it. Spread `field` on the input and `option(i)` on the
 * i-th `MenuRow` (role option); the list element takes `id={listId}` and role listbox.
 */
export function useListbox(count: number, pick: (index: number) => void) {
  const base = useId();
  const [stored, setIndex] = useState(0);
  // a list that got shorter keeps its last row active, so what shows as active is what Enter picks
  const index = Math.min(stored, Math.max(0, count - 1));
  const listId = `${base}list`;
  const optionId = (i: number) => `${base}option${i}`;
  return {
    index,
    setIndex,
    listId,
    field: {
      role: 'combobox' as const,
      'aria-expanded': true,
      'aria-controls': listId,
      'aria-autocomplete': 'list' as const,
      'aria-activedescendant': count ? optionId(index) : undefined,
      onKeyDown: (e: ReactKeyboardEvent) => {
        const move = listKey(e, true);
        if (!move || !count) return;
        e.preventDefault();
        if (move === 'pick') pick(index);
        else setIndex(stepIndex(move as 'next' | 'prev', index, count, false));
      },
    },
    option: (i: number) => ({
      id: optionId(i),
      role: 'option' as const,
      'aria-selected': i === index,
      // the pointer selects by moving: a list that filters or scrolls under a still pointer keeps the keyboard's row
      onMouseMove: () => setIndex(i),
    }),
  };
}
