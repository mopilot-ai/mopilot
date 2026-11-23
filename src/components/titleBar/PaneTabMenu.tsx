// A pane tab's context menu, as ChatGPT's tab strip has it: a browser tab's page actions, then Close / Close other tabs /
// Close tabs to the right on every tab; also a browser tab's inline rename and Duplicate's retry notice.
import { useState, type HTMLAttributes, type MouseEvent } from 'react';
import { Menu, MenuItem, MenuSeparator } from '../ui/Popover';
import { Plus, RotateCw, Copy, Link, ExternalLink, Pencil, Volume2, VolumeOff, X } from '../ui/icons';
import { browserDuplication } from '../../store/browserDuplicate';
import { PaneNotice } from '../panels/browserPanel/PaneNotice';
import { closePaneTab, closeOtherPaneTabs, openBrowserTabAfter, renamePaneTab } from '../../store/panes';
import { toast, toastFailure } from '../../store/core';
import type { PaneTab } from '../../store/state';
import { browserTabPage } from '../../session/browserTabPage';
import { copyText } from '../../session/clipboard';
import { openLink } from '../../session/open';
import { cancelOnEscape, isEnter } from '../../lib/focus';
import { isWebUrl } from '../../../shared/browser.mjs';
import { projectToolLayout, rememberToolLayout, splitToolLayout, useToolLayout, TOOL_PANES_MAX } from '../../lib/toolPaneLayout';
import { Columns2, Rows2 } from '../ui/icons';

const icon = { size: 16, strokeWidth: 1.6 };
const NOT_READY = 'This browser page is not ready yet. Try again in a moment.';
type Arrangement = { scope: string; available: string[]; front: string; select(id: string): void };

/** What a browser tab's name is: the user's name for it, else the page's title. */
export const browserTabTitle = (tab: PaneTab) => tab.customTitle || tab.title || 'New tab';

export function PaneTabMenu({
  tab,
  hasOthers,
  hasRight,
  onRename,
  arrangement,
  children,
  ...props
}: {
  tab: PaneTab;
  /** another tab, or one to its right, shows in this view's tab strip (Close other tabs / Close tabs to the right) */
  hasOthers: boolean;
  hasRight: boolean;
  onRename(): void;
  arrangement?: Arrangement;
} & HTMLAttributes<HTMLDivElement>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setAnchor(event.currentTarget);
  };
  const busy = !!(tab.duplicating || tab.restoring);
  const web = isWebUrl(tab.url ?? '');
  const reload = () => {
    const page = browserTabPage(tab.id);
    if (page) page.reload();
    else toast(NOT_READY, 'error');
  };
  const mute = () => {
    const page = browserTabPage(tab.id);
    if (!page) return toast(NOT_READY, 'error');
    page.setMuted(!tab.muted).catch(toastFailure(tab.muted ? "Couldn't unmute this tab" : "Couldn't mute this tab"));
  };
  return (
    <>
      <div {...props} onContextMenu={open}>
        {children}
      </div>
      <Menu anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {tab.kind === 'browser' && (
          <>
            <MenuItem icon={<Plus {...icon} />} onSelect={() => openBrowserTabAfter(tab.id)}>
              New tab to the right
            </MenuItem>
            <MenuItem icon={<RotateCw {...icon} />} disabled={!!tab.restoring} onSelect={reload}>
              Reload
            </MenuItem>
            <MenuItem icon={<Copy {...icon} />} disabled={busy} onSelect={() => void browserDuplication.duplicate(tab.id)}>
              {busy ? 'Duplicating…' : 'Duplicate'}
            </MenuItem>
            {web && (
              <MenuItem icon={<Link {...icon} />} onSelect={() => copyText(tab.url!, 'Copied URL')}>
                Copy URL
              </MenuItem>
            )}
            {web && (
              <MenuItem icon={<ExternalLink {...icon} />} onSelect={() => openLink(tab.url!)}>
                Open in external browser
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Pencil {...icon} />} onSelect={onRename}>
              Rename
            </MenuItem>
            {web && (
              <MenuItem icon={tab.muted ? <Volume2 {...icon} /> : <VolumeOff {...icon} />} disabled={!!tab.restoring} onSelect={mute}>
                {tab.muted ? 'Unmute tab' : 'Mute tab'}
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}
        {tab.kind === 'artifact' && tab.url && (
          <>
            <MenuItem icon={<RotateCw {...icon} />} onSelect={reload}>
              Reload
            </MenuItem>
            <MenuItem icon={<Link {...icon} />} onSelect={() => copyText(tab.url!, 'Copied link')}>
              Copy link
            </MenuItem>
            <MenuItem icon={<ExternalLink {...icon} />} onSelect={() => openLink(tab.url!)}>
              Open in external browser
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {arrangement && <ToolArrangementItems tabId={tab.id} arrangement={arrangement} />}
        <MenuItem icon={<X {...icon} />} onSelect={() => closePaneTab(tab.id)}>
          Close
        </MenuItem>
        <MenuItem icon={<X {...icon} />} disabled={!hasOthers} onSelect={() => closeOtherPaneTabs(tab.id, 'others')}>
          Close other tabs
        </MenuItem>
        <MenuItem icon={<X {...icon} />} disabled={!hasRight} onSelect={() => closeOtherPaneTabs(tab.id, 'right')}>
          Close tabs to the right
        </MenuItem>
      </Menu>
    </>
  );
}

/** Renaming a browser tab in place: Enter or leaving the field keeps the name (blank gives the page title back), Escape drops it. */
/** Only available tabs can enter this chat's arrangement; the menu owns the required context. */
function ToolArrangementItems({ tabId, arrangement }: { tabId: string; arrangement: Arrangement }) {
  const saved = useToolLayout(arrangement.scope);
  const layout = projectToolLayout(saved, arrangement.available, arrangement.front);
  const disabled =
    !arrangement.available.includes(tabId) || !layout.ids.length || layout.ids.includes(tabId) || layout.ids.length >= TOOL_PANES_MAX;
  const arrange = (axis: 'columns' | 'rows') => {
    rememberToolLayout(arrangement.scope, splitToolLayout(layout, tabId, axis));
    arrangement.select(tabId);
  };
  return (
    <>
      <MenuItem icon={<Columns2 {...icon} />} disabled={disabled} onSelect={() => arrange('columns')}>
        Show beside current tool
      </MenuItem>
      <MenuItem icon={<Rows2 {...icon} />} disabled={disabled} onSelect={() => arrange('rows')}>
        Show below current tool
      </MenuItem>
      <MenuSeparator />
    </>
  );
}

export function PaneTabRename({ tab, onDone }: { tab: PaneTab; onDone(): void }) {
  return (
    <input
      className="tb-tab-rename"
      aria-label="Tab name"
      autoFocus
      defaultValue={browserTabTitle(tab)}
      placeholder={tab.title || 'New tab'}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (isEnter(e)) e.currentTarget.blur();
        cancelOnEscape(e, onDone);
      }}
      onBlur={(e) => {
        renamePaneTab(tab.id, e.currentTarget.value);
        onDone();
      }}
    />
  );
}

export function BrowserDuplicateNotice({ tabId, message }: { tabId: string; message?: string }) {
  if (!message) return null;
  return (
    <PaneNotice role="alert" onClose={() => browserDuplication.dismissError(tabId)}>
      <span>{message}</span>
      <div className="browser-notice-actions">
        <button onClick={() => void browserDuplication.duplicate(tabId)}>Retry Duplicate</button>
      </div>
    </PaneNotice>
  );
}
