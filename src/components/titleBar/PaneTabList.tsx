// Keeps the focused rename field or selected pane tab visible as its own DOM geometry changes, without reacting to portal menus.
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function PaneTabList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current!;
    let live = true;
    const isTab = (node: Node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('tb-tab');
    const reveal = () => {
      if (!live) return;
      const editing = list.querySelector<HTMLInputElement>(':scope > .tb-tab > .tb-tab-rename:focus');
      const target = editing?.parentElement ?? list.querySelector<HTMLElement>(':scope > .tb-tab[aria-current="true"]');
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const resize = new ResizeObserver(reveal);
    let watched: HTMLElement[] = [];
    const watchTabs = () => {
      for (const tab of watched) resize.unobserve(tab);
      watched = Array.from(list.children).filter(isTab);
      for (const tab of watched) resize.observe(tab);
    };
    const mutation = new MutationObserver((records) => {
      if (!live) return;
      const membership = records.some(
        (record) => record.type === 'childList' && record.target === list && [...record.addedNodes, ...record.removedNodes].some(isTab),
      );
      if (membership) watchTabs();
      if (membership || records.some((record) => record.type === 'attributes' && record.target.parentNode === list && isTab(record.target)))
        reveal();
    });
    resize.observe(list);
    mutation.observe(list, { attributes: true, attributeFilter: ['aria-current'], childList: true, subtree: true });
    watchTabs();
    reveal();
    return () => {
      live = false;
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
  return (
    <div className="tb-tab-list" ref={ref}>
      {children}
    </div>
  );
}
