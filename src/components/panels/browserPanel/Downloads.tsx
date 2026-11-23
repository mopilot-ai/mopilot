// The browser pane's Downloads button and panel, as the Codex app's browser has them, and the "Download complete" notice
// (#1523 4b): every pane shows the same list from main; the pane showing the page a download started from tells of its end.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { copyText } from '../../../session/clipboard';
import { toast } from '../../../store/core';
import {
  PEEK_MS,
  actFailure,
  downloadStatus,
  downloadsButton,
  isActive,
  isOpenable,
  peeks,
  refreshDownloads,
  useDownloads,
  type DownloadAction,
  type DownloadEntry,
} from '../../../lib/browserDownloads';
import { Menu, MenuItem, Popover, useAnchor } from '../../ui/Popover';
import { AlertTriangle, CircleCheck, Download, File, FolderOpen, Link, MoreHorizontal, Play, Trash2, X } from '../../ui/icons';

/** Runs one download's action in main; says why when it couldn't happen. Resolves whether it did. */
async function act(id: string, action: DownloadAction): Promise<boolean> {
  const result = await native.browser.downloadAct(id, action).catch(() => ({ ok: false as const, reason: 'failed' }));
  const failure = actFailure(action, result);
  if (failure) toast(failure, 'error');
  return result.ok;
}

/** Where a pane shows the notice: its slot under the toolbar (BrowserPanel) or bar (ArtifactPanel), in the layout and never over the page. */
export const NOTICE_SLOT = 'browser-download-slot';
/** The panes that show a page from a panel session, so a download from it is told of there (#2595). */
const PANES = '.browser-pane, .artifact-pane';

/**
 * @param pages the pane's pages (its tab and that tab's popups): a download from one of them is told of here
 * @param front the pane shows this tab in front
 */
export function BrowserDownloads({ pages, front }: { pages: () => readonly (number | null)[]; front: boolean }) {
  const view = useDownloads();
  const panel = useAnchor<HTMLButtonElement>();
  const [peek, setPeek] = useState<DownloadEntry | null>(null);
  // stable, so the notice's timer runs from when it showed and not from the last progress push
  const dismiss = useCallback(() => setPeek(null), []);
  // The page is a native view drawn over the window's DOM: a popover over it would hide it (browserView.ts), so the
  // notice is a band under the toolbar, as the "Save password?" bar is, and the page moves down while it shows
  const [slot, setSlot] = useState<Element | null>(null);
  useLayoutEffect(() => setSlot(panel.anchor?.closest(PANES)?.querySelector(`.${NOTICE_SLOT}`) ?? null), [panel.anchor]);
  const latest = useRef({ pages, front, open: panel.open });
  latest.current = { pages, front, open: panel.open };
  useEffect(
    () =>
      native.browser.onDownloadDone((entry) => {
        const now = latest.current;
        // a newer end takes the notice's place: each download the user started says how it ended
        if (!now.open && peeks(entry, now.pages(), now.front)) setPeek(entry);
      }),
    [],
  );
  // opening the panel: the files are looked at again, everything in it is seen, and the notice gives way
  useEffect(() => {
    if (!panel.open) return;
    setPeek(null);
    refreshDownloads();
    native.browser.downloadsSeen().catch((e) => noteIgnored('mark the browser downloads seen', e));
  }, [panel.open]);
  const button = downloadsButton(view);
  if (!button.shown && !panel.open) return null;
  return (
    <>
      <button
        type="button"
        ref={panel.ref}
        className="browser-btn round browser-downloads-btn"
        aria-label={button.label}
        title={button.label}
        aria-haspopup="dialog"
        aria-expanded={panel.open}
        data-attention={button.attention ?? undefined}
        data-active={button.active > 0}
        data-sized={button.percent != null}
        style={button.percent == null ? undefined : ({ '--download-progress': `${button.percent}%` } as CSSProperties)}
        onClick={panel.toggle}
      >
        <Download size={15} />
      </button>
      <Popover anchor={panel.anchor} open={panel.open} onClose={panel.close} placement="bottom-end" className="browser-downloads-layer">
        <DownloadsPanel downloads={view.downloads} />
      </Popover>
      {slot &&
        peek &&
        createPortal(
          <DownloadNotice
            key={peek.id}
            entry={peek}
            onDone={dismiss}
            onView={() => {
              setPeek(null);
              panel.setOpen(true);
            }}
          />,
          slot,
        )}
    </>
  );
}

function DownloadsPanel({ downloads }: { downloads: DownloadEntry[] }) {
  return (
    <section className="browser-downloads" aria-label="Downloads">
      <header className="browser-downloads-head">
        <span>Downloads</span>
        <button
          type="button"
          className="browser-btn round"
          aria-label="Open folder"
          title="Open folder"
          onClick={() =>
            native.browser
              .openDownloadsFolder()
              .then((r) => r.ok || toast('Unable to open the downloads folder', 'error'))
              .catch(() => toast('Unable to open the downloads folder', 'error'))
          }
        >
          <FolderOpen size={15} />
        </button>
      </header>
      {downloads.length ? (
        <ul className="browser-downloads-list">
          {downloads.map((d) => (
            <DownloadRow key={d.id} d={d} />
          ))}
        </ul>
      ) : (
        <div className="browser-downloads-empty">
          <div>No downloads yet</div>
          <div>Files downloaded from the built-in browser will appear here</div>
        </div>
      )}
    </section>
  );
}

