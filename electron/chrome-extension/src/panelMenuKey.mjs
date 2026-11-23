// Keyboard handling shared by the Chrome panel's mention and slash menus.

/**
 * @template T
 * @param {{ open: boolean, rows: T[], at: number, close: () => void, render: () => void, pick: (row: T) => void }} menu
 * @param {{ key: string, isComposing?: boolean, keyCode?: number, preventDefault: () => void }} e
 * @returns {boolean}
 */
export function menuKey(menu, e) {
  // an input method's keys are its own while it composes: Enter confirms a candidate, Escape cancels it
  if (!menu.open || e.isComposing || e.keyCode === 229) return false;
  if (e.key === 'Escape') {
    menu.close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!menu.rows.length) return false;
    menu.at = (menu.at + (e.key === 'ArrowDown' ? 1 : menu.rows.length - 1)) % menu.rows.length;
    menu.render();
  } else if ((e.key === 'Enter' || e.key === 'Tab') && menu.rows.length) {
    menu.pick(menu.rows[menu.at]);
  } else return false;
  e.preventDefault();
  return true;
}
