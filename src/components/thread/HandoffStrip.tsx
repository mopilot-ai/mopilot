// Above the composer when the agent handed the browser to the user (BU-12): the last browser step of
// the chat's latest turn was a hand-off (a tab marked for the user, a sign-in or CAPTCHA page, the user
// taking over). It is read from the turn's tool items through the narration adapters, so every harness
// and browser (the in-app browser, the user's Chrome) shows the same strip. "Done, continue" tells the agent
// to carry on; any later browser step or a new turn clears it. "Open tab" shows only while it would bring
// the tab into view: with the tab already in front of the open pane it would do nothing (CM-K18).
//
// A hand-off (browser_request_signin, IAB-05) ends the agent's turn with its input to the tab paused. It says "Sign in to
// <site>" when the page asks for a credential, else what the step is; "Done, continue" has main send "Done on <site>" into the
// chat, which starts the next turn (#1834). When the tab is no longer held (closed, or the user replied), the button tells the
// agent in a message instead, as the plain hand-off does.
import { useMemo, useState } from 'react';
import { useStore, toastFailure } from '../../store/core';
import { sendMessage } from '../../store/send';
import { openAgentBrowserTab, agentBrowserTabOpens } from '../../store/panes';
import { chatOf } from '../../store/chats';
import { openLink } from '../../session/open';
import { hostOf, latestHandoff, type Handoff, type HandoffReason } from '../../lib/agentNarration';
import { chatAgentTabs } from '../../lib/agentTabs';
import { native } from '../../lib/native';
import { Hand, X } from '../ui/icons';
import { DONE_CONTINUE } from '../../lib/doneContinue';

const REASON: Record<HandoffReason, string> = {
  signIn: 'Sign in to continue',
  captcha: 'Solve the CAPTCHA',
  payment: 'Confirm the payment',
  tookOver: 'You took over',
  continue: 'Finish the step on the page',
};

/** Where the user picks up, as the strip says it: the in-app browser (browser_* or the Codex Browser plugin's iab backend) or their Chrome. */
export const handoffPlace = (h: Handoff) => (h.where === 'chrome' ? 'Chrome' : 'the browser');

/** What "Done, continue" sends: the user is done, the agent continues from a fresh look at the page. */
export const resumePrompt = (h: Handoff) =>
  `I'm done in ${handoffPlace(h)}. Continue the task from where you handed it to me, and check the page again first.`;

export function HandoffStrip({ threadId }: { threadId: string }) {
  const turns = useStore((s) => s.runtime[threadId]?.turns);
  const agentTabs = useStore((s) => s.agentTabs);
  // what the pane shows: "Open tab" is offered only while it would bring the tab into view
  const paneTabs = useStore((s) => s.paneTabs);
  const paneActive = useStore((s) => s.paneActive);
  const diffPanel = useStore((s) => s.diffPanel);
  const route = useStore((s) => s.route);
  const split = useStore((s) => s.split);
  useStore((s) => s.segments); // chatOf follows switched chats, as the pane does
  // the latest turn's hand-off; earlier turns tell which browser a program's kept tab is in (cua_repl state persists)
  const found = useMemo(
    () =>
      latestHandoff(
        turns?.at(-1)?.items ?? [],
        (turns ?? []).slice(0, -1).flatMap((t) => t.items ?? []),
      ),
    [turns],
  );
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!found || found.id === dismissed) return null;
  let h = found.handoff;
  // what the strip asked for didn't happen: it comes back, to try again
  const back = () => setDismissed((d) => (d === found.id ? null : d));
  const resume = () =>
    sendMessage(threadId, resumePrompt(h), [], { human: true }).then(
      // false: main didn't take it, and sendMessage said why
      (sent) => sent === false && back(),
      (e) => {
        toastFailure("Couldn't send")(e);
        back();
      },
    );
  // the in-app tab opens in the pane; a Chrome tab opens by its address when the step named one
  let open: (() => void) | null = null;
  let reason = REASON[h.reason];
  let done: (() => void) | null = null;
  if (h.where === 'app') {
    const app = chatAgentTabs(agentTabs, threadId, chatOf);
    const key = app?.key ?? threadId;
    // the tab the step names; else the one the user signs in on, or the one handed over (a plugin program marks it, naming no tab)
    const tab = h.tabId
      ? app?.tabs.find((t) => t.tabId === h.tabId)
      : (app?.tabs.find((t) => !!t.signin) ?? app?.tabs.find((t) => t.mark === 'handoff'));
    // already in front in the open pane: there is nothing to open, so no button (a dead end otherwise, edge2 twofa)
    if (agentBrowserTabOpens({ paneTabs, paneActive, diffPanel, route, split }, key, { tabKey: tab?.tabKey }))
      open = () => openAgentBrowserTab(key, { tabKey: tab?.tabKey });
    // a hand-off the user took to their Chrome is their turn there (the tab's view says so)
    if (h.signin && tab?.moved) {
      h = { ...h, where: 'chrome', url: null };
      open = null;
    } else if (h.signin) {
      // "Sign in" only when the page asks for a credential (main reads the page at the hand-off)
      if (tab?.origin) {
        const host = hostOf(tab.origin);
        reason = tab.signin?.credential ? `Sign in to ${host}` : h.reason === 'captcha' ? REASON.captcha : `Finish the step on ${host}`;
      }
      done = () => {
        setDismissed(found.id);
        // main sends "Done on <site>"; with the tab no longer held, tell the agent instead
        native.browser.signinDone(key, h.tabId ?? tab?.tabId ?? null).then(
          (ok) => {
            if (!ok) void resume();
          },
          (e) => {
            toastFailure("Couldn't tell the agent you're done")(e);
            back();
          },
        );
      };
    }
  } else if (h.url) {
    const url = h.url;
    open = () => openLink(url);
  }
  return (
    <div className="elsewhere-notice handoff-strip" role="status" data-reason={h.reason}>
      <span className="elsewhere-icon">
        <Hand size={14} />
      </span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">
          Your turn in {handoffPlace(h)} · {reason}
        </div>
        {h.note && <div className="elsewhere-body">{h.note}</div>}
      </div>
      <div className="elsewhere-actions">
        {open && (
          <button className="btn-pill" onClick={open}>
            Open tab
          </button>
        )}
        <button
          className="btn-pill primary"
          onClick={
            done ??
            (() => {
              setDismissed(found.id);
              // cannot reject: resume handles a refusal and a failure itself
              void resume();
            })
          }
        >
          {DONE_CONTINUE}
        </button>
        <button className="icon-btn xs" aria-label="Dismiss" onClick={() => setDismissed(found.id)}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
