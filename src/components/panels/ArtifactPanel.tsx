// The side pane's tab for a page Claude Code published on claude.ai: the page itself in the built-in browser's shared profile, where the claude.ai sign-in lives, or a sign-in wall while that profile isn't signed in (or the page sends it to claude.ai's login).
import { useRef, useState, type RefObject } from 'react';
import { useEffectOn } from '../../lib/effects';
import { closePaneTab } from '../../store/panes';
import type { PaneTab } from '../../store/state';
import { AppWindow, ExternalLink, Link, Palette, RotateCw } from '../ui/icons';
import { openLink } from '../../session/open';
import { copyText } from '../../session/clipboard';
import { isEnabled } from '../../lib/flags';
import { noteIgnored } from '../../lib/ignored';
import { useBrowserTabPage } from '../../session/browserTabPage';
import { useBrowserShortcuts } from '../../session/useBrowserShortcuts';
import { toast } from '../../store/core';
import { SHARED_PARTITION } from '../../../shared/browserStorage.mjs';
import { classifyClaudeUrl } from '../../../shared/claudeArtifacts.mjs';
import { ViewSurface, type WebviewElement } from './browserPanel/ViewSurface';
import { BrowserDownloads, NOTICE_SLOT } from './browserPanel/Downloads';
import { FindBar, usePageFind } from './browserPanel/FindBar';

export const CLAUDE_LOGIN = 'https://claude.ai/login';

