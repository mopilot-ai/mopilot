// Menu-local letter shortcuts activate the displayed item only while that menu owns keyboard focus.
import { useEffect, useRef, type ReactNode } from 'react';

export function MenuLetters({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const root = ref.current!;
      const menu = root.closest('[data-menu-keyboard]');
      if (!(event.target instanceof HTMLElement)) return;
      const target = event.target;
      if (!menu || target.closest('[data-menu-keyboard]') !== menu || target.closest('input, textarea, [contenteditable]')) return;
      const item = [...root.querySelectorAll<HTMLElement>('.menu-shortcut')]
        .find((hint) => hint.textContent?.toLowerCase() === event.key.toLowerCase())
        ?.closest<HTMLButtonElement>('button');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      event.stopPropagation();
      item.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return <div ref={ref}>{children}</div>;
}
