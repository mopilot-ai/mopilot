// Which chats each window shows (app:viewing): the chats its panes show and the focused one, read for the window code @host-portable: loads in the Host process without Electron (host/boundary.json).
// and the IPC that hears the views.

/**
 * A window's view: every chat a pane of it shows, the primary pane's chat (null for home or a page) and the focused
 * pane's chat.
 * @typedef {{ visible: string[], primary: string | null, focused: string | null }} WindowView
 */

/**
 * The view a window reported, or null for none (no chat on screen, or a report of the wrong shape).
 * @param {unknown} raw
 * @returns {WindowView | null}
 */
function parseView(raw) {
  const r = /** @type {{ visible?: unknown, primary?: unknown, focused?: unknown } | null} */ (raw && typeof raw === 'object' ? raw : null);
  if (!r || !Array.isArray(r.visible)) return null;
  const id = (v) => (typeof v === 'string' && v ? v : null);
  const visible = [...new Set(r.visible.filter((v) => id(v)))];
  const primary = id(r.primary);
  const focused = id(r.focused);
  // the primary and focused chats are ones the window shows, whatever the report listed
  for (const chat of [primary, focused]) if (chat && !visible.includes(chat)) visible.push(chat);
  return visible.length ? { visible, primary, focused } : null;
}

/**
 * Whether a window's view shows the chat in any of its panes.
 * @param {Map<number, WindowView>} viewedBy webContents id -> its view
 * @param {number} wcId
 * @param {string} chatId
 */
const shownBy = (viewedBy, wcId, chatId) => !!viewedBy.get(wcId)?.visible.includes(chatId);

/**
 * The chat a window reopens on after a restart: its primary pane's, as before split view (S5 restores the panes).
 * @param {WindowView | undefined} view
 */
const primaryOf = (view) => view?.primary ?? undefined;

/**
 * Whether a window that is still open shows the chat in any pane.
 * @param {Map<number, WindowView>} viewedBy webContents id -> its view
 * @param {{ fromId: (id: number) => any }} webContents
 * @param {string} chatId
 * @param {(wc: any) => boolean} [also] a further test of the window (focused)
 */
const chatShownIn = (viewedBy, webContents, chatId, also = () => true) =>
  [...viewedBy].some(([wcId, view]) => {
    const wc = view.visible.includes(chatId) ? webContents.fromId(wcId) : null;
    return !!wc && !wc.isDestroyed() && also(wc);
  });

module.exports = { parseView, shownBy, primaryOf, chatShownIn };
