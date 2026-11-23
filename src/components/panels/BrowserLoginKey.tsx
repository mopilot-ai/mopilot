// The key button beside the address bar: when the page's site has logins saved in MoPilot (imported or saved from an agent's sign-in), pick one and main fills it into the page; the last entry hands the page to the user's own Chrome instead.
import { ownTable } from '../../../shared/ownTable.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { toast } from '../../store/core';
import { Menu, MenuItem, useAnchor } from '../ui/Popover';
import { KeyRound, ExternalLink } from '../ui/icons';

/** What a fill that didn't happen tells the user (the key button and the in-page dropdown). */
export const FILL_FAILED: Record<string, string> = ownTable({
  no_fields: 'No sign-in field on this page',
  not_found: 'That login is no longer saved for this site',
  origin_changed: 'The page changed, so the login fill was stopped. Try again.',
  failed: "Couldn't fill the login on this page",
});

/** A window event: a login was saved from the "Save password?" bar. */
export const LOGINS_CHANGED = 'browser-logins-changed';

/**
 * @param url the page's address
 * @param pageId the pane tab's webContents id, or null while it has none
 * @param onChrome continues this page in the user's own Chrome (none: the entry is left out)
 */
export function BrowserLoginKey({ url, pageId, onChrome }: { url: string; pageId: () => number | null; onChrome?: () => void }) {
  const menu = useAnchor<HTMLButtonElement>();
  const [logins, setLogins] = useState<{ id: string; username: string }[]>([]);
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    native.browser
      .logins(url)
      .then((list) => latest.current === mine && setLogins(list))
      .catch((e) => noteIgnored("read the page's saved logins", e));
  }, [url]);
  useEffect(() => {
    load();
    // an import, or a password saved from the page, may have brought logins for this site
    const offImport = native.browser.import.onProgress(load);
    window.addEventListener(LOGINS_CHANGED, load);
    return () => {
      offImport();
      window.removeEventListener(LOGINS_CHANGED, load);
    };
  }, [load]);
  useEffect(() => {
    if (menu.open) load();
  }, [menu.open, load]);
  if (!logins.length) return null;
  const fill = async (id: string) => {
    const page = pageId();
    if (page == null) return toast("This page isn't ready yet", 'error');
    const status = await native.browser.fillLogin(page, id).catch(() => 'failed' as const);
    if (status !== 'filled' && status !== 'cancelled') toast(FILL_FAILED[status], 'error');
  };
  return (
    <>
      <button
        type="button"
        ref={menu.ref}
        className="browser-btn browser-key"
        aria-label="Saved logins"
        title="Fill a saved login"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <KeyRound size={15} />
      </button>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={260}>
        {logins.map((l) => (
          <MenuItem key={l.id} icon={<KeyRound size={14} />} onSelect={() => void fill(l.id)}>
            {l.username || '(no user name)'}
          </MenuItem>
        ))}
        {onChrome && (
          <MenuItem icon={<ExternalLink size={14} />} onSelect={onChrome}>
            Continue in Chrome
          </MenuItem>
        )}
      </Menu>
    </>
  );
}
