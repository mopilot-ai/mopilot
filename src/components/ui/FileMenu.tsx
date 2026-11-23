// One path menu for every surface that shows a file: copy the path, or reveal the file in Finder.

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Menu, MenuItem, useAnchor } from './Popover';
import { Ellipsis } from './icons';
import { copyText } from '../../session/clipboard';
import { revealPath } from '../../session/open';

/** Where the menu opens: the point a right-click or the keyboard named, or null for the trigger button. */
type At = { x: number; y: number } | null;

export interface FileMenu {
  /** For the element the path belongs to: a right-click, Shift-F10 or the Context Menu key opens the menu. */
  target: {
    'aria-haspopup': 'menu';
    onContextMenu: (e: MouseEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  };
  /** For a button that opens the same menu; spread it first, so a surface's own label or disabled state wins. */
  trigger: {
    ref: (el: HTMLElement | null) => void;
    'aria-label': string;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    onClick: () => void;
  };
  /** The menu itself, rendered beside the surface's own markup. */
  menu: ReactNode;
}

/**
 * The one path menu. Every surface showing a file path reaches Reveal in Finder through this hook: by a right-click
 * or the keyboard on the path's own element (`target`), by a button of its own (`trigger`), or both. `copy` is what
 * Copy path writes when that isn't the revealed path (a diff row copies the path it displays); `revealOff` greys
 * Reveal in Finder with that reason (the file is not on this Mac); `extra` adds the surface's own items below.
 */
export function useFileMenu(
  path: string,
  { extra, copy, revealOff }: { extra?: ReactNode; copy?: string; revealOff?: string } = {},
): FileMenu {
  const m = useAnchor<HTMLElement>();
  const [at, setAt] = useState<At>(null);
  const openAt = (point: At) => {
    setAt(point);
    m.setOpen(true);
  };
  return {
    target: {
      'aria-haspopup': 'menu',
      onContextMenu: (e) => {
        // the innermost path's menu, not also the row's around it
        e.preventDefault();
        e.stopPropagation();
        openAt({ x: e.clientX, y: e.clientY });
      },
      onKeyDown: (e) => {
        // Shift-F10 and the Context Menu key are the keyboard's way to a context menu; every other key is the element's
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
        e.preventDefault();
        e.stopPropagation();
        const box = e.currentTarget.getBoundingClientRect();
        openAt({ x: box.left, y: box.bottom });
      },
    },
    trigger: {
      ref: m.ref,
      'aria-label': 'File actions',
      'aria-haspopup': 'menu',
      'aria-expanded': m.open,
      onClick: () => {
        // the button's own menu, wherever the last right-click was
        setAt(null);
        m.toggle();
      },
    },
    menu: (
      <Menu anchor={at ?? m.anchor} open={m.open} onClose={m.close} placement={at ? 'bottom-start' : 'bottom-end'} width={200}>
        <MenuItem onSelect={() => copyText(copy ?? path, 'Copied path')}>Copy path</MenuItem>
        {revealOff === undefined ? (
          <MenuItem onSelect={() => revealPath(path)}>Reveal in Finder</MenuItem>
        ) : (
          <MenuItem disabled description={revealOff}>
            Reveal in Finder
          </MenuItem>
        )}
        {extra}
      </Menu>
    ),
  };
}

/** An ellipsis button opening the shared path menu, for a surface with room for one of its own. */
export function FileMenuButton({
  path,
  className = 'icon-btn xs',
  size = 14,
  copy,
}: {
  path: string;
  className?: string;
  size?: number;
  copy?: string;
}) {
  const m = useFileMenu(path, { copy });
  return (
    <>
      <button className={className} title="File actions" {...m.trigger}>
        <Ellipsis size={size} />
      </button>
      {m.menu}
    </>
  );
}
