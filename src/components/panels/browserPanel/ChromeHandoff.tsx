// The browser pane's "Continue in Chrome": one click opens the page in the chat's Chrome and continues the task there; a sign-in hand-off waits for the user to sign in first; a route still missing its extension offers to add it and goes on by itself once it is there.
import { useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { navigate } from '../../../store/panes';
import { sendMessage } from '../../../store/send';
import { toast, toastFailure } from '../../../store/core';
import { applyHandoffResult, PREFERRED_WILL_CHANGE, savedChrome } from '../../../session/handoffResult';
import { native, type ChromeState } from '../../../lib/native';
import { errorText, noteIgnored, userError } from '../../../lib/ignored';
import { browserUrl, isWebUrl, CHROME_APPROVAL } from '../../../../shared/browser.mjs';
import { ROUTE_LABEL, needsSetup, opensInUserChrome, setupReason, type HandoffRoute } from '../../../../shared/chromeHandoff.mjs';
import { useChromeContinuation } from '../../../lib/useChromeContinuation';
import { ChromeTaskContinue } from '../../browser/ChromeContinuationActions';
import { busyField } from '../../../lib/focus';
import { PaneNotice } from './PaneNotice';

/**
 * Why the user went to Chrome: 'continue' (the toolbar, a page that failed) goes on as soon as the page is open there;
 * 'signin' (a passkey, an identity provider, the saved-logins menu) waits for the user to sign in there first.
 */
export type HandoffIntent = 'continue' | 'signin';

export type Handoff = {
  url: string;
  chatId: string;
  pageId: number;
  busy: boolean;
  error?: string;
  done?: boolean;
  intent: HandoffIntent;
  // the open that finished it (its run), so a 'continue' hand-off is sent once per open, whatever updates it after
  opened?: number;
  // the notice asked the user first (an address to choose, a change to the saved Preferred browser): its form stays up
  asked?: boolean;
  // who continues in Chrome (main: browser:handoffRoute); a route that needs setup offers it instead of a hand-off
  route: HandoffRoute;
};

/**
 * The hand-off's state for one pane page. `pageId` reads the page's webContents id now (throws when it has none);
 * `rootPage` is the id the pane follows, so a read for a page since replaced is dropped.
 */
export function useChromeHandoff({
  chatId,
  generation,
  pageId,
  rootPage,
  onChrome,
  pageGone,
}: {
  chatId: string | null;
  generation: number;
  pageId: () => number;
  rootPage: () => number | null;
  onChrome: boolean;
  pageGone: () => void;
}) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const resume = useChromeContinuation(
    handoff ? JSON.stringify([handoff.chatId, handoff.pageId, handoff.url, generation, handoff.done]) : null,
  );
  const run = useRef(0);
  useEffectOn([generation, chatId], () => {
    run.current++;
    return () => {
      run.current++;
    };
  });
  /** Opens the page in Chrome; a 'continue' hand-off then sends the continuation by itself (the effect below). */
  const open = async (request: Handoff) => {
    if (request.busy) return;
    const mine = ++run.current;
    setHandoff({ ...request, busy: true, error: undefined });
    try {
      const result = await native.browser.continueInChrome({ webContentsId: request.pageId, chatId: request.chatId, url: request.url });
      if (run.current !== mine) return;
      if (!result.ok) {
        setHandoff({ ...request, busy: false, error: userError(result.message, { fallback: 'Could not connect to Chrome.' }) });
        return;
      }
      const route = result.route ?? request.route;
      applyHandoffResult(route, result.preferredChanged);
      setHandoff({ ...request, url: result.url || request.url, busy: false, done: true, route, opened: mine });
    } catch {
      if (run.current === mine) setHandoff({ ...request, busy: false, error: 'Could not connect to Chrome. Check Browser settings.' });
    }
  };
  /**
   * Goes ahead with a hand-off whose route is known: a route that needs setup shows it; an address to choose, or a
   * Your Chrome hand-off that would change the saved Preferred browser for every chat, asks first; else it opens now.
   */
  const proceed = (next: Handoff) => {
    if (needsSetup(next.route)) setHandoff(next);
    else if (!isWebUrl(next.url) || (next.route === 'your-chrome' && !onChrome && !savedChrome())) setHandoff({ ...next, asked: true });
    else void open(next);
  };
  // the recheck below goes ahead with the current render's settings, not those of the render that started waiting
  const proceedNow = useRef(proceed);
  proceedNow.current = proceed;
  const prepare = async (intent: HandoffIntent) => {
    resume.cancel();
    if (!chatId) return;
    const mine = ++run.current;
    try {
      const page = rootPage() ?? pageId();
      const [state, route] = await Promise.all([native.browser.pageState(page), readRoute(chatId)]);
      if (rootPage() !== page || run.current !== mine) return;
      proceed({ url: state.restartUrl || '', chatId, pageId: page, busy: false, route, intent });
    } catch {
      if (run.current === mine) pageGone();
    }
  };
  // MoPilot's extension being added goes on by itself once it is there (main says its availability changed, or the
  // user comes back to the window from Chrome). 'none' and 'setup' wait for the user: what Settings turns on later is
  // no answer to a notice they may have left behind
  const waiting = handoff && !handoff.busy && !handoff.done && handoff.route === 'setup-extension' ? handoff : null;
  useEffectOn([waiting?.chatId, waiting?.pageId, waiting?.route], () => {
    if (!waiting) return;
    let live = true;
    const recheck = () => {
      void readRoute(waiting.chatId).then((route) => {
        if (!live || needsSetup(route)) return;
        // one go ahead, however many changes come in meanwhile
        live = false;
        proceedNow.current({ ...waiting, route });
      });
    };
    const off = native.availability.onChanged(recheck);
    window.addEventListener('focus', recheck);
    return () => {
      live = false;
      off();
      window.removeEventListener('focus', recheck);
    };
  });
  // a 'continue' hand-off sends the continuation once the page is open in Chrome: one click in all
  const sent = useRef<number | null>(null);
  useEffectOn([handoff?.opened], () => {
    if (!handoff?.done || handoff.intent !== 'continue' || handoff.opened === undefined || sent.current === handoff.opened) return;
    sent.current = handoff.opened;
    continueTask(handoff);
  });
  const continueTask = (h: Handoff) =>
    void resume.run(
      { chatId: h.chatId, url: h.url, signedIn: h.intent === 'signin' },
      (message, chromeHandoff, received) => sendMessage(h.chatId, message, [], { human: true, chromeHandoff }, received),
      (error) => setHandoff(error ? { ...h, busy: false, error } : null),
    );
  const cancel = async (request: Handoff) => {
    if (!request.busy || request.done) {
      resume.cancel();
      run.current++;
      setHandoff(null);
      return;
    }
    const mine = run.current;
    const cancelled = await native.browser.cancelChromeHandoff({ webContentsId: request.pageId, chatId: request.chatId }).catch((e) => {
      if (run.current === mine) toast(`Couldn't cancel opening this page in Chrome: ${errorText(e)}`, 'error');
      return false;
    });
    if (!cancelled || run.current !== mine) return;
    run.current++;
    setHandoff(null);
  };
  /** The page moved on (the user typed an address): any hand-off of the old one is put away. */
  const reset = () => {
    resume.cancel();
    setHandoff(null);
  };
  return { handoff, setHandoff, resume, open, prepare, cancel, reset };
}

