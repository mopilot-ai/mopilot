// The main window's shell: the route's page, sidebar, panes and panels, the welcome flow, and main's menu and browser tab requests.

import { sidebarWidth as validSidebarWidth } from './lib/sidebarWidth';
import { besideWidth } from './lib/paneLayout';
import { useViewportWidth } from './lib/useViewportWidth';
import { SidebarResize } from './components/sidebar/SidebarResize';
import { RunningTaskPollers } from './components/tasks/RunningTaskPollers';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useEffectOn } from './lib/effects';
import { useShownThread } from './lib/shownThread';
import { startLimitWatch } from './session/harness/billing';
import { useStore, setPrefs } from './store/core';
import { showPanel, useShellFit } from './store/shellPanels';
import { panelShown } from './lib/shellFit';
import { useTerminalMachine } from './session/useTerminalMachine';
import { useLocalFolder } from './lib/chatMachine';
import { useReloadHostChatsOn } from './lib/hostChatsSync';
import { currentCwdForNewChat } from './store/projects';
import { codexUsable, claudeUsable, anyHarnessUsable, harnessesChecking } from './store/chats';
import { ShortcutRename } from './components/dialogs/ShortcutRename';
import { TitleBar } from './components/titleBar/TitleBar';
import { Sidebar } from './components/sidebar/Sidebar';
import { PageNavColumn } from './components/sidebar/PageNavColumn';
import { Home } from './components/pages/Home';
import { ThreadView } from './components/thread/ThreadView';
import { SplitFrame } from './components/split/SplitFrame';
import { SPLIT_PANE_MIN_WIDTH } from './session/splitWeights';
import { SummarySlot } from './components/panels/SummarySlot';
import { usePresence } from './components/ui/Presence';
import { SidePaneSlot } from './components/panels/SidePaneSlot';
import { useShortcuts } from './session/appShortcuts';
import { MomoRoute } from './components/momo/MomoRoute';
import { MomoNav } from './components/momo/MomoNav';
import { useMomoAllowed } from './lib/momo';
import { useMomoPrefs } from './session/momoPrefs';
import { momoRailOn } from './lib/momoRoute';
import { appearanceVars } from './lib/appearance';
import { syncTitleBarOverlay } from './lib/titleBarOverlay';
import { Dialogs } from './components/dialogs/Dialogs';
import { Toasts } from './components/ui/Toasts';
import { CodexNotice } from './components/pages/Login';
import { useWelcome, openWelcome } from './components/pages/welcomeState';
import { launchGate, welcomeDue } from './lib/welcome';
import { AccountSignInDialog, AccountExpiredBanner } from './components/accounts/Accounts';
import { ConnectPhoneDialog } from './components/pages/settings/ConnectPhone';
import { AddMachineDialog } from './components/pages/settings/AddMachineDialog';
import { useResolvedDark } from './components/markdown/Markdown';
import { ColdStart, useColdStartCapped } from './components/pages/WelcomeColdStart';
import { useProjectGroups } from './components/sidebar/Sidebar';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { useDocked } from './lib/docked';
import { useUpdatePrefsSync } from './session/updates';
import { focusedChat, primaryChat, visibleChats } from './store/split';
import { lazyPage } from './lib/lazyPage';
import { SearchPalette } from './components/search/SearchPalette';
import { BrowserImportDialog } from './components/dialogs/BrowserImportDialog';

