// Browser agent handoff controls, the emulated-device badge, blank-tab tools, the toolbar's navigation pill and address-host presentation.
import { shortcutLabel, terminalTitle } from '../../../lib/platform';
import { useState, type RefObject } from 'react';
import { closePaneTab, navigate, openPaneTab, openChanges } from '../../../store/panes';
import { openSideChat } from '../../../store/actions';
import { toast } from '../../../store/core';
import {
  ArrowLeft,
  ArrowRight,
  FileDiff,
  SquareTerminal,
  FolderTree,
  MessageCirclePlus,
  MousePointerClick,
  Hand,
  RotateCw,
  X,
} from '../../ui/icons';
import { native, type AgentTabView } from '../../../lib/native';
import { accessLabel } from '../../../lib/agentTabs';
import type { WebviewElement } from './ViewSurface';
import { ZoomBadge } from './ZoomBadge';
import { DONE_CONTINUE } from '../../../lib/doneContinue';

/** An agent's tab whose turn is over: the page it ended on stays until the user closes it. */
export function AgentResultBar() {
  return (
    <div className="browser-agent-bar" role="status" data-state="result">
      <span className="browser-agent-access">Result</span>
      <span className="browser-agent-text">The agent finished on this page. It stays open until you close it.</span>
    </div>
  );
}

/**
 * "Agent is using this tab" while an agent drives it this turn: the site permission, Take over (the
 * agent's calls on this tab stop for the rest of the turn and its next result says so) and Stop
 * (stops the chat's turn). After a take-over: Done, continue (hands it back). After a hand-off (browser_request_signin, any
 * harness) the agent's turn has ended and the tab is the user's: "Done, continue" sends "Done on <site>" into the chat, which
 * starts its next turn, as on the hand-off strip above the composer; Stop ends the hand-off.
 */
export function AgentBar({ chatId, view }: { chatId: string; view: AgentTabView }) {
  const [busy, setBusy] = useState(false);
  const access = accessLabel(view.access);
  const run = async (fn: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      toast(failed, 'error');
    } finally {
      setBusy(false);
    }
  };
  const takeOver = (take: boolean) =>
    run(
      async () => {
        if (!(await native.browser.takeOver(chatId, view.tabKey, take))) throw new Error('gone');
      },
      take ? "Couldn't take over: the tab closed or the turn ended. Press Stop." : "Couldn't hand this tab back",
    );
  const stop = () => run(() => native.browser.stopAgent(chatId), "Couldn't stop the agent");
  const signedIn = () =>
    run(async () => {
      if (!(await native.browser.signinDone(chatId, view.tabId))) throw new Error('gone');
    }, 'Nothing is waiting on this tab any more');
  const signin = !!view.signin;
  const state = signin ? 'handoff' : view.takenOver ? 'takeover' : 'active';
  // a Host's whole desktop is not a tab
  const what = view.desktop ? 'desktop' : 'tab';
  return (
    <div className="browser-agent-bar" role="status" data-state={state}>
      <span className="browser-agent-icon">{state === 'active' ? <MousePointerClick size={14} /> : <Hand size={14} />}</span>
      <span className="browser-agent-text">
        {signin
          ? `${view.signin?.credential ? 'Sign in to' : 'Your turn on'} ${view.origin ? displayHost(view.origin) : 'this page'}`
          : view.takenOver
            ? `You took over this ${what} for this turn`
            : view.created
              ? 'Agent opened this tab and is using it'
              : `Agent is using this ${what}`}
      </span>
      {access &&
        (view.access === 'read' || view.access === 'denied' ? (
          // a site the agent can't act on: its permission is changed in Browser settings' sites
          <button
            type="button"
            className="browser-agent-access"
            data-access={view.access}
            title={`${access.detail} Change it in Browser settings.`}
            onClick={() => navigate({ name: 'settings', section: 'browser' })}
          >
            {access.label}
          </button>
        ) : (
          <span className="browser-agent-access" data-access={view.access} title={access.detail}>
            {access.label}
          </span>
        ))}
      <div className="browser-notice-actions">
        {signin ? (
          <button className="primary" disabled={busy} onClick={signedIn} title="The agent continues from the page as you leave it">
            {DONE_CONTINUE}
          </button>
        ) : view.takenOver ? (
          <button disabled={busy} onClick={() => takeOver(false)} title={`Hand the ${what} back to the agent`}>
            {DONE_CONTINUE}
          </button>
        ) : (
          <button disabled={busy} onClick={() => takeOver(true)} title={`Pause the agent on this ${what} for the rest of its turn`}>
            Take over
          </button>
        )}
        <button disabled={busy} onClick={stop}>
          Stop
        </button>
      </div>
    </div>
  );
}

