// The bookmark star beside the address bar and the Bookmarks menu: the user's own bookmarks and those imported from another browser as folders and submenus (as Chrome shows them), a search over all of them, and the entry to the import dialog. The star adds and removes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native, type BrowserBookmark } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { isWebUrl } from '../../../shared/browser.mjs';
import { toast } from '../../store/core';
import { isEnabled } from '../../lib/flags';
import { openImportDialog } from '../../lib/browserImport';
import { Menu, MenuItem, MenuSeparator, SubMenu, useAnchor } from '../ui/Popover';
import { MenuRow } from '../ui/MenuList';
import { Star, BookmarkIcon, Download, Folder, Globe, X } from '../ui/icons';

/** The star: filled when the page is bookmarked; a click bookmarks it, or removes every bookmark of it. */
export function BookmarkStar({ url, title }: { url: string; title: string }) {
  const [on, setOn] = useState(false);
  const latest = useRef(0);
  const ok = isWebUrl(url);
  const read = useCallback(() => {
    const mine = ++latest.current;
    if (!ok) return setOn(false);
    native.browser
      .bookmarked(url)
      .then((v) => latest.current === mine && setOn(v))
      .catch((e) => noteIgnored('read whether a page is bookmarked', e));
  }, [url, ok]);
  useEffect(() => {
    read();
    return native.browser.onBookmarksChanged(read);
  }, [read]);
  return (
    <button
      type="button"
      className="browser-btn browser-star"
      data-on={on}
      aria-pressed={on}
      disabled={!ok}
      aria-label={on ? 'Remove bookmark' : 'Bookmark this page'}
      title={on ? 'Remove bookmark' : 'Bookmark this page'}
      onClick={() =>
        native.browser
          .toggleBookmark({ url, title })
          .then((r) => !r.ok && toast("Couldn't bookmark this page", 'error'))
          .catch(() => toast("Couldn't bookmark this page", 'error'))
      }
    >
      <Star size={15} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

/** A folder of the bookmark tree: its bookmarks, then its subfolders in the order they first appear. */
export interface BookmarkFolder {
  name: string;
  items: BrowserBookmark[];
  folders: BookmarkFolder[];
}

/** The bookmarks as a folder tree (the root holds the user's own, unfiled ones). */
export function bookmarkTree(items: BrowserBookmark[]): BookmarkFolder {
  const root: BookmarkFolder = { name: '', items: [], folders: [] };
  for (const b of items) {
    let node = root;
    for (const name of b.folderPath) {
      let next = node.folders.find((f) => f.name === name);
      if (!next) {
        next = { name, items: [], folders: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.items.push(b);
  }
  return root;
}

/** Bookmarks whose title, address or folder path holds the text. */
export function searchBookmarks(items: BrowserBookmark[], text: string): BrowserBookmark[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  return items.filter((b) => [b.title, b.url, ...b.folderPath].some((s) => s.toLowerCase().includes(q)));
}

/** How many search results the menu lists. */
export const SEARCH_LIMIT = 50;

/**
 * One bookmark row: opens it on click; the remove action (shown on hover, or when the keyboard reaches it) removes
 * it without visiting it. The two are side by side, not one inside the other.
 */
function BookmarkRow({ b, onOpen, folder }: { b: BrowserBookmark; onOpen: (url: string) => void; folder?: boolean }) {
  return (
    <div className="browser-bookmark-row" role="none">
      <MenuItem
        icon={<Globe size={15} />}
        onSelect={() => onOpen(b.url)}
        description={folder ? b.folderPath.join(' › ') || undefined : undefined}
      >
        <span className="browser-bookmark-title" title={b.url}>
          {b.title}
        </span>
      </MenuItem>
      <MenuRow
        bare
        className="icon-btn xs browser-bookmark-remove"
        aria-label={`Remove ${b.title}`}
        title="Remove bookmark"
        onClick={() => native.browser.removeBookmark(b.id).catch((err) => noteIgnored('remove a bookmark', err))}
      >
        <X size={12} />
      </MenuRow>
    </div>
  );
}

/** A folder's bookmarks and subfolders, the subfolders as submenus, as Chrome's Bookmarks menu shows them. */
function FolderEntries({ folder, onOpen }: { folder: BookmarkFolder; onOpen: (url: string) => void }) {
  return (
    <>
      {folder.folders.map((f) => (
        <SubMenu key={`f:${f.name}`} icon={<Folder size={15} />} label={f.name} width={300}>
          <FolderEntries folder={f} onOpen={onOpen} />
        </SubMenu>
      ))}
      {folder.items.map((b) => (
        <BookmarkRow key={b.id} b={b} onOpen={onOpen} />
      ))}
    </>
  );
}

/** The Bookmarks menu button: the bookmark folders as submenus, a search over every bookmark, and the import entry. Each row can be removed from here. */
export function BookmarksMenu({ onOpen }: { onOpen: (url: string) => void }) {
  const menu = useAnchor<HTMLButtonElement>();
  const [items, setItems] = useState<BrowserBookmark[]>([]);
  const [query, setQuery] = useState('');
  const load = useCallback(() => {
    native.browser
      .bookmarks()
      .then(setItems)
      .catch((e) => noteIgnored('list the bookmarks', e));
  }, []);
  useEffect(() => {
    if (!menu.open) return setQuery('');
    load();
  }, [menu.open, load]);
  useEffect(() => native.browser.onBookmarksChanged(() => menu.open && load()), [menu.open, load]);
  const found = searchBookmarks(items, query);
  return (
    <>
      <button
        type="button"
        ref={menu.ref}
        className="browser-btn"
        aria-label="Bookmarks"
        title="Bookmarks"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <BookmarkIcon size={15} />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        placement="bottom-end"
        width={320}
        className="browser-bookmarks-menu"
      >
        {items.length > 0 && (
          <input
            className="browser-bookmarks-search"
            placeholder="Search bookmarks"
            aria-label="Search bookmarks"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the first match unless the arrows chose a row of this menu
              const chosen = !!e.currentTarget.closest('[aria-activedescendant]');
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || !found.length || chosen) return;
              e.preventDefault();
              onOpen(found[0].url);
              menu.close();
            }}
          />
        )}
        {!items.length && <div className="menu-empty">No bookmarks yet. Star a page, or import them from another browser.</div>}
        {query.trim() ? (
          found.length ? (
            <>
              {found.slice(0, SEARCH_LIMIT).map((b) => (
                <BookmarkRow key={b.id} b={b} onOpen={onOpen} folder />
              ))}
              {found.length > SEARCH_LIMIT && (
                <div className="menu-empty">{found.length - SEARCH_LIMIT} more match. Type more to narrow the list.</div>
              )}
            </>
          ) : (
            <div className="menu-empty">No bookmark matches.</div>
          )
        ) : (
          items.length > 0 && <FolderEntries folder={bookmarkTree(items)} onOpen={onOpen} />
        )}
        {isEnabled('shared.browser.import') && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={() => openImportDialog()}>
              Import from another browser…
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
}