function DownloadRow({ d }: { d: DownloadEntry }) {
  const menu = useAnchor<HTMLButtonElement>();
  const active = isActive(d);
  const openable = isOpenable(d);
  const progress = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
  return (
    <li className="browser-download" data-state={d.state} data-gone={d.exists === false || undefined}>
      <span className="browser-download-icon" aria-hidden="true">
        {d.state === 'interrupted' ? <AlertTriangle size={15} /> : <File size={15} />}
      </span>
      <button
        type="button"
        className="browser-download-text"
        disabled={!openable}
        title={d.path || d.name}
        aria-label={openable ? `Open ${d.name}` : d.name}
        onClick={() => void act(d.id, 'open')}
      >
        <span className="browser-download-name">{d.name}</span>
        <span className="browser-download-status">{downloadStatus(d)}</span>
        {active && (
          <span className="browser-download-bar" data-known={progress != null} aria-hidden="true">
            <span style={progress == null ? undefined : { width: `${progress}%` }} />
          </span>
        )}
      </button>
      {active ? (
        <button
          type="button"
          className="browser-btn round"
          aria-label={`Cancel download ${d.name}`}
          title="Cancel download"
          disabled={d.stopping}
          onClick={() => void act(d.id, 'cancel')}
        >
          <X size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="browser-btn round"
          aria-label={`Show ${d.name} in folder`}
          title="Show in folder"
          disabled={!openable}
          onClick={() => void act(d.id, 'show')}
        >
          <FolderOpen size={14} />
        </button>
      )}
      <button
        type="button"
        ref={menu.ref}
        className="browser-btn round"
        aria-label={`Download actions for ${d.name}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <MoreHorizontal size={14} />
      </button>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={220}>
        {openable && (
          <MenuItem icon={<File size={14} />} onSelect={() => void act(d.id, 'open')}>
            Open
          </MenuItem>
        )}
        {openable && (
          <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void act(d.id, 'show')}>
            Show in folder
          </MenuItem>
        )}
        {d.state === 'paused' && d.canResume && (
          <MenuItem icon={<Play size={14} />} onSelect={() => void act(d.id, 'resume')}>
            Resume download
          </MenuItem>
        )}
        {d.url && (
          <MenuItem icon={<Link size={14} />} onSelect={() => copyText(d.url, 'Copied download link')}>
            Copy download link
          </MenuItem>
        )}
        {active ? (
          <MenuItem icon={<X size={14} />} disabled={d.stopping} onSelect={() => void act(d.id, 'cancel')}>
            Cancel download
          </MenuItem>
        ) : (
          <MenuItem icon={<Trash2 size={14} />} onSelect={() => void act(d.id, 'remove')}>
            Remove from list
          </MenuItem>
        )}
      </Menu>
    </li>
  );
}

/** "Download complete · report.csv" with Show in folder and Open, or "Download failed" with View downloads, under the toolbar. */
function DownloadNotice({ entry, onDone, onView }: { entry: DownloadEntry; onDone: () => void; onView: () => void }) {
  const complete = entry.state === 'completed';
  const [busy, setBusy] = useState<DownloadAction | null>(null);
  // the pointer or focus is on the notice: it stays until both leave, then goes after PEEK_MS
  const [held, setHeld] = useState(0);
  const hold = (on: boolean) => setHeld((n) => Math.max(0, n + (on ? 1 : -1)));
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(onDone, PEEK_MS);
    return () => clearTimeout(timer);
  }, [held, onDone]);
  const run = async (action: DownloadAction) => {
    setBusy(action);
    const ok = await act(entry.id, action);
    setBusy(null);
    if (ok) onDone();
  };
  return (
    // a band in the layout with no overlay role, so the page stays shown (browserView.ts)
    <div
      className="browser-download-notice"
      role="status"
      aria-label={`${complete ? 'Download complete' : 'Download failed'}: ${entry.name}`}
      data-state={entry.state}
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
    >
      {complete ? <CircleCheck size={15} /> : <AlertTriangle size={15} />}
      <span className="browser-download-notice-text">
        <b>{complete ? 'Download complete' : 'Download failed'}</b>
        <span className="browser-download-notice-name">{entry.name}</span>
      </span>
      <div className="browser-download-notice-actions">
        {complete && entry.exists !== false ? (
          <>
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void run('show')}>
              Show in folder
            </button>
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => void run('open')}>
              Open
            </button>
          </>
        ) : (
          <button type="button" className="btn ghost sm" onClick={onView}>
            View downloads
          </button>
        )}
        <button type="button" className="browser-btn" aria-label="Dismiss" onClick={onDone}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
