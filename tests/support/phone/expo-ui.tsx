// @expo/ui (SwiftUI views) in the test DOM: a Menu is a button named by its accessibility label that opens its entries as buttons.
import React from 'react';

export const Host = ({ children }: any) => <div data-host="swift-ui">{children}</div>;
export const Image = ({ systemName }: any) => <span data-symbol={systemName} />;
/** A menu entry: picking it runs it and closes the menu, as the system menu does. */
const Close = React.createContext<() => void>(() => {});
export const Button = ({ label, onPress, systemImage, role, modifiers }: any) => {
  const close = React.useContext(Close);
  // a disabled entry is greyed and does nothing, as the system menu does
  const off = (modifiers ?? []).some((m: any) => m.type === 'disabled' && m.disabled);
  return (
    <button
      role="menuitem"
      aria-label={label}
      aria-disabled={off}
      data-symbol={systemImage}
      data-role={role}
      onClick={() => {
        if (off) return;
        close();
        onPress?.();
      }}
    >
      {label}
    </button>
  );
};
/** The rule between sections of a menu. */
export const Divider = () => <hr />;
/** A group of menu entries, with its small title when it has one. */
export const Section = ({ title, children }: any) => (
  <div data-section={title ?? ''}>
    {title ? <span>{title}</span> : null}
    {children}
  </div>
);
export const Menu = ({ label, modifiers, children }: any) => {
  const [open, setOpen] = React.useState(false);
  const name = (modifiers ?? []).find((m: any) => m.type === 'accessibilityLabel')?.label;
  return (
    <div data-menu={name}>
      <button aria-label={name} aria-expanded={open} onClick={() => setOpen(!open)}>
        {typeof label === 'string' ? label : null}
      </button>
      {open && <Close.Provider value={() => setOpen(false)}>{children}</Close.Provider>}
    </div>
  );
};
