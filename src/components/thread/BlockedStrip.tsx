// Above the composer when the chat's latest turn ends on a refused browser or desktop step: what was refused and the one-click ways forward that apply (src/lib/blockedChoices.ts).
//
// "Allow this site" allows the refused site for the rest of the chat in the browser that refused it (main:
// OriginGrants.allowInChat on that browser's table; a high-risk site only asks again, a blocked one never)
// and tells the agent to continue. A refusal in the user's own Chrome hands the step to the user there ("I'll
// take over" with no in-app tab). "Open in
// your browser" and "I'll take over" hand the step to the user and turn into "Done", which tells the
// agent to carry on. When the chat's Chrome controller can pick the site up (main: browser:handoffRoute, the
// same route as the pane's "Open in Chrome": Claude in Chrome, the Codex Browser plugin, MoPilot's extension
// or relay, or Your Chrome set up with a Playwright Extension token), the site opens there through the chat's
// Chrome hand-off (main: handoff.cjs, from the chat's current tab; session/handoffResult says when it changed the saved
// Preferred browser), the button says "Open in your Chrome" and
// "Done" tells the agent which tool picks it up; otherwise, or when that hand-off fails, in the default browser. "Allow <app>" and "Allow screen control" ask the agent to try again, so the
// access or takeover card comes back for the user to answer. A message steers the running turn where
// the harness can (Codex, Claude Code) and starts the next one otherwise; it is sent only on a click. "Browser
// settings" (a site the user blocked in Codex Browser Use) opens Settings → Browser and sends nothing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, toast, toastFailure } from '../../store/core';
import { sendMessage } from '../../store/send';
import { chatOf, chatBasicHarness } from '../../store/chats';
import { navigate } from '../../store/panes';
import { askAgainMessage, choiceLabel, followUpFor, latestBlocked, type Blocked, type BlockedChoice } from '../../lib/blockedChoices';
import { chatAgentTabs } from '../../lib/agentTabs';
import { native, type ChromeState } from '../../lib/native';
import { AlertTriangle, X } from '../ui/icons';
import { errorText } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { useChromeContinuation } from '../../lib/useChromeContinuation';
import { ChromeContinuationActions } from '../browser/ChromeContinuationActions';
import { applyHandoffResult } from '../../session/handoffResult';
import { opensInUserChrome, type HandoffRoute } from '../../../shared/chromeHandoff.mjs';
import { DONE_CONTINUE } from '../../lib/doneContinue';
import { liveAction } from '../../store/liveAction';
import { useSessionField } from '../../store/session/useSession';
import { reportedPermission } from '../../../shared/effectivePermission.mjs';