/** Blank-tab start page: the official "Tools" grid. */
export function NewTabTools({ tabId, cwd, threadId }: { tabId: string; cwd: string; threadId: string | null }) {
  // Replace this blank tab with the chosen tool so tabs don't pile up.
  const swap = (fn: () => void) => {
    closePaneTab(tabId);
    fn();
  };
  const tools: { label: string; icon: React.ReactNode; kbd: string; run: () => void; disabled?: boolean }[] = [
    { label: 'Changes', icon: <FileDiff size={15} strokeWidth={1.6} />, kbd: '⌃⇧G', run: () => swap(() => openChanges()) },
    {
      label: 'Terminal',
      icon: <SquareTerminal size={15} strokeWidth={1.6} />,
      kbd: '⌃`',
      run: () => swap(() => openPaneTab('terminal', { cwd, title: terminalTitle(cwd) })),
    },
    { label: 'Files', icon: <FolderTree size={15} strokeWidth={1.6} />, kbd: '⌘P', run: () => swap(() => openPaneTab('files')) },
    {
      label: 'Side chat',
      icon: <MessageCirclePlus size={15} strokeWidth={1.6} />,
      kbd: '⌥⌘S',
      run: () => openSideChat(threadId!, undefined, tabId),
      disabled: !threadId,
    },
  ];
  return (
    <div className="newtab">
      <div className="newtab-title">Tools</div>
      <div className="newtab-grid">
        {tools.map((t) => (
          <button key={t.label} className="newtab-tool" onClick={t.run} disabled={t.disabled}>
            {t.icon}
            <span>{t.label}</span>
            <kbd>{shortcutLabel(t.kbd)}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Back, Forward and Reload/Stop in one pill, as the Codex app's toolbar has them. */
export function NavPill(p: {
  nav: { back: boolean; forward: boolean; loading: boolean };
  disabled: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}) {
  return (
    <div className="browser-navgroup">
      <button className="browser-btn" disabled={!p.nav.back} onClick={p.onBack} aria-label="Back">
        <ArrowLeft size={15} />
      </button>
      <span className="browser-navsep" />
      <button className="browser-btn" disabled={!p.nav.forward} onClick={p.onForward} aria-label="Forward">
        <ArrowRight size={15} />
      </button>
      <span className="browser-navsep" />
      <button className="browser-btn" disabled={p.disabled} onClick={p.onReload} aria-label={p.nav.loading ? 'Stop' : 'Reload'}>
        {p.nav.loading ? <X size={15} /> : <RotateCw size={15} />}
      </button>
    </div>
  );
}

/** The page's zoom when the user chose one for its site, and the device an agent emulates in the tab. */
export function ViewBadges({ device, page }: { device: AgentTabView['device'] | undefined; page: RefObject<WebviewElement | null> }) {
  return (
    <>
      <ZoomBadge page={page.current} />
      <DeviceBadge device={device} />
    </>
  );
}

/** The device the agent emulates in this tab (browser_resize_window); nothing when it emulates none. */
function DeviceBadge({ device }: { device: AgentTabView['device'] | undefined }) {
  if (!device) return null;
  const what = device.preset ? `a ${device.preset} device` : 'a viewport size';
  return (
    <span className="browser-device" role="status" title={`The agent is emulating ${what} in this tab (${device.width}×${device.height})`}>
      {device.label}
    </span>
  );
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.localhost$/i;

/**
 * The address bar unless "Show full URL" is on (Settings → Browser), as the Codex app shows it: a site's host without
 * "www.", and a local server's host with its path and query, since the path is what tells its pages apart.
 */
export function displayHost(url: string) {
  try {
    const u = new URL(url);
    if (LOCAL_HOST.test(u.hostname)) return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return u.host.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
