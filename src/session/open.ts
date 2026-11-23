// Opening files, folders and links: the preferred app, the built-in browser pane or the system browser.

import { native } from '../lib/native';
import { useStore, toast, toastFailure } from '../store/core';
import { openPaneTab } from '../store/panes';
import { basename, decodeLinkPath, localLinkParts } from '../lib/paths';
import { lookupMessagePath } from '../lib/messagePaths';
import { parseRemoteCwd, remoteCwd, remotePathOf } from '../lib/remoteFolder';
import { lineSpan, type LineSpan } from '../lib/lineSpan';
import { modKey } from '../lib/platform';

/**
 * Why main couldn't open it, or '': shell.openPath answers an error text ('' when it opened), and an app
 * launch answers { ok: false, stderr } when the app didn't start.
 */
function openFailure(r: unknown): string {
  if (typeof r === 'string') return r;
  const launch = r as { ok?: unknown; stderr?: unknown } | null | undefined;
  return launch?.ok === false ? String(launch.stderr || "the app didn't start") : '';
}

/** A click that opens nothing says why; the request itself can reject too. */
function reportOpen(result: Promise<unknown>, p: string): void {
  const what = `Couldn't open ${basename(p)}`;
  Promise.resolve(result).then((r) => {
    const why = openFailure(r);
    if (why) toast(`${what}: ${why}`, 'error');
  }, toastFailure(what));
}

/** Open a file or folder in the user's preferred destination (Settings → General); a failure is a toast. */
export function openPath(p: string): void {
  const dest = useStore.getState().prefs.openDestination;
  reportOpen(dest === 'finder' ? native.shell.openPath(p) : native.shell.openIn(dest, p), p);
}

/** Open a file or folder in a named app (VS Code, Cursor, Terminal); a launch that fails is a toast. */
export function openInApp(app: string, p: string): void {
  reportOpen(native.shell.openIn(app, p), p);
}

/** Open a folder in Finder (Explorer on Windows), whatever the preferred destination; a failure is a toast. */
export function showInFinder(p: string): void {
  reportOpen(native.shell.openPath(p), p);
}

/** Open a file in its default app (a folder in Finder), whatever the preferred destination; a failure is a toast. */
export function openFile(p: string): void {
  reportOpen(native.shell.openPath(p), p);
}

/** Show a file or folder selected in Finder (Explorer on Windows); a request that fails is a toast. */
export function revealPath(p: string): void {
  native.shell.reveal(p).catch(toastFailure(`Couldn't show ${basename(p)}`));
}

/** Open a link in the system browser; one that doesn't open is a toast, not a click that did nothing. */
export function openLink(url: string): void {
  native.shell.openExternal(url).catch(toastFailure("Couldn't open the link"));
}

/** Open a page of the MoPilot website (/credits, /account, /privacy) in the system browser; a failure is a toast. */
export function openMoPilotPage(pathname: string): void {
  native.mopilot.openWeb(pathname).catch(toastFailure("Couldn't open the MoPilot page"));
}

/** Open web links in the app unless the click explicitly requests the system browser (a failure is a toast). */
export function openUrl(url: string, external = false): void {
  if (!external && /^https?:\/\//i.test(url)) openPaneTab('browser', { url, title: url });
  else openLink(url);
}

/**
 * Open a path a reply names, checked again at the click since it may be gone by now: a folder in Finder, a file beside
 * the conversation (Cmd-click, Ctrl elsewhere: in the preferred app). "~" is the home folder and a relative path is in
 * the chat's folder; one that isn't there is a toast.
 */
export async function openMessagePath(path: string, cwd?: string | null, span: LineSpan = {}, external = false): Promise<void> {
  // a file in a chat on a machine opens in the pane, read through that machine's Host; it is not on this Mac
  const remote = parseRemoteCwd(cwd);
  if (remote) {
    const at = remotePathOf(path, remote.folder);
    // the chat's machine is not known yet: nothing opens here or there
    if (!remote.machineId) return toast('Still checking where this chat runs. Try again in a moment.', 'error');
    if (external || !at) return toast('That file is on another machine. It opens in the app.', 'error');
    return openPaneTab('file', {
      path: at,
      line: span.line,
      endLine: span.endLine,
      cwd: remoteCwd(remote.machineId, remote.folder),
      title: basename(at),
    });
  }
  let found;
  try {
    found = await lookupMessagePath(path, cwd);
  } catch (e) {
    toastFailure(`Couldn't open ${basename(path)}`)(e);
    return;
  }
  if (!found) return toast(`Couldn't find ${basename(path)}`, 'error');
  if (found.kind === 'dir') return showInFinder(found.path);
  if (external) return openPath(found.path);
  openPaneTab('file', { path: found.path, line: span.line, endLine: span.endLine, cwd: cwd ?? undefined, title: basename(found.path) });
}

/** Message links open beside the conversation; Cmd-click (Ctrl elsewhere) opens externally. */
export function openMessageLink(href: string, cwd?: string | null, event?: { metaKey: boolean; ctrlKey: boolean }, asUrl = false) {
  const external = event ? modKey(event) : false;
  if (/^https?:|^mailto:/i.test(href)) {
    openUrl(href, external);
    return;
  }
  const file = localLinkParts(href, asUrl);
  let path = file.path;
  // `#L12`, `:12:5` (a column) or a range `#L5-L20` / `:5-20`
  const citation = /[#:]L?(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?|:\d+)?$/;
  const inPath = citation.exec(path);
  const fragment = citation.exec(file.fragment);
  const location = fragment?.index === 0 ? fragment : inPath;
  if (inPath) path = path.slice(0, inPath.index);
  const folder = parseRemoteCwd(cwd)?.folder ?? cwd;
  void openMessagePath(decodeLinkPath(path, file, folder), cwd, location ? lineSpan(location[1], location[2]) : {}, external);
}
