// One section of the session rail, as Claude Desktop's: a fold whose summary shows only while it is collapsed, kept per chat
// (store/railSections.ts); Alt+click folds every section, and the header's context menu shows or hides sections or resets them.
import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  moveSectionTo,
  RAIL_SECTIONS,
  resetSections,
  sectionHidden,
  sectionsChanged,
  setAllSectionsOpen,
  setSectionHidden,
  setSectionOpen,
  setSectionOpenFor,
  useRailSection,
  type RailSectionId,
} from '../../store/railSections';
import { useStore } from '../../store/core';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Popover';
import { ChevronRight } from '../ui/icons';

/** The section being dragged by its header, across the rail's sections (one drag at a time). */
let dragged: RailSectionId | null = null;

export function RailSection({
  chatId,
  id,
  summary,
  level,
  trailing,
  className = '',
  children,
}: {
  chatId: string;
  id: RailSectionId;
  /** what the collapsed section says in its header */
  summary?: ReactNode;
  /** how urgent the summary is ('warn', 'full'), for its color */
  level?: string;
  /** controls beside the header that stay reachable while the section is collapsed (outside the fold) */
  trailing?: ReactNode;
  className?: string;
  /** the body; a function gets whether the section is open, so a costly body reads only while shown */
  children: ReactNode | ((open: boolean) => ReactNode);
}) {
  const { open, hidden } = useRailSection(chatId, id);
  // where the menu opened, and the sections the rail shows then, in order (Move up and down step past the visible ones)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; shown: RailSectionId[] } | null>(null);
  // where a section dragged over this one would land: before it or after it
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null);
  if (hidden) return null;
  const title = RAIL_SECTIONS.find((s) => s.id === id)!.title;
  const toggle = (e: MouseEvent) => {
    // the fold follows the saved state, not the element's own toggle
    e.preventDefault();
    if (e.altKey) setAllSectionsOpen(chatId, !open);
    else setSectionOpen(chatId, id, !open);
  };
  const section = (
    <details
      className={`summary-card rail-section ${className}`}
      data-rail-section={id}
      data-level={level}
      open={open}
      role="group"
      aria-label={title}
      // the element's own toggle (an assistive technology's action) is kept in step with the saved fold
      onToggle={(e) => e.currentTarget.open !== open && setSectionOpenFor(chatId, id, e.currentTarget.open)}
      data-drop={dropAt ?? undefined}
      // as Claude Desktop's, a section is dragged by its header onto another; Move up and Move down are the keyboard's way
      onDragOver={(e) => {
        if (!dragged || dragged === id) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        setDropAt(e.clientY > box.top + box.height / 2 ? 'after' : 'before');
      }}
      onDragLeave={() => setDropAt(null)}
      onDrop={(e) => {
        e.preventDefault();
        if (dragged && dragged !== id) moveSectionTo(dragged, id, dropAt === 'after');
        dragged = null;
        setDropAt(null);
      }}
    >
      <summary
        className="summary-card-toggle"
        draggable
        onDragStart={(e) => {
          dragged = id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', title);
        }}
        onDragEnd={() => {
          dragged = null;
        }}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          const rail = e.currentTarget.closest('.summary-panel') ?? e.currentTarget.ownerDocument;
          const shown = [...rail.querySelectorAll('[data-rail-section]')].map(
            (el) => el.getAttribute('data-rail-section') as RailSectionId,
          );
          setMenuAt({ x: e.clientX, y: e.clientY, shown });
        }}
      >
        <span>{title}</span>
        <ChevronRight className="summary-disclosure-arrow" size={13} aria-hidden="true" />
        {summary != null && summary !== '' && <span className="summary-connector-hint rail-section-summary">{summary}</span>}
      </summary>
      <div className="summary-group">{typeof children === 'function' ? children(open) : children}</div>
      {menuAt && (
        <SectionsMenu chatId={chatId} id={id} at={{ x: menuAt.x, y: menuAt.y }} shown={menuAt.shown} onClose={() => setMenuAt(null)} />
      )}
    </details>
  );
  if (!trailing) return section;
  return (
    <div className="rail-section-frame">
      {section}
      <div className="rail-section-trailing">{trailing}</div>
    </div>
  );
}

/** Move this section, Show: a checkbox per section that can be hidden, and Reset to defaults when anything differs from them. */
function SectionsMenu({
  chatId,
  id,
  at,
  shown,
  onClose,
}: {
  chatId: string;
  id: RailSectionId;
  at: { x: number; y: number };
  /** the sections the rail shows, in order: a move passes the neighbour the user sees, as a drag onto it does */
  shown: RailSectionId[];
  onClose: () => void;
}) {
  const prefs = useStore((s) => s.prefs);
  const place = shown.indexOf(id);
  const above = place > 0 ? shown[place - 1] : null;
  const below = place >= 0 && place < shown.length - 1 ? shown[place + 1] : null;
  return (
    <Menu anchor={at} open onClose={onClose} placement="bottom-start" width={220}>
      <MenuItem disabled={!above} onSelect={() => above && moveSectionTo(id, above, false)}>
        Move up
      </MenuItem>
      <MenuItem disabled={!below} onSelect={() => below && moveSectionTo(id, below, true)}>
        Move down
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Show</MenuLabel>
      {RAIL_SECTIONS.filter((s) => s.hideable).map((s) => {
        const shown = !sectionHidden(prefs, s.id);
        return (
          <MenuItem key={s.id} checked={shown} keepOpen onSelect={() => setSectionHidden(s.id, shown)}>
            {s.title}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem disabled={!sectionsChanged(prefs, chatId)} onSelect={() => resetSections(chatId)}>
        Reset to defaults
      </MenuItem>
    </Menu>
  );
}
