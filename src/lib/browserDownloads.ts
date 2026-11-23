// The browser pane's Downloads list as main keeps it (electron/capabilities/browser/downloadList.cjs): one copy per window,
// read once and then followed, plus the rules the pane shows it by: each row's status words, the toolbar button's state,
// and which pane peeks a download that ended. The words and rules follow the Codex app's browser (#1523 4b).
import { useSyncExternalStore } from 'react';
import { native } from './native';
import { noteIgnored } from './ignored';
import { pluralize } from './format';

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
export interface DownloadEntry {
  id: string;
  name: string;
  path: string;
  url: string;
  state: DownloadState;
  received: number;
  total: number;
  startedAt: number;
  endedAt: number | null;
  /** saved into an agent's chat folder while it drove the tab */
  agent: boolean;
  /** the page it started from: the pane showing that page peeks it */
  pageId: number | null;
  /** a Downloaded file is still where it was saved (null until it finished) */
  exists: boolean | null;
  /** the user asked to cancel it; its end says how it ended */
  stopping: boolean;
  canResume: boolean;
}
export interface DownloadsView {
  downloads: DownloadEntry[];
  /** finished downloads the user hasn't looked at */
  unseen: string[];
}
export type DownloadAction = 'open' | 'show' | 'cancel' | 'resume' | 'remove';
export type DownloadActResult = { ok: true } | { ok: false; reason: string; message?: string };

/** How long a peek stays when nothing holds it (the Codex app's 5s). */
export const PEEK_MS = 5000;

const EMPTY: DownloadsView = { downloads: [], unseen: [] };
let view: DownloadsView = EMPTY;
const listeners = new Set<() => void>();
let off: (() => void) | null = null;

function publish(next: DownloadsView) {
  view = next;
  for (const l of listeners) l();
}

/** Reads the list again from main (the panel opening: whether each Downloaded file is still there). */
export function refreshDownloads() {
  // main's replies and pushes arrive in the order it sent them, so the last to arrive is the newest
  native.browser
    .downloads()
    .then(publish)
    .catch((e) => noteIgnored('read the browser downloads', e));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!off) {
    off = native.browser.onDownloads(publish);
    refreshDownloads();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size || !off) return;
    off();
    off = null;
  };
}

/** The Downloads list, followed for as long as a component shows it. */
export function useDownloads(): DownloadsView {
  return useSyncExternalStore(subscribe, () => view);
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A row's status line: "Downloaded · 37 bytes · 11:30 PM", "1.2 MB of 3 MB", "Stopped · 11:32 PM"... */
export function downloadStatus(d: DownloadEntry, time: (ms: number) => string = clock): string {
  const when = time(d.endedAt ?? d.startedAt);
  const size = d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
  switch (d.state) {
    case 'progressing':
      if (d.stopping) return 'Stopping…';
      return d.received ? size : 'Starting';
    case 'paused':
      return `Paused · ${size}`;
    case 'completed':
      return d.exists === false ? `File moved or deleted · ${when}` : `Downloaded · ${formatBytes(d.total || d.received)} · ${when}`;
    case 'cancelled':
      return `Stopped · ${when}`;
    default:
      return `Download failed · ${when}`;
  }
}

export const isActive = (d: DownloadEntry) => d.state === 'progressing' || d.state === 'paused';
/** A Downloaded file the user can open or show (not known to be gone). */
export const isOpenable = (d: DownloadEntry) => d.state === 'completed' && d.exists !== false;

/**
 * The toolbar button: shown once there is a download; how far the ones under way have got (null: unknown sizes);
 * a dot for finished ones not looked at (a failure first); and the label that says all of it.
 */
export function downloadsButton(v: DownloadsView) {
  const active = v.downloads.filter(isActive);
  const unseen = new Set(v.unseen);
  const done = v.downloads.filter((d) => unseen.has(d.id));
  const failed = done.filter((d) => d.state === 'interrupted').length;
  const ready = done.filter((d) => d.state === 'completed').length;
  const attention: 'failure' | 'completion' | null = failed ? 'failure' : ready ? 'completion' : null;
  const sized = active.length > 0 && active.every((d) => d.total > 0);
  const total = active.reduce((n, d) => n + d.total, 0);
  const got = active.reduce((n, d) => n + Math.min(d.total, d.received), 0);
  const percent = sized ? Math.round((got / total) * 100) : null;
  let label = 'Downloads';
  if (active.length && active.every((d) => d.state === 'paused'))
    label = `Downloads, ${pluralize(active.length, 'download paused', 'downloads paused')}`;
  else if (active.length)
    label = `Downloads, ${pluralize(active.length, 'active download', 'active downloads')}${percent == null ? ' in progress' : `, ${percent}% complete`}`;
  if (failed) label += `, ${pluralize(failed, 'failed download needs', 'failed downloads need')} attention`;
  else if (ready) label += `, ${pluralize(ready, 'completed download', 'completed downloads')} ready`;
  return { shown: v.downloads.length > 0, active: active.length, percent, attention, label };
}

/**
 * Whether a pane peeks a download that ended: one the user started (an agent's own result says where its file
 * went), that Downloaded or failed (Stopped was the user's doing), from a page the pane shows in front.
 */
export function peeks(d: DownloadEntry, pages: readonly (number | null)[], front: boolean): boolean {
  if (!front || d.agent || d.pageId == null) return false;
  return (d.state === 'completed' || d.state === 'interrupted') && pages.includes(d.pageId);
}

/** What the user is told when an action on a download couldn't happen. */
export function actFailure(action: DownloadAction, r: DownloadActResult): string | null {
  if (r.ok) return null;
  if (r.reason === 'missing') return 'This download is no longer available';
  if (action === 'open') return `Unable to open the downloaded file${r.message ? `: ${r.message}` : ''}`;
  if (action === 'show') return 'Unable to show the downloaded file in its folder';
  if (action === 'resume') return 'This download cannot be resumed';
  if (action === 'remove') return 'Active downloads cannot be removed';
  return 'Unable to complete the download action';
}
