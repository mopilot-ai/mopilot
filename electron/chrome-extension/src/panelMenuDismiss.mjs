// Closes the composer's model, permission and + menus on Escape (focus goes back to the button that opened it) and on a press outside them, as Claude in Chrome's menus do (sidePanel.mjs, panelMenus.mjs, panelAttach.mjs).

/** Each menu with the button that opens it. */
const MENUS = [
  ['model-menu', 'model'],
  ['perm-menu', 'perm'],
  ['plus-menu', 'plus'],
];

export class PanelMenuDismiss {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {() => void} o.close closes every composer menu (PanelMenus.close)
   */
  constructor(o) {
    this.o = o;
    const { document } = o;
    const $ = (/** @type {string} */ id) => document.getElementById(id);
    /** The menu that is open, with its button (the composer shows one at a time). */
    const open = () => MENUS.find(([menu]) => !$(menu).hidden);
    this.onPress = (/** @type {any} */ e) => {
      if (!open()) return;
      // a press on a menu or on a menu's button is that menu's own: the button toggles it
      if (MENUS.some(([menu, button]) => $(menu).contains(e.target) || $(button).contains(e.target))) return;
      o.close();
    };
    this.onKey = (/** @type {any} */ e) => {
      // an Escape that ends an input method's composition is not for the menu
      if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') return;
      const was = open();
      if (!was) return;
      o.close();
      $(was[1]).focus();
    };
    document.addEventListener('pointerdown', this.onPress);
    document.addEventListener('keydown', this.onKey);
  }

  /** Stops listening. */
  dispose() {
    this.o.document.removeEventListener('pointerdown', this.onPress);
    this.o.document.removeEventListener('keydown', this.onKey);
  }
}