/** Whether a page is claude.ai's sign-in page (where a signed-out profile lands). */
export function atClaudeLogin(url: string) {
  try {
    const u = new URL(url);
    return u.hostname === 'claude.ai' && /^\/login(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

const KIND = { artifact: 'Artifact', design: 'Claude Design' };
/** The pane has no address bar for the browser shortcut that focuses one. */
const NO_ADDRESS: RefObject<HTMLInputElement | null> = { current: null };

/** Whether a page is on claude.ai itself. */
function onClaude(url: string) {
  try {
    return new URL(url).hostname === 'claude.ai';
  } catch {
    return false;
  }
}

/** Whether a page at `now` shows `target`: claude.ai's login, or the same claude.ai page however it is linked. */
function showing(now: string, target: string) {
  if (target === CLAUDE_LOGIN) return atClaudeLogin(now);
  const want = classifyClaudeUrl(target);
  // a link that isn't a claude.ai page (a tab from before) is shown only at that address
  if (!want) return now === target;
  return classifyClaudeUrl(now)?.canonical === want.canonical;
}

/** Whether main bound the view yet (a handle can't navigate before). */
function bound(wv: WebviewElement) {
  try {
    wv.getWebContentsId();
    return true;
  } catch {
    return false;
  }
}

/**
 * `signedIn` is whether the shared profile is signed in to claude.ai (null while unknown): the page shows only when it
 * is, or while the user signs in here. A page that lands on claude.ai's login shows the wall even so.
 */
export function ArtifactPanel({ tab, shown, signedIn }: { tab: PaneTab; shown: boolean; signedIn: boolean | null }) {
  const handleRef = useRef<WebviewElement | null>(null);
  // the page is a main-owned view in the shared profile; with the flag off there is no such view to sign in with
  const [viewTabs] = useState(() => isEnabled('shared.browser.viewTabs'));
  // the user chose to sign in here: the page shows claude.ai's login until they leave it signed in
  const [signingIn, setSigningIn] = useState(false);
  // the page went to claude.ai's login: the profile's sign-in ended, or never reached this page
  const [bounced, setBounced] = useState(false);
  // the page left the login signed in here: proof enough, whatever the profile's report says until it says signed out
  const [seen, setSeen] = useState(false);
  const signingInNow = useRef(signingIn);
  signingInNow.current = signingIn;
  const url = tab.url ?? '';
  const target = signingIn ? CLAUDE_LOGIN : url;
  const page = viewTabs && (signingIn || ((signedIn === true || seen) && !bounced));
  const kind = tab.artifactKind ?? 'artifact';
  // a page main hasn't bound yet has nothing to reload
  const reload = () => {
    const wv = handleRef.current;
    if (wv && bound(wv)) wv.reload();
  };
  useBrowserTabPage(tab.id, { reload, pageId: () => null, muted: false });
  const find = usePageFind(handleRef, page);
  // the browser pane's page keys while the page is in front: Zoom In, Zoom Out, Actual Size, Reload, Back, Find (#2600)
  useBrowserShortcuts({
    page: handleRef,
    address: NO_ADDRESS,
    front: shown && page,
    paneId: tab.id,
    url,
    reload,
    annotate: () => {
      // the pane has no comment mode
    },
    find: find.command,
    unavailable: () => toast('This page is not ready yet. Try again in a moment.', 'error'),
  });
  // a sign-in the profile reports (here, in another tab or by an import) shows the page again
  useEffectOn([signedIn], () => {
    if (signedIn === false) setSeen(false);
    if (signedIn !== true) return;
    setBounced(false);
    setSigningIn(false);
  });
  // the page follows what the tab shows (the login while signing in, the artifact after), once it is bound: a new
  // page loads it itself, and a page the tab had before (shown again after the wall) may be anywhere
  useEffectOn([target, page], () => {
    const wv = handleRef.current;
    if (!page || !wv) return;
    const go = () => {
      const now = wv.getURL();
      if (!now || showing(now, target)) return;
      // the page went: its closed event takes the tab away
      wv.loadURL(target).catch((e) => noteIgnored("load an artifact tab's page", e));
    };
    if (bound(wv)) {
      go();
      return;
    }
    wv.addEventListener('did-attach', go);
    return () => wv.removeEventListener('did-attach', go);
  });
  // a newer version the chat published: the page reloads to show it
  const version = useRef(tab.version);
  useEffectOn([tab.version], () => {
    if (version.current === tab.version) return;
    version.current = tab.version;
    reload();
  });
  // the page's own navigation: leaving the login signed in ends signing in; landing on it means signed out
  useEffectOn([page], () => {
    const wv = handleRef.current;
    if (!page || !wv) return;
    const moved = () => {
      const now = wv.getURL();
      // an identity provider's page (Continue with Google, SSO) is part of signing in, not its end
      if (!onClaude(now)) return;
      if (atClaudeLogin(now)) return setBounced(true);
      setBounced(false);
      if (!signingInNow.current) return;
      setSigningIn(false);
      setSeen(true);
    };
    // claude.ai routes in the page, so a sign-in that ends there moves in-page
    for (const type of ['did-navigate', 'did-navigate-in-page']) wv.addEventListener(type, moved);
    return () => {
      for (const type of ['did-navigate', 'did-navigate-in-page']) wv.removeEventListener(type, moved);
    };
  });
  const Icon = kind === 'design' ? Palette : AppWindow;
  return (
    <div className="artifact-pane">
      <div className="artifact-pane-bar">
        <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
        <span className="artifact-pane-title">{tab.title}</span>
        <span className="artifact-pane-chip">
          {KIND[kind]}
          {tab.version ? ` · version ${tab.version}` : ''}
        </span>
        {page && (
          <button className="icon-btn" aria-label="Reload" title="Reload" onClick={reload}>
            <RotateCw size={15} strokeWidth={1.6} />
          </button>
        )}
        {/* the page's downloads (an export, a file it links): the browser pane's button, list and notice (#2595) */}
        {page && (
          <BrowserDownloads
            pages={() => (handleRef.current && bound(handleRef.current) ? [handleRef.current.getWebContentsId()] : [])}
            front={shown}
          />
        )}
        <button className="icon-btn" aria-label="Copy link" title="Copy link" onClick={() => copyText(url, 'Copied link')}>
          <Link size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" aria-label="Open in browser" title="Open in browser" onClick={() => openLink(url)}>
          <ExternalLink size={15} strokeWidth={1.6} />
        </button>
      </div>
      {page && <div className={NOTICE_SLOT} />}
      {page && <FindBar find={find} />}
      {page ? (
        // the browser pane's stage: the page leaves the pane's resize handle uncovered
        <div className="browser-stage">
          <ViewSurface
            handleRef={handleRef}
            paneId={tab.id}
            url={target}
            partition={SHARED_PARTITION}
            chatId={null}
            chat={tab.ownerChat ?? null}
            tabKey={null}
            shown={shown}
            onClosed={() => closePaneTab(tab.id)}
          />
        </div>
      ) : (
        <div className="artifact-wall">
          <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
          <p className="artifact-wall-title">Sign in to claude.ai to see this {kind === 'design' ? 'design' : 'page'} here</p>
          <p className="artifact-wall-text">
            {viewTabs
              ? 'The built-in browser isn’t signed in to claude.ai. Sign in here, or import your sign-ins in Settings → Browser.'
              : 'Open it in your browser, where you’re signed in to claude.ai.'}
          </p>
          <div className="artifact-wall-actions">
            {viewTabs && (
              <button className="btn-pill" onClick={() => (setBounced(false), setSigningIn(true))}>
                Sign in to claude.ai
              </button>
            )}
            <button className="btn-pill soft" onClick={() => openLink(url)}>
              Open in browser
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