/** main decides the route again when the user goes ahead; a failed read only words the notice ('none'). */
const readRoute = (chatId: string) =>
  native.browser.handoffRoute(chatId).catch((e): HandoffRoute => {
    noteIgnored("read the chat's route to Chrome", e);
    return 'none';
  });

const browserSettings = () => navigate({ name: 'settings', section: 'browser' });

/** "Add to Chrome": the extension's store page; a build with no store listing sends the user to Browser settings. */
const addToChrome = () =>
  native.availability
    .chromeInstall()
    .then((r) => r === 'unavailable' && browserSettings())
    .catch(toastFailure("Couldn't open the Chrome Web Store"));

export function ChromeHandoffNotice({
  state,
  chrome,
  onChrome,
}: {
  state: ReturnType<typeof useChromeHandoff>;
  chrome: ChromeState | null;
  onChrome: boolean;
}) {
  const { handoff, setHandoff, resume, open, cancel } = state;
  if (!handoff) return null;
  const sending = handoff.done && handoff.intent === 'continue' && resume.busy;
  return (
    <PaneNotice className="browser-handoff" closeLabel="Cancel" onClose={() => void cancel(handoff)}>
      {handoff.done ? (
        <>
          <span>
            {sending
              ? 'Continuing in Chrome…'
              : handoff.intent === 'continue'
                ? 'Opened in your Chrome.'
                : opensInUserChrome(handoff.route)
                  ? `Opened in your Chrome. Sign in there, then continue with ${ROUTE_LABEL[handoff.route]}.`
                  : 'Opened in Your Chrome. Sign in there, then continue.'}
          </span>
          {!sending && (
            <div className="browser-notice-actions">
              <ChromeTaskContinue
                resume={resume}
                chatId={handoff.chatId}
                url={handoff.url}
                signedIn={handoff.intent === 'signin'}
                onSettled={(error) => setHandoff(error ? { ...handoff, busy: false, error } : null)}
                onRemoved={(error) => setHandoff({ ...handoff, error: error ?? undefined })}
              />
            </div>
          )}
        </>
      ) : needsSetup(handoff.route) ? (
        <>
          <span>{setupReason(handoff.route)}</span>
          <div className="browser-notice-actions">
            {handoff.route === 'setup-extension' && (
              <button className="primary" onClick={() => void addToChrome()}>
                Add to Chrome
              </button>
            )}
            <button onClick={browserSettings}>Browser settings</button>
          </div>
        </>
      ) : !handoff.asked && !handoff.error ? (
        <span>Opening in Chrome…</span>
      ) : (
        <>
          <span>
            {opensInUserChrome(handoff.route)
              ? `Open this site in your Chrome and continue with ${ROUTE_LABEL[handoff.route]}.`
              : onChrome
                ? 'Open this site in Chrome, where agents already work.'
                : `Restart on this site in Chrome.${savedChrome() ? '' : ` ${PREFERRED_WILL_CHANGE}`}`}
          </span>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const url = browserUrl(handoff.url);
              if (url && isWebUrl(url)) void open({ ...handoff, url });
              else setHandoff({ ...handoff, error: 'Enter a web address.' });
            }}
          >
            <input
              type="url"
              value={handoff.url}
              {...busyField(!!handoff.busy)}
              aria-label="Site to continue in Chrome"
              placeholder="Site address"
              onChange={(e) => setHandoff({ ...handoff, url: e.target.value, error: undefined })}
            />
            <div className="browser-notice-actions">
              <button type="submit" className="primary" disabled={handoff.busy || !handoff.url.trim()}>
                {handoff.busy ? 'Connecting to Chrome…' : 'Open in Chrome'}
              </button>
              <button type="button" disabled={handoff.busy} onClick={browserSettings}>
                Browser settings
              </button>
            </div>
          </form>
        </>
      )}
      {handoff.busy && !handoff.done && !chrome?.hasToken && !opensInUserChrome(handoff.route) && <span>{CHROME_APPROVAL}</span>}
      {handoff.error && <span role="alert">{handoff.error}</span>}
    </PaneNotice>
  );
}