// Pages and panels load on first use, not with the window (their chunks, xterm and the settings tree among them, stay out of startup)
const SummaryPanel = lazyPage(
  'the summary',
  () => import('./components/panels/SummaryPanel'),
  (m) => m.SummaryPanel,
);
const TerminalPanel = lazyPage(
  'the terminal',
  () => import('./components/panels/TerminalPanel'),
  (m) => m.TerminalPanel,
);
const Settings = lazyPage(
  'Settings',
  () => import('./components/pages/Settings'),
  (m) => m.Settings,
);
const SettingsNav = lazyPage(
  'Settings',
  () => import('./components/pages/Settings'),
  (m) => m.Settings.Nav,
);
const Plugins = lazyPage(
  'Plugins',
  () => import('./components/harness/codex/Plugins'),
  (m) => m.Plugins,
);
const PluginsNav = lazyPage(
  'Plugins',
  () => import('./components/harness/codex/Plugins'),
  (m) => m.PluginsNav,
);
const Scheduled = lazyPage(
  'Scheduled',
  () => import('./components/pages/Scheduled'),
  (m) => m.Scheduled,
);
const ScheduledNav = lazyPage(
  'Scheduled',
  () => import('./components/pages/Scheduled'),
  (m) => m.ScheduledNav,
);
const Review = lazyPage(
  'Review',
  () => import('./components/pages/Review'),
  (m) => m.Review,
);
const ReviewNav = lazyPage(
  'Review',
  () => import('./components/pages/Review'),
  (m) => m.ReviewNav,
);
const Projects = lazyPage(
  'Projects',
  () => import('./components/pages/Projects'),
  (m) => m.Projects,
);
const CloudTask = lazyPage(
  'cloud tasks',
  () => import('./components/pages/CloudTask'),
  (m) => m.CloudTask,
);
const Welcome = lazyPage(
  'the welcome flow',
  () => import('./components/pages/Welcome'),
  (m) => m.Welcome,
);