export function BlockedStrip({ threadId }: { threadId: string }) {
  const items = useStore((s) => s.runtime[threadId]?.turns.at(-1)?.items);
  const agentTabs = useStore((s) => s.agentTabs);
  const latest = useMemo(() => latestBlocked(items ?? []), [items]);
  const basic = useStore((s) => chatBasicHarness(threadId, s));
  const permission = useSessionField(threadId, (s) => reportedPermission(s, !!basic));
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // the user took the step over: "Done" tells the agent (`chrome`: the site went to the chat's Chrome, by this route)
  const [waiting, setWaiting] = useState<{
    id: string;
    threadId: string;
    blocked: Blocked;
    choice: BlockedChoice;
    chrome?: { route: HandoffRoute; url: string };
  } | null>(null);
  if (waiting && (waiting.threadId !== threadId || (latest && latest.id !== waiting.id))) setWaiting(null);
  // Keep this refusal through the optimistic continuation turn until its delivery receipt settles.
  const found = latest ?? (waiting?.threadId === threadId ? waiting.blocked : null);
  const key = JSON.stringify([threadId, found?.id, dismissed]);
  const actionOwner = useRef({ key, live: true });
  if (actionOwner.current.key !== key) actionOwner.current = { key, live: true };
  const action = actionOwner.current;
  const currentAction = () => actionOwner.current === action && action.live;
  useEffect(() => {
    action.live = true;
    setResumeError(null);
    return () => {
      action.live = false;
    };
  }, [action]);
  const resumeChrome = useChromeContinuation(
    found && found.id !== dismissed ? JSON.stringify([threadId, found.id, waiting?.id, waiting?.chrome?.url]) : null,
  );
  // Your Chrome: whether "Open in your browser" goes to the chat's Chrome
  const [chrome, setChrome] = useState<ChromeState | null>(null);
  // who would pick the site up in the user's Chrome (null until main says)
  const [route, setRoute] = useState<HandoffRoute | null>(null);
  useEffect(() => {
    let live = true;
    const readRoute = () =>
      native.browser
        .handoffRoute(chatOf(threadId))
        .then((r) => live && setRoute(r ?? null))
        .catch((error) => {
          // Your Chrome's token alone decides until it can be read again
          console.warn("Could not read the chat's route to Chrome for the blocked strip", error);
        });
    native.browser
      .chromeState()
      .then((s) => live && setChrome(s ?? null))
      .catch((error) => {
        // the default browser stays the way out until the channel changes
        console.warn('Could not read the Chrome state for the blocked strip', error);
      });
    void readRoute();
    const off = native.browser.onChannelChanged((s) => {
      setChrome(s);
      void readRoute();
    });
    return () => {
      live = false;
      off();
    };
  }, [threadId]);
  // a vendor controller or MoPilot's own Chrome tools pick the site up; Your Chrome once it has its token
  const inChrome = route && route !== 'your-chrome' ? opensInUserChrome(route) : !!chrome?.hasToken;
  if (!found || found.id === dismissed) return null;
  if (found.reason === 'chat_read_only' && permission && permission !== 'plan' && permission !== 'read-only') return null;
  const b =
    found.reason === 'chat_read_only' && permission === 'plan' ? { ...found, text: 'Plan mode is on: computer use can only look.' } : found;
  const tabKey = () => chatAgentTabs(agentTabs ?? {}, threadId, chatOf)?.key ?? threadId;
  const send = (text: string) => {
    setDismissed(b.id);
    // it didn't go out (main refused it, which said why, or it failed): the strip comes back, to choose again
    const back = () => setDismissed((d) => (d === b.id ? null : d));
    sendMessage(threadId, text, [], { human: true, steer: true }).then(
      (sent) => sent === false && back(),
      (e) => {
        toastFailure("Couldn't send")(e);
        back();
      },
    );
  };
  const choose = async (choice: BlockedChoice) => {
    if (choice === 'allowSite' || choice === 'allowWrite') {
      const r = await native.browser.allowSiteInChat(chatOf(threadId), b.origin!, choice === 'allowWrite' ? 'write' : 'read', b.browser);
      if (r === false) return void toast('This site can’t be allowed for browser control. Do this step yourself.', 'error');
      return send(r === 'ask' ? askAgainMessage(b) : followUpFor(choice, b));
    }
    if (choice === 'openInBrowser') {
      setWaiting({ id: b.id, threadId, blocked: b, choice });
      const opened = await openSite(b.origin!);
      // "Done" then names the tool that picks the site up in Chrome
      if (opened && currentAction()) setWaiting({ id: b.id, threadId, blocked: b, choice, chrome: opened });
      return;
    }
    // the user's own Codex Browser Use block: removed in Settings, never from the chat
    if (choice === 'siteSettings') return navigate({ name: 'settings', section: 'browser' });
    // the composer's permission menu (either picker listens); the user's next message goes on in the new mode
    if (choice === 'changeMode') return void window.dispatchEvent(new Event('open-permission-picker'));
    // the tab may have closed or its turn ended since the strip showed: nothing was taken over, so it isn't "Your turn"
    if (choice === 'takeOver') {
      if (!(await liveAction(native.browser.takeOver(tabKey(), null, true)))) return;
    } else if (choice !== 'doItMyself') return send(followUpFor(choice, b));
    setWaiting({ id: b.id, threadId, blocked: b, choice });
  };
  // the chat's Chrome when its controller can pick the site up (the route says how); the default browser otherwise.
  // Resolves to the route and address the site opened at in Chrome, or null.
  const openSite = async (url: string): Promise<{ route: HandoffRoute; url: string } | null> => {
    if (inChrome) {
      let r: Awaited<ReturnType<typeof native.browser.continueInChrome>> | null = null;
      let failure = '';
      try {
        r = await native.browser.continueInChrome({ chatId: chatOf(threadId), url });
      } catch (error) {
        failure = errorText(error);
      }
      if (!currentAction()) return null;
      if (r?.ok && r.route) applyHandoffResult(r.route, r.preferredChanged);
      if (r?.ok) return r.route ? { route: r.route, url: r.url || url } : null;
      if (r?.cancelled) return null;
      toast(`${r?.message || failure || 'Could not open the site in Chrome.'} Opened it in your default browser instead.`, 'error');
    }
    // the default browser: a link that doesn't open there says why (openLink)
    openLink(url);
    return null;
  };
  const done = (w: NonNullable<typeof waiting>) => {
    // a tab gone since holds nothing back: the line says so and the follow-up goes on
    if (w.choice === 'takeOver')
      void liveAction(native.browser.takeOver(tabKey(), null, false)).catch(toastFailure("Couldn't hand it back"));
    if (!w.chrome) return send(followUpFor(w.choice, b, true));
    void resumeChrome.run(
      { chatId: chatOf(threadId), url: w.chrome.url },
      (message, chromeHandoff, received) => sendMessage(threadId, message, [], { human: true, steer: true, chromeHandoff }, received),
      (error) => (error ? setResumeError(error) : setDismissed(b.id)),
    );
  };
  const handing = waiting?.id === b.id ? waiting : null;
  return (
    <div className="elsewhere-notice blocked-strip" role="status" data-reason={b.reason}>
      <span className="elsewhere-icon">
        <AlertTriangle size={14} />
      </span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">{handing ? 'Your turn: tell the agent when you’re done' : b.text}</div>
        {resumeError && <div>{resumeError}</div>}
      </div>
      <div className="elsewhere-actions">
        {handing ? (
          <ChromeContinuationActions
            resume={resumeChrome}
            chatId={chatOf(threadId)}
            label={DONE_CONTINUE}
            onContinue={() => done(handing)}
            onRemoved={(error) => {
              setResumeError(error);
            }}
          />
        ) : (
          b.choices.map((c, i) => (
            <button key={c} className={`btn-pill${i === 0 ? ' primary' : ''}`} onClick={() => void choose(c)}>
              {choiceLabel(c, b, inChrome)}
            </button>
          ))
        )}
        <button
          className="icon-btn xs"
          aria-label="Dismiss"
          onClick={() => {
            resumeChrome.cancel();
            setDismissed(b.id);
          }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
