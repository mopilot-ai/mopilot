// Window shortcut dispatch, native commands and focus ownership for chat and workspace actions.
import { selectLocalProject } from '../store/localProjectDraft';
import { agentTabRequest } from '../lib/agentTabRequest';
import { moveToBackground } from '../store/agentWiring';
import { useEffect, useRef } from 'react';
import { SHORTCUT_ACTIONS, resolveShortcut, effectiveBindings } from '../../shared/shortcuts.mjs';
import { nativeShortcutAccelerator } from '../../shared/shortcutKeys.mjs';
import { zoomStep } from '../../shared/zoom.mjs';
import { comboFromEvent } from '../lib/format';
import { terminalTitle, platform } from '../lib/platform';
import { native } from '../lib/native';
import { copyText } from './clipboard';
import { lastCodeBlock } from '../lib/lastCodeBlock';
import { threadHash } from '../lib/deepLink';
import { logoutRoute } from './harness/select';
import { openBugReport } from '../lib/bugReportEvent';
import {
  navigate,
  goBack,
  goForward,
  leaveSettings,
  togglePaneTab,
  openPaneTab,
  openAgentBrowserTab,
  openBrowserViewTab,
  closeAgentBrowserTab,
  selectAgentBrowserTab,
  closePaneTab,
  openChanges,
} from '../store/panes';
import { cycleSplitFocus, closeFocusedSplit } from '../store/splitView';
import { togglePanel } from '../store/shellPanels';
import { set as setState, get as getState, toast } from '../store/core';
import { createProject, currentCwdForNewChat, newChatHostPick, projectForThread } from '../store/projects';
import { resetNewChatDefaults, clearNewChatProject, temporaryChatBlocked, chatOf } from '../store/chats';
import { applyNewChatDefault } from './newChatStart';
import { archiveThread, openSideChat } from '../store/actions';
import { giveBackToComposer } from '../store/send';
import { viewChats, inView } from '../lib/agentTabs';
import { resolveEnvironment } from '../lib/environments';
import { shellScript } from '../lib/platform';
import { toastFailure } from '../store/core';
import {
  dispatchComposerCommand,
  leavesSettings,
  shortcutsBlocked as shortcutBlocked,
  shortcutScope,
  textOwnsShortcut,
} from '../lib/shortcutFocus';
import { numberedSidebarChat } from '../lib/sidebarShortcutTargets';
import { setDocked } from '../lib/docked';
import { momoAllowedNow } from '../lib/momo';
import { momoRouteOf } from '../lib/momoRoute';
import { focusedChat, focusedThread, sameView, viewToken } from '../store/split';
import { isEnabled } from '../lib/flags';
import { openNewChatLink } from './newChatLink';

/** The window's zoom one step in (1), out (-1) or back to actual size (0); main applies it (electron/app/zoom.cjs). */
const zoomWindow = (direction: number) => setState((s) => ({ prefs: { ...s.prefs, zoomLevel: zoomStep(s.prefs.zoomLevel, direction) } }));