export function App() {
  const route = useStore((s) => s.route);
  // on screen, not just chosen: a window too narrow for them (zoom included) hides the summary, then the sidebar
  const sidebarOpen = useStore((s) => panelShown(s, 'sidebar'));
  const summaryOpen = useStore((s) => panelShown(s, 'summary'));
  const diffOpen = useStore((s) => s.diffPanel.open);
  const bottomOpen = useStore((s) => s.bottomPanelOpen);
  const focused = useStore((s) => s.focused);
  // The app opens once any harness can run a chat; a missing or signed-out one only shows as such
  // in the picker and on its own pages.
  const codexOk = useStore((s) => codexUsable(s));
  const anyUsable = useStore((s) => anyHarnessUsable(s));
  const checking = useStore((s) => harnessesChecking(s));
  // Once open, a re-check in progress keeps the app open rather than flashing the spinner.
  const opened = useRef(false);
  const showApp = anyUsable || (checking && opened.current);
  if (showApp) opened.current = true;
  // the welcome flow stays up until its last step, even once the harness it set up works
  const welcoming = useWelcome((s) => s.open);
  const dismissed = useWelcome((s) => !!s.dismissed);
  // a new install sees it once even when only a basic harness works, so Codex and Claude Code are offered (#2034)
  const firstClassOk = useStore((s) => codexUsable(s) || claudeUsable(s));
  // read from the saved prefs only once they are loaded (boot sets home with them)
  const welcomeDone = useStore((s) => s.prefs.welcomeDone || !s.home);
  useEffect(() => {
    if (welcomeDue({ checking, anyUsable: showApp, firstClassUsable: firstClassOk, welcomeDone, dismissed })) openWelcome();
  }, [showApp, checking, firstClassOk, welcomeDone, dismissed]);
  // a detection that takes long shows the welcome list, its rows still checking, rather than a spinner alone
  const capped = useColdStartCapped(checking && !showApp);
  const gate = launchGate({ welcoming, showApp, checking, capped });
  const codexPage = route.name === 'cloud';
  const fontSize = useStore((s) => s.prefs.fontSize);
  const prefs = useStore((s) => s.prefs);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const paneFull = useStore((s) => s.paneFull);
  // A side pane beside the chat (not covering it), or the summary island, shares the lane with the chat, so the
  // sidebar leaves room for the chat's minimum and theirs.
  // each split view pane shares the lane too, at its minimum width
  const splitCount = useStore((s) => (s.route.name === 'settings' ? 0 : visibleChats(s).length - (primaryChat(s) ? 1 : 0)));
  const beside = besideWidth(route.name, diffOpen, paneFull, summaryOpen) + splitCount * SPLIT_PANE_MIN_WIDTH;
  const viewport = useViewportWidth();
  const [sidebarWidth, setSidebarWidth] = useState(() => validSidebarWidth(prefs.sidebarWidth, viewport, beside));
  // A drag can reach zero without replacing the width used when reopening the sidebar. The saved width is
  // clamped to this window on load and on every resize, without rewriting the saved preference.
  useLayoutEffect(() => {
    if (sidebarOpen && !sidebarDragging) setSidebarWidth(validSidebarWidth(prefs.sidebarWidth, viewport, beside));
  }, [prefs.sidebarWidth, sidebarOpen, sidebarDragging, viewport, beside]);
  const dark = useResolvedDark();
  // a switch to another chat paints at once; the new chat's view renders behind it (src/lib/shownThread.ts)
  const shown = useShownThread(route.name === 'thread' ? route.id : null);
  // the open chat's folder alone: another field of it, or another chat, changing leaves the app's root as it is
  // the focused pane's chat: the terminal and the side pane work in its folder
  const focusedId = useStore(focusedChat);
  const chatCwd = useStore((s) => (focusedId ? s.threads[focusedId]?.cwd : undefined));
  // a chat on a machine has no folder here: the terminal, tasks and browser start where this Mac does, and the side pane's git and files say so
  const { cwd: activeCwd, machine: activeMachine, pending: locating } = useLocalFolder(focusedId, chatCwd ?? currentCwdForNewChat());
  // the terminal's machine: the chat's, else the new-chat screen's pick while no chat is open
  const terminalMachine = useTerminalMachine(focusedId, activeMachine, chatCwd);
  // which chats run on machines is read again when the chat list changes
  useReloadHostChatsOn(useStore((s) => s.threadOrder.length));
  // The rail and the panes it opens belong to the same focus, even while the old transcript is still painted.
  const summaryChat = route.name === 'settings' ? null : focusedId;
  useShellFit(viewport, splitCount * SPLIT_PANE_MIN_WIDTH, summaryChat);
  // here, at the app's root: a change in Settings must apply at once, whatever page is open (D-77)
  useUpdatePrefsSync();

  // Portaled popovers live outside .app, so the theme and its variables go on <html>.
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    const vars = appearanceVars(prefs, fontSize, dark);
    const st = document.documentElement.style;
    for (const k of Array.from({ length: st.length }, (_, i) => st.item(i))) if (k.startsWith('--')) st.removeProperty(k);
    for (const [k, val] of Object.entries(vars)) st.setProperty(k, val);
  }, [prefs, fontSize, dark]);
  // the caption buttons take the colors the appearance and the window's focus give the .app (after the effect above)
  useEffectOn([prefs, fontSize, dark, focused], () => {
    syncTitleBarOverlay(dark);
  });
  useEffect(() => startLimitWatch(), []);
  const isSettings = route.name === 'settings';
  // MoMo's shell has its own rail, which is the page's one navigation column: neither the app's sidebar nor MoMo's nav beside it
  const momoPrefs = useMomoPrefs();
  const momoAllowed = useMomoAllowed();
  const momoRail = momoRailOn(route, momoPrefs);
  const pageNav =
    route.name === 'scheduled' ? (
      <ScheduledNav />
    ) : route.name === 'plugins' ? (
      <PluginsNav tab={route.tab} plugin={route.plugin} />
    ) : route.name === 'review' ? (
      <ReviewNav />
    ) : route.name === 'momo' && momoAllowed && !momoRail ? (
      <MomoNav tab={route.tab} chatId={route.chatId} />
    ) : null;
  // docked as the computer-use panel: the chat alone (no sidebar, side panes or terminal), as Claude Desktop's panel
  const docked = useDocked();
  const showSidebar = (sidebarOpen || sidebarDragging) && !isSettings && !pageNav && !momoRail && !docked;
  const sidebar = usePresence(showSidebar, 200);

  return (
    <div className={`app ${focused ? 'focused' : 'blurred'}`} style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}>
      <TitleBar />
      <div className="frame-card">
        {sidebar.mounted && <Sidebar leaving={sidebar.leaving} width={sidebarWidth} />}
        {!isSettings && !pageNav && !momoRail && !docked && (
          <SidebarResize
            open={sidebarOpen}
            width={sidebarWidth}
            dragging={sidebarDragging}
            onWidthChange={setSidebarWidth}
            onDraggingChange={setSidebarDragging}
            beside={beside}
            onOpenChange={(open) => showPanel('sidebar', open)}
            onSaveWidth={(sidebarWidth) => setPrefs({ sidebarWidth })}
          />
        )}
        {isSettings && <SettingsNav />}
        {sidebarOpen && pageNav && <PageNavColumn>{pageNav}</PageNavColumn>}
        <main className="main">
          <div className="main-row">
            <div className="main-content" hidden={paneFull && diffOpen && (route.name === 'thread' || route.name === 'home')}>
              {/* split view beside the route's page; Settings and the docked panel show the page alone */}
              {/* the chat being left, while the next one renders: nothing typed or clicked goes to it */}
              <SplitFrame primaryInert={shown.stale} splits={!isSettings && !docked}>
                {gate === 'checking' && route.name !== 'settings' && <ColdStart />}
                {gate === 'app' && route.name !== 'settings' && <AccountExpiredBanner />}
                {gate === 'welcome' && route.name !== 'settings' && <Welcome />}
                {gate === 'app' && (
                  <>
                    {route.name === 'home' && <Home />}
                    {shown.id !== null && (
                      <ErrorBoundary key={shown.id} label="this chat">
                        <ThreadView threadId={shown.id} />
                      </ErrorBoundary>
                    )}
                    {codexPage && !codexOk && <CodexNotice what="Codex Cloud tasks run on OpenAI's servers." />}
                    {route.name === 'plugins' && <Plugins tab={route.tab} plugin={route.plugin} codexOk={codexOk} />}
                    {route.name === 'scheduled' && <Scheduled />}
                    {route.name === 'review' && <Review />}
                    {route.name === 'projects' && <Projects />}
                    {route.name === 'cloud' && codexOk && <CloudTask id={route.id} />}
                    <MomoRoute route={route} />
                  </>
                )}
                {route.name === 'settings' && <Settings section={route.section} />}
              </SplitFrame>
            </div>
            {!docked && (
              <>
                {/* a chat's lane: the routed chat's, or a focused split view pane's beside any page */}
                <SummarySlot routeName={summaryChat !== null ? 'thread' : route.name} summaryOpen={summaryOpen} diffOpen={diffOpen}>
                  {summaryChat !== null && <SummaryPanel threadId={summaryChat} />}
                </SummarySlot>
                <SidePaneSlot cwd={activeCwd} threadId={focusedId} />
              </>
            )}
          </div>
          {/* its first shell starts in the folder, so it waits until the chat's machine is known */}
          {bottomOpen && !docked && !locating && <TerminalPanel cwd={activeCwd} machine={terminalMachine} />}
        </main>
      </div>
      <AppShortcuts />
      <RunningTaskPollers />
      <SearchPalette />
      <Dialogs />
      <ShortcutRename />
      <AccountSignInDialog />
      <ConnectPhoneDialog />
      <AddMachineDialog />
      <BrowserImportDialog />
      <Toasts />
    </div>
  );
}

/** The app's shortcuts, which step through the sidebar's chats: a leaf, so any chat's metadata re-renders only it. */
function AppShortcuts() {
  const { groups, recents } = useProjectGroups(true);
  useShortcuts([...groups, { threads: recents }]);
  return null;
}
