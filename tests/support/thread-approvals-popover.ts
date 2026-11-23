// Light stand-ins for src/components/ui/Popover.tsx in the approval card tests: an open menu is a
// .popover-layer in the body holding its items (as the real one is), picking an item runs it and
// closes the menu, and a tooltip keeps its label in a data attribute.
import { createContext, createElement as h, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MenuClose = createContext<() => void>(() => {});

export const Menu = ({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) =>
  open
    ? createPortal(
        h(
          'div',
          { className: 'popover-layer' },
          h(MenuClose.Provider, { value: onClose }, h('div', { className: 'menu', role: 'menu' }, children)),
        ),
        document.body,
      )
    : null;

export function MenuItem({ onSelect, children, right }: { onSelect?: () => void; children: ReactNode; right?: ReactNode }) {
  const close = useContext(MenuClose);
  return h(
    'div',
    { className: 'menu-item', role: 'menuitem', onClick: () => (onSelect?.(), close()) },
    h('span', { className: 'menu-title' }, children),
    right,
  );
}

export const Tooltip = ({ label, children }: { label: string; children: ReactNode }) =>
  h('span', { className: 'tooltip-anchor', 'data-tooltip': label }, children);

export function useAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { ref: setAnchor, anchor, open, setOpen, toggle, close };
}