/** Whether the front pane tab's page zooms on its own: a main-owned view, as BrowserPanel decides. */
function activePageZooms() {
  const s = getState();
  return !!s.paneTabs.find((t) => t.id === s.paneActive)?.browserView || isEnabled('shared.browser.viewTabs');
}
export function useShortcuts(groups: { threads: { id: string }[] }[]) {
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => {
    let disposed = false;
    const focusComposer = () => {
      const view = viewToken(getState());
      return setTimeout(() => {
        if (!disposed && sameView(viewToken(getState()), view)) window.dispatchEvent(new Event('focus-composer'));
      }, 50);
    };
    const flatIds = () => [...new Set(groupsRef.current.flatMap((g) => g.threads.map((t) => t.id)))];
    const step = (dir: 1 | -1) => {
      const s = getState();
      const ids = flatIds();
      if (!ids.length) return;
      const focused = focusedChat(s);
      const cur = focused ? ids.indexOf(focused) : -1;
      const next = ids[(cur + dir + ids.length) % ids.length];
      navigate({ name: 'thread', id: next });
    };
    const openFolder = async () => {
      const view = viewToken(getState());
      const p = await native.dialog.openFolder();
      if (disposed || !sameView(viewToken(getState()), view)) return;
      if (p) {
        const id = await createProject(p);
        if (disposed || !sameView(viewToken(getState()), view)) return;
        if (id) selectLocalProject(id);
        navigate({ name: 'home', cwd: p });
      }
    };
    const openNewChat = (temporary: boolean, reuseRunOn: boolean) => {
      if (!temporary) clearNewChatProject(reuseRunOn);
      else if (newChatHostPick()?.remembered) clearNewChatProject();
      setState({ newChatTemporary: temporary });
      navigate({ name: 'home' });
      focusComposer();
    };
    const targetChat = (target: Element | null = document.activeElement) => {
      const composer = target?.closest<HTMLElement>('[data-composer-chat]');
      const s = getState();
      return composer ? composer.dataset.composerChat || null : focusedChat(s);
    };
    const commandOwner = (tid: string | null) => {
      const view = viewToken(getState());
      const composer = document.activeElement?.closest<HTMLElement>('[data-composer-chat]');
      return () =>
        !disposed &&
        sameView(viewToken(getState()), view) &&
        (!composer || (composer.isConnected && composer.dataset.composerChat === (tid ?? '')));
    };
    const visibleTabs = () => {
      const s = getState();
      return s.paneTabs.filter((t) => inView(t, viewChats(focusedChat(s), s.paneTabs), chatOf));
    };
    let browserFocus = false;
    const runAction = (id: string, tid: string | null): unknown => {
      switch (id) {
        case 'archive':
          return tid && archiveThread(tid);
        case 'move-to-background':
          return tid && moveToBackground(tid);
        case 'side-chat':
          return tid && openSideChat(tid);
        case 'mark-unread':
          return tid && setState((s) => ({ unread: { ...s.unread, [tid]: true } }));
        case 'new-window':
          return tid && native.win.open(threadHash(tid));
        case 'new-standalone':
          selectLocalProject('none');
          navigate({ name: 'home' });
          return focusComposer();
        case 'copy-code': {
          const view = [...document.querySelectorAll<HTMLElement>('.thread-view')].find((v) => v.dataset.threadId === tid);
          // a long thread renders only the turns near the viewport: the others' code comes from their replies
          const code = view ? lastCodeBlock(view, () => (tid && getState().runtime[tid]?.turns) || []) : null;
          if (code !== null) copyText(code, 'Copied code block');
          return;
        }
        case 'find-in-chat': {
          // a file's code with focus in the side pane finds in the file (src/components/panels/files/FilePreview.tsx)
          const file = document.activeElement?.closest('.file-view');
          if (file?.querySelector('.file-editor')) return file.dispatchEvent(new CustomEvent('find-in-file'));
          // the chat's view opens find (ThreadView); its key never comes from a browser page or terminal (appFocus)
          return tid && window.dispatchEvent(new CustomEvent('find-in-chat', { detail: { threadId: tid } }));
        }
        case 'quick-chat':
          return native.win.mini();
        case 'command-menu':
          return setState({ searchOpen: true, searchMode: 'all' });
        case 'pin':
          return tid && setState((s) => ({ pinned: { ...s.pinned, [tid]: !s.pinned[tid] } }));
        case 'rename':
          return tid && window.dispatchEvent(new CustomEvent('rename-chat', { detail: { threadId: tid } }));
        case 'model-picker':
        case 'project-picker':
          return dispatchComposerCommand(id === 'model-picker' ? 'open-model-picker' : 'open-project-menu');
        case 'environment-action': {
          const s = getState();
          const t = tid ? s.threads[tid] : null;
          if (!t) return;
          const rootOf = () => projectForThread(t, getState().savedProjects)?.roots[0]?.path ?? t.cwd;
          const root = rootOf();
          const ownerCurrent = commandOwner(tid);
          const current = () => ownerCurrent() && getState().threads[tid!] === t && rootOf() === root;
          return resolveEnvironment(root)
            .then((env) => {
              if (!current()) return;
              const action = env.actions.find((a) => a.command);
              if (action) openPaneTab('terminal', { cwd: t.cwd, title: action.name, command: shellScript(action.command) });
            })
            .catch((error) => {
              if (current()) toastFailure('Could not run the environment action')(error);
            });
        }
        // the whole window zooms, every app window with it
        case 'font-increase':
        case 'font-decrease':
        case 'font-reset':
          return zoomWindow(id === 'font-reset' ? 0 : id === 'font-increase' ? 1 : -1);
        // a <webview> page (view tabs off) has no zoom of its own: the window zooms, as before
        case 'browser-zoom-in':
        case 'browser-zoom-out':
        case 'browser-zoom-reset':
          if (!activePageZooms()) return zoomWindow(id === 'browser-zoom-reset' ? 0 : id === 'browser-zoom-in' ? 1 : -1);
          return window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { id, paneId: getState().paneActive } }));
        case 'full-view':
          return getState().diffPanel.open && setState((s) => ({ paneFull: !s.paneFull }));
        case 'cycle-layout': {
          const s = getState();
          return s.diffPanel.open
            ? s.paneFull
              ? setState({ diffPanel: { ...s.diffPanel, open: false }, paneFull: false })
              : setState({ paneFull: true })
            : s.paneTabs.length && setState({ diffPanel: { ...s.diffPanel, open: true }, paneFull: false });
        }
        case 'toggle-workspace': {
          const s = getState();
          return setState({ diffPanel: { ...s.diffPanel, open: !s.diffPanel.open } });
        }
        case 'close-tab':
        case 'close-other-tabs': {
          const tabs = visibleTabs();
          const s = getState();
          const inWorkspace = s.diffPanel.open && (browserFocus || s.paneFull || !!document.activeElement?.closest('.side-pane, .tb-tabs'));
          const active = tabs.find((t) => t.id === s.paneActive) ?? tabs[0];
          if (inWorkspace && active) {
            for (const tab of tabs) if (id === 'close-tab' ? tab.id === active.id : tab.id !== active.id) closePaneTab(tab.id);
          } else if (id === 'close-tab') window.close();
          return;
        }
        case 'next-pane':
        case 'prev-pane':
          return cycleSplitFocus(id === 'next-pane' ? 1 : -1);
        case 'close-split':
          return closeFocusedSplit();
        case 'prev-chat':
        case 'next-chat': {
          const s = getState();
          const tabs = visibleTabs();
          if (s.diffPanel.open && tabs.length && (browserFocus || s.paneFull || document.activeElement?.closest('.side-pane, .tb-tabs'))) {
            const i = tabs.findIndex((t) => t.id === s.paneActive);
            return setState({ paneActive: tabs[(i + (id === 'next-chat' ? 1 : -1) + tabs.length) % tabs.length].id });
          }
          return step(id === 'next-chat' ? 1 : -1);
        }
        case 'clear-terminal':
        case 'browser-address':
        case 'browser-back':
        case 'browser-forward':
        case 'browser-reload':
        case 'browser-reload-cache':
        case 'browser-copy-url':
        case 'browser-annotate':
        case 'browser-find':
        case 'browser-find-next':
        case 'browser-find-previous':
          return window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { id, paneId: getState().paneActive } }));
        case 'temporary-chat':
          return handle('new-temp-chat');
        default:
          if (/^(chat|recent)-[1-9]$/.test(id)) {
            const chat = numberedSidebarChat(id, () =>
              id.startsWith('recent-') ? groupsRef.current.at(-1)!.threads.map((t) => t.id) : flatIds(),
            );
            return chat && navigate({ name: 'thread', id: chat });
          }
          return handle(id, undefined, true);
      }
    };
    const execute = async (id: string, tid: string | null) => {
      const current = commandOwner(tid);
      try {
        return await runAction(id, tid);
      } catch (error) {
        if (current()) toastFailure('Could not run the shortcut')(error);
      }
    };
    const handle = (cmd: string, arg?: unknown, fromShortcut = false): unknown => {
      const s = getState();
      switch (cmd) {
        case 'shortcut': {
          const d = typeof arg === 'string' ? { id: arg } : (arg as { id?: string; combo?: string } | null);
          if (!d || typeof d.id !== 'string') return;
          if (shortcutBlocked()) return;
          const scope = shortcutScope(document.activeElement);
          const action = d.combo
            ? resolveShortcut(d.combo, s.prefs.keybindings, scope, platform)
            : SHORTCUT_ACTIONS.find((a) => a.id === d.id);
          return action && execute(action.id, targetChat());
        }
        case 'settings':
          // ⌘, again (no section asked for) closes Settings, as the menu's open toggles it
          if (typeof arg !== 'string' && s.route.name === 'settings') return leaveSettings();
          return navigate({ name: 'settings', section: typeof arg === 'string' ? arg : undefined });
        // Chrome's side panel opening the app's Scheduled page (electron/app/chromePanel.cjs)
        case 'scheduled':
          return navigate({ name: 'scheduled' });
        // a new chat with a task drafted for the user to send (the Chrome extension's Try it, app/chromeAskNotice.cjs)
        // the new chat's box once it is on screen, else its saved draft, after anything already there, never over it
        case 'new-chat-draft':
          openNewChat(false, false);
          if (typeof arg === 'string') setTimeout(() => giveBackToComposer(null, arg));
          return;
        // a mopilot:// link (the macOS Quick Actions): a new chat in a folder and/or with text drafted, never sent
        case 'new-chat-link': {
          const view = viewToken(s);
          setState({ newChatTemporary: false });
          return openNewChatLink(arg, {
            createProject,
            clearProject: clearNewChatProject,
            setProject: selectLocalProject,
            home: (cwd) => {
              navigate({ name: 'home', ...(cwd ? { cwd } : {}) });
              focusComposer();
            },
            draft: (text) => setTimeout(() => giveBackToComposer(null, text)),
            stale: () => disposed || !sameView(viewToken(getState()), view),
          }).catch(toastFailure('Could not open the link'));
        }
        case 'new-chat-default':
          resetNewChatDefaults();
          applyNewChatDefault();
          return handle('new-chat');
        case 'new-chat':
        case 'new-temp-chat': {
          // ⇧⌘N on a basic harness runs on another harness (store/chats.ts): refused, with why, when that can't run here
          const blocked = cmd === 'new-temp-chat' ? temporaryChatBlocked(s) : null;
          if (blocked) return toast(blocked, 'error');
          return openNewChat(cmd === 'new-temp-chat', true);
        }
        case 'open-folder':
          return openFolder();
        case 'toggle-sidebar':
          return togglePanel('sidebar');
        case 'open-terminal':
          if (s.prefs.defaultTerminal === 'right' && s.diffPanel.open && s.paneTabs.find((t) => t.id === s.paneActive)?.kind === 'terminal')
            return setState({ diffPanel: { ...s.diffPanel, open: false } });
          if (s.prefs.defaultTerminal !== 'right' && s.bottomPanelOpen) return setState({ bottomPanelOpen: false });
          if (s.prefs.defaultTerminal === 'right') {
            const existing = visibleTabs().findLast((t) => t.kind === 'terminal');
            if (existing) return setState({ paneActive: existing.id, diffPanel: { ...s.diffPanel, open: true } });
            const cwd = focusedThread(s)?.cwd ?? currentCwdForNewChat();
            return openPaneTab('terminal', { cwd, title: terminalTitle(cwd) });
          }
        // falls through
        case 'toggle-bottom-panel':
          return setState({ bottomPanelOpen: cmd === 'open-terminal' ? true : !s.bottomPanelOpen });
        case 'toggle-summary':
          return togglePanel('summary');
        case 'search':
          return setState({ searchOpen: true, searchMode: 'all' });
        case 'search-files':
          return setState({ searchOpen: true, searchMode: 'files' });
        case 'toggle-activity':
          return setState({ activityView: !s.activityView });
        case 'prev-chat':
        case 'next-chat':
          return runAction(cmd, targetChat());
        case 'back':
          return goBack();
        case 'forward':
          return goForward();
        case 'shortcuts':
          return navigate({ name: 'settings', section: 'shortcuts' });
        case 'logout':
          // never removes the account in use: the page opens on the chat's account and the user signs out there
          return navigate(logoutRoute(focusedChat(s), s));
        case 'toggle-changes':
          return togglePaneTab('changes');
        case 'open-changes':
          return openChanges();
        case 'toggle-files':
          return togglePaneTab('files');
        case 'open-chat':
          return typeof arg === 'string' && s.threads[arg] ? navigate({ name: 'thread', id: arg }) : undefined;
        case 'momo':
          // an account MoMo is not allowed for (or not yet known) gets nothing: the command is a no-op
          return momoAllowedNow() ? navigate(momoRouteOf(arg)) : undefined;
        case 'docked':
          return setDocked(arg === true);
        case 'open-browser-tab':
          return openPaneTab('browser', typeof arg === 'string' ? { url: arg, title: arg } : {});
        case 'open-agent-browser-tab': {
          if (typeof arg === 'string') return openAgentBrowserTab(arg);
          const req = agentTabRequest(arg);
          if (!req) return undefined;
          return openAgentBrowserTab(req.chatId, {
            tabKey: req.tabKey,
            focus: req.focus,
            ...('after' in req ? { after: req.after } : {}),
            ...(req.auto ? { auto: true } : {}),
          });
        }
        case 'open-browser-view':
          return openBrowserViewTab(arg);
        case 'close-agent-browser-tab': {
          const req = agentTabRequest(arg);
          return req ? closeAgentBrowserTab(req.chatId, req.tabKey) : undefined;
        }
        case 'select-agent-browser-tab': {
          const req = agentTabRequest(arg);
          return req ? selectAgentBrowserTab(req.chatId, req.tabKey, req.auto === true) : undefined;
        }
        case 'new-standalone':
          return runAction('new-standalone', null);
        case 'copy-cwd': {
          const cwd = focusedThread(s)?.cwd ?? currentCwdForNewChat();
          return copyText(cwd, 'Copied working directory');
        }
        case 'clear-unreads':
          return setState({ unread: {} });
        case 'next-attention': {
          const id = flatIds().find((x) => s.unread[x] || s.pending.some((p) => p.threadId === x));
          return id && navigate({ name: 'thread', id });
        }
        case 'start-voice':
          return dispatchComposerCommand('start-voice');
        case 'about':
          return navigate({ name: 'settings', section: 'about' });
        case 'report-bug':
          return openBugReport(focusedChat(s));
        default:
          if (fromShortcut) throw new Error(`Unknown shortcut action: ${cmd}`);
      }
    };
    const off = native.app.onCommand(handle);
    const workspace = (e: Event) => {
      const d = (e as CustomEvent<{ combo: string; paneId: string }>).detail;
      const s = getState();
      if (!d || d.paneId !== s.paneActive || !s.diffPanel.open || shortcutBlocked()) return;
      const action = resolveShortcut(d.combo, s.prefs.keybindings, 'browser', platform);
      browserFocus = true;
      try {
        if (action) void execute(action.id, targetChat());
      } finally {
        browserFocus = false;
      }
    };
    window.addEventListener('browser-shortcut', workspace);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const st = getState();
      const target = e.target instanceof Element ? e.target : null;
      if (shortcutBlocked()) return;
      if (document.querySelector('.approval-card') && !e.metaKey && !e.ctrlKey && !e.altKey && /^(Enter|Escape|[1-9])$/.test(e.key)) return;
      if (e.key === 'Escape' && st.diffPanel.open) {
        e.preventDefault();
        setState({ diffPanel: { ...st.diffPanel, open: false } });
        return;
      }
      if (leavesSettings(e, st.route, target)) {
        e.preventDefault();
        leaveSettings();
        return;
      }
      const combo = comboFromEvent(e);
      if (textOwnsShortcut(combo, target)) return;
      const scope = shortcutScope(target);
      const action = combo && resolveShortcut(combo, st.prefs.keybindings, scope, platform);
      if (!action) return;
      // Native menu accelerators consume these keys. Custom bindings use the same single path.
      if (
        action.menu &&
        effectiveBindings(action, st.prefs.keybindings, platform).some((k) => k === combo && nativeShortcutAccelerator(k, platform))
      )
        return;
      e.preventDefault();
      if (!e.repeat || action.repeat) void execute(action.id, targetChat(target));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      off();
      window.removeEventListener('browser-shortcut', workspace);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
