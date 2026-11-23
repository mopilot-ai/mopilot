// The window title bar: navigation, the chat's title and menu (export, pin, project actions) and the panel toggles.
import { movedOnMachine, useChatMachine, useFolderHere } from '../../lib/chatMachine';
import { onMachineHint } from '../../lib/machineFolder';
import { PaneTabMenu, PaneTabRename, browserTabTitle } from './PaneTabMenu';
import { toolLayoutScope } from '../../lib/toolPaneLayout';
import { useShortcutHint } from '../../session/shortcutHints';

import { shellScript } from '../../lib/platform';
import { useStore, set as setState, threadTitle, toast, toastFailure } from '../../store/core';
import { chatOf, nativeOf } from '../../store/chats';
import { navigate, goBack, goForward, openChanges, openPaneTab, closePaneTab, showPaneTab } from '../../store/panes';
import { archiveThread, forkThread, openSideChat } from '../../store/actions';
import { projectForThread } from '../../store/projects';
import { resolveEnvironment, type EnvAction } from '../../lib/environments';
import { native } from '../../lib/native';
import { copyText } from '../../session/clipboard';
import { showInFinder } from '../../session/open';
import { OpenInItems } from './OpenInApps';
import { ChatUtilityItems } from './ChatUtilityItems';
import { ignoring } from '../../lib/ignored';
import { threadHash } from '../../lib/deepLink';
import { Tooltip, Menu, MenuItem, MenuSeparator, SubMenu, useAnchor } from '../ui/Popover';
import { labelAt, transcriptMarkdown } from '../../session/transcript';
import { cliSessionId } from '../../harness/types';
import { resumeCommandFor } from '../../harness/registry';
import {
  Pin,
  MessageCirclePlus,
  Clock,
  Share,
  SquareStack,
  ArrowUpRight,
  X,
  Plus,
  PanelRight,
  ArrowLeft,
  ArrowRight,
  PanelLeft,
  Folder,
  Ellipsis,
  SquarePlus,
  PanelBottom,
  GitFork,
  Archive,
  Copy,
  Minimize2,
  Pencil,
  Maximize2,
  MessageCircle,
  Play,
  VolumeOff,
} from '../ui/icons';
import { SummaryIcon } from '../ui/icons';
import { HostMark } from '../ui/HostMark';
import { SideChatTitle } from './SideChatTitle';
import { MorphText } from '../ui/MorphText';
import { PaneTabIcon } from './PaneTabIcon';
import { PaneTabList } from './PaneTabList';
import { agentTabFor, agentTabBadge, frontTab, inView, viewChats } from '../../lib/agentTabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresentList } from '../ui/Presence';
import { prefersReducedMotion } from '../../lib/paneMotion';
import type { Thread } from '../../store/types';
import { cancelOnEscape, isEnter, onActivate } from '../../lib/focus';
import { withKeys } from '../../lib/listKeys';
import { useProfileAttention } from '../../session/profileAttention';
import { focusedChat } from '../../store/split';
import { togglePanel } from '../../store/shellPanels';
import { panelShown } from '../../lib/shellFit';

/**
 * The account button's warning on the sidebar toggle while the sidebar, and the button, are hidden. A leaf, so the
 * account lists it reads re-render only it, and only while it is mounted.
 */
function AttentionDot() {
  return useProfileAttention() ? <span className="tb-attention" /> : null;
}

/** The chat as Markdown, each reply labelled with the harness that wrote it. */
/**
 * How long a browser tab takes to grow in or shrink away: ChatGPT's toolbar items (max-width, opacity and scale over
 * --transition-duration-basic, .15s ease).
 */
export const TAB_MOTION_MS = 150;

function exportMarkdown(thread: Thread) {
  const s = useStore.getState();
  return transcriptMarkdown(
    threadTitle(thread),
    s.runtime[thread.id]?.turns ?? [],
    labelAt(thread.id, s.segments[thread.id], s.runtime[thread.id]?.turnsAbove),
  );
}

export function TitleBar() {
  const shortcut = useShortcutHint();
  // the title, its menu and the tab strip are the focused pane's chat
  const chatId = useStore(focusedChat);
  const canBack = useStore((s) => s.back.length > 0);
  const canForward = useStore((s) => s.forward.length > 0);
  const sidebarOpen = useStore((s) => panelShown(s, 'sidebar'));
  const summaryOpen = useStore((s) => panelShown(s, 'summary'));
  const bottomOpen = useStore((s) => s.bottomPanelOpen);
  const paneTabs = useStore((s) => s.paneTabs);
  const paneActive = useStore((s) => s.paneActive);
  const agentTabs = useStore((s) => s.agentTabs);
  const paneFull = useStore((s) => s.paneFull);
  const bottomControl = useStore((s) => s.prefs.bottomPanelControl);
  const fullscreen = useStore((s) => s.fullscreen);
  const thread = useStore((s) => (chatId ? s.threads[chatId] : null));
  const title = useStore((s) => threadTitle(chatId ? s.threads[chatId] : null, s.chatInitialTitles));
  const pinned = useStore((s) => (chatId ? !!s.pinned[chatId] : false));
  const more = useAnchor();
  // Project actions from the project's environment (environment.toml, else Conductor's run scripts), shown in the chat menu.
  const [envActions, setEnvActions] = useState<EnvAction[]>([]);
  // a chat on a machine has no folder on this Mac: nothing opens, runs or is read here for it
  const here = useFolderHere(chatId, thread?.cwd ?? '');
  const { machine } = useChatMachine(chatId);
  // a chat that moved to another agent on its machine keeps the first agent's id: no CLI resumes the current one by it
  const moved = useStore((s) => !!chatId && movedOnMachine(nativeOf(chatId), s.chatConfig[chatId]?.hostAgent));
  const resume = thread && !moved ? resumeCommandFor(nativeOf(thread.id)) : null;
  const projRoot = useStore((s) => (thread ? (projectForThread(thread, s.savedProjects)?.roots[0]?.path ?? here) : null));
  useEffect(() => {
    if (!more.open || !projRoot) return;
    // unreadable: the menu goes without the project's actions
    resolveEnvironment(projRoot).then(
      (e) => setEnvActions(e.actions.filter((a) => a.command)),
      ignoring("read the project's actions for the chat menu"),
    );
  }, [more.open, projRoot]);
  const paneWidth = useStore((s) => (s.diffPanel.open ? s.paneWidth : 0));
  useStore((s) => s.segments); // chatOf follows switched chats
  // an agent's browser tabs show only in their own chat's view (SidePane lays them out the same way)
  const viewed = viewChats(chatId, paneTabs);
  const front = frontTab(paneTabs, paneActive, viewed, chatOf);
  // a tab opened while the strip shows grows in, and a closed one shrinks away (TAB_MOTION_MS); taken over the whole
  // list, not the view, so switching chats (which only hides tabs) plays nothing
  const tabKey = useCallback((t: (typeof paneTabs)[number]) => t.id, []);
  const shownTabs = usePresentList(paneTabs, tabKey, prefersReducedMotion() ? 0 : TAB_MOTION_MS);
  const firstTabs = useRef<Set<string> | null>(null);
  firstTabs.current ??= new Set(paneTabs.map(tabKey));
  const backToChat = () => setState({ paneFull: false });
  const [renaming, setRenaming] = useState(false);
  // the browser tab being renamed in place (its menu's Rename)
  const [renamingTab, setRenamingTab] = useState<string | null>(null);

  return (
    <header
      className={`titlebar ${fullscreen ? 'fullscreen' : ''}`}
      onDoubleClick={(e) => e.target === e.currentTarget && native.win.toggleMaximize()}
    >
      <div className={`titlebar-main ${sidebarOpen ? 'sidebar-open' : ''} ${paneWidth ? 'beside-pane' : ''}`} style={{ right: paneWidth }}>
        <div className="titlebar-nav">
          <Tooltip label="Back" shortcut={shortcut('back')}>
            <button className="tb-btn" disabled={!canBack} onClick={goBack} aria-label="Back">
              <ArrowLeft size={17} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip label="Forward" shortcut={shortcut('forward')}>
            <button className="tb-btn" disabled={!canForward} onClick={goForward} aria-label="Forward">
              <ArrowRight size={17} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} shortcut={shortcut('toggle-sidebar')}>
            <button className="tb-btn" onClick={() => togglePanel('sidebar')} aria-label="Toggle sidebar">
              <PanelLeft size={17} strokeWidth={1.7} />
              {!sidebarOpen && <AttentionDot />}
            </button>
          </Tooltip>
        </div>

        <div className="titlebar-center">
          {thread && (
            <div className="tb-title">
              {machine ? (
                <HostMark id={machine.id} name={machine.name} cloud={machine.row?.cloud} size={16} />
              ) : (
                here && (
                  <Tooltip label={here}>
                    <button
                      type="button"
                      className="tb-folder"
                      aria-label="Reveal working directory in Finder"
                      onClick={() => showInFinder(here)}
                    >
                      <Folder size={16} strokeWidth={1.7} />
                    </button>
                  </Tooltip>
                )
              )}
              {renaming ? (
                <input
                  className="tb-rename"
                  autoFocus
                  defaultValue={title}
                  onBlur={async (e) => {
                    setRenaming(false);
                    const v = e.currentTarget.value.trim();
                    if (v && v !== threadTitle(thread)) {
                      const { renameThread } = await import('../../store/actions');
                      // the title stays as it was; say why, as the sidebar's rename does
                      await renameThread(thread.id, v).catch(toastFailure('Rename failed'));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (isEnter(e)) e.currentTarget.blur();
                    cancelOnEscape(e, () => setRenaming(false));
                  }}
                />
              ) : (
                <span className="tb-title-text" onDoubleClick={() => setRenaming(true)}>
                  {/* the generated title replacing the first words crossfades in, as the sidebar row's does; another chat doesn't */}
                  <MorphText key={thread.id} morphKey={title} className="morph-fit">
                    {title}
                  </MorphText>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="titlebar-right" hidden={paneFull}>
          {thread && (
            <>
              <Tooltip label="More">
                <button ref={more.ref} className={`tb-btn ${more.open ? 'active' : ''}`} onClick={more.toggle} aria-label="Chat actions">
                  <Ellipsis size={17} strokeWidth={1.7} />
                </button>
              </Tooltip>
              {bottomControl && (
                <Tooltip label={bottomOpen ? 'Hide terminal' : 'Show terminal'} shortcut={shortcut('toggle-bottom-panel')}>
                  <button
                    className={`tb-btn ${bottomOpen ? 'active' : ''}`}
                    onClick={() => setState({ bottomPanelOpen: !bottomOpen })}
                    aria-label="Terminal"
                  >
                    <PanelBottom size={17} strokeWidth={1.6} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label={summaryOpen ? 'Hide summary' : 'Show summary'}>
                <button className={`tb-btn ${summaryOpen ? 'active' : ''}`} onClick={() => togglePanel('summary')} aria-label="Summary">
                  <SummaryIcon />
                </button>
              </Tooltip>
              {!paneWidth && <span className="tb-sep" />}
            </>
          )}
          {!paneWidth && (
            <Tooltip label={front ? 'Show tabs' : 'New tab'} shortcut={front ? undefined : shortcut('open-browser-tab')}>
              <button
                className="tb-btn"
                onClick={() => (front ? showPaneTab() : openPaneTab('browser'))}
                aria-label={front ? 'Show tabs' : 'New tab'}
              >
                {front ? <PanelRight size={17} strokeWidth={1.7} /> : <SquarePlus size={17} strokeWidth={1.7} />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {paneWidth > 0 && (
        <div className="tb-tabs" style={{ width: paneWidth }}>
          <PaneTabList>
            {paneFull && thread && (
              <div
                className="tb-tab chat-tab"
                role="button"
                tabIndex={0}
                onClick={backToChat}
                onKeyDown={onActivate(backToChat)}
                title="Back to chat"
              >
                <MessageCircle size={15} strokeWidth={1.6} />
                <span>{title}</span>
              </div>
            )}
            {shownTabs
              .filter(({ item }) => inView(item, viewed, chatOf))
              .map(({ item: t, leaving }, i, shown) => {
                // a tab an agent opened, kept or is driving (main's view, any harness)
                const agent = t.kind === 'browser' && t.agentChat ? agentTabFor(agentTabs, t.agentChat, t.agentTab ?? null) : null;
                const badge = agentTabBadge(agent);
                const select = () => setState({ paneActive: t.id });
                const label =
                  t.kind === 'changes'
                    ? 'Changes'
                    : t.kind === 'files'
                      ? 'Files'
                      : t.kind === 'tasks'
                        ? 'Tasks'
                        : t.kind === 'chat'
                          ? t.readOnly
                            ? t.title || 'Sub-agent'
                            : 'Side chat'
                          : browserTabTitle(t);
                // a row, not a <button>: it holds its own close button
                return (
                  <PaneTabMenu
                    key={t.id}
                    tab={t}
                    hasOthers={shown.length > 1}
                    hasRight={i < shown.length - 1}
                    onRename={() => setRenamingTab(t.id)}
                    arrangement={{
                      scope: toolLayoutScope(chatId),
                      available: paneTabs.filter((tab) => inView(tab, viewed, chatOf)).map((tab) => tab.id),
                      front,
                      select: (id) => setState({ paneActive: id }),
                    }}
                    className={`tb-tab ${t.id === front ? 'active' : ''} ${agent?.active && !agent.takenOver ? 'agent-active' : ''}${
                      leaving ? ' tab-leaving' : firstTabs.current!.has(t.id) ? '' : ' tab-enter'
                    }`}
                    inert={leaving || undefined}
                    role="button"
                    aria-label={label}
                    aria-current={t.id === front ? 'true' : undefined}
                    tabIndex={0}
                    onClick={select}
                    onKeyDown={onActivate(select)}
                    title={t.kind === 'browser' ? [badge, t.url].filter(Boolean).join('\n') || undefined : undefined}
                  >
                    <PaneTabIcon tab={t} badge={badge} />
                    {t.kind === 'chat' && !t.readOnly ? (
                      <SideChatTitle threadId={t.threadId} />
                    ) : renamingTab === t.id ? (
                      <PaneTabRename tab={t} onDone={() => setRenamingTab(null)} />
                    ) : (
                      <span>{label}</span>
                    )}
                    {t.muted && <VolumeOff className="tb-tab-muted" size={13} strokeWidth={1.6} aria-label="Muted" />}
                    <button
                      className="tb-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closePaneTab(t.id);
                      }}
                      aria-label={`Close ${label} tab`}
                    >
                      <X size={13} />
                    </button>
                  </PaneTabMenu>
                );
              })}
          </PaneTabList>
          <Tooltip label="New tab" shortcut={shortcut('open-browser-tab')}>
            <button className="tb-btn" onClick={() => openPaneTab('browser')} aria-label="New tab">
              <Plus size={17} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <div className="flex1" />
          <Tooltip label={paneFull ? 'Exit full view' : 'Enter full view'}>
            <button
              className="tb-btn"
              onClick={() => setState({ paneFull: !paneFull })}
              aria-label={paneFull ? 'Exit full view' : 'Enter full view'}
            >
              {paneFull ? <Minimize2 size={14} strokeWidth={1.7} /> : <Maximize2 size={14} strokeWidth={1.7} />}
            </button>
          </Tooltip>
          <Tooltip label="Hide tabs">
            <button className="tb-btn on" onClick={() => setState({ diffPanel: { open: false }, paneFull: false })} aria-label="Hide tabs">
              <PanelRight size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
        </div>
      )}

      {thread && (
        <Menu anchor={more.anchor} open={more.open} onClose={more.close} placement="bottom-end" width={220}>
          <MenuItem icon={<Pencil size={16} strokeWidth={1.6} />} shortcut={shortcut('rename')} onSelect={() => setRenaming(true)}>
            Rename
          </MenuItem>
          <MenuItem
            icon={<Pin size={16} strokeWidth={1.6} />}
            shortcut={shortcut('pin')}
            onSelect={() => setState((s) => ({ pinned: { ...s.pinned, [thread.id]: !pinned } }))}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<MessageCirclePlus size={16} strokeWidth={1.6} />}
            shortcut={shortcut('side-chat')}
            onSelect={() => openSideChat(thread.id)}
          >
            New side chat
          </MenuItem>
          <SubMenu icon={<GitFork size={16} strokeWidth={1.6} />} label="Fork">
            <MenuItem onSelect={() => forkThread(thread.id).catch(toastFailure("Couldn't fork the chat"))}>Fork into new chat</MenuItem>
            <MenuItem
              onSelect={() =>
                forkThread(thread.id)
                  .then((id) => (id ? native.win.open(threadHash(id)) : undefined))
                  .catch(toastFailure("Couldn't fork the chat into a new window"))
              }
            >
              Fork into new window
            </MenuItem>
          </SubMenu>
          <MenuItem
            icon={<Clock size={16} strokeWidth={1.6} />}
            onSelect={() => {
              navigate({ name: 'scheduled' });
              setTimeout(
                () =>
                  window.dispatchEvent(
                    new CustomEvent('new-scheduled-task', { detail: { threadId: thread.id, cwd: thread.cwd, name: threadTitle(thread) } }),
                  ),
                50,
              );
            }}
          >
            Add scheduled task…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Share size={16} strokeWidth={1.6} />}
            onSelect={async () => {
              try {
                const md = exportMarkdown(thread);
                const p = await native.dialog.saveText(`${threadTitle(thread).replace(/[\\/:*?"<>|]/g, '')}.md`, md);
                if (p) toast('Saved transcript');
              } catch (e) {
                toastFailure("Couldn't save the transcript")(e);
              }
            }}
          >
            Share
          </MenuItem>
          <SubMenu icon={<Copy size={16} strokeWidth={1.6} />} label="Copy">
            <MenuItem onSelect={() => copyText(exportMarkdown(thread), 'Copied as Markdown')}>Copy as Markdown</MenuItem>
            <MenuItem onSelect={() => copyText(cliSessionId(thread.id), 'Copied chat ID')}>Copy chat ID</MenuItem>
            {resume && (
              <MenuItem
                hint={machine && onMachineHint(machine.name)}
                onSelect={() => copyText(resume, machine ? `Copied resume command: run it on ${machine.name}` : 'Copied resume command')}
              >
                Copy resume command
              </MenuItem>
            )}
            <MenuItem
              hint={machine && onMachineHint(machine.name)}
              onSelect={() => copyText(thread.cwd, machine ? `Copied path on ${machine.name}` : 'Copied path')}
            >
              Copy working directory
            </MenuItem>
          </SubMenu>
          <ChatUtilityItems thread={thread} />
          <MenuSeparator />
          <MenuItem icon={<ArrowRight size={16} strokeWidth={1.6} />} onSelect={() => openChanges()}>
            Move to right pane
          </MenuItem>
          <MenuItem icon={<SquareStack size={16} strokeWidth={1.6} />} onSelect={() => native.win.open(threadHash(thread.id))}>
            Open in new window
          </MenuItem>
          {here && envActions.length > 0 && (
            <SubMenu icon={<Play size={16} strokeWidth={1.6} />} label="Actions">
              {withKeys(envActions, (a) => JSON.stringify([a.name, a.command])).map(({ key, item: a }) => (
                <MenuItem key={key} onSelect={() => openPaneTab('terminal', { cwd: here, title: a.name, command: shellScript(a.command) })}>
                  {a.name}
                </MenuItem>
              ))}
            </SubMenu>
          )}
          {(here || machine) && (
            <SubMenu icon={<ArrowUpRight size={16} strokeWidth={1.6} />} label="Open in">
              <OpenInItems path={here} machine={machine} />
            </SubMenu>
          )}
          <MenuSeparator />
          <MenuItem icon={<Archive size={16} strokeWidth={1.6} />} shortcut={shortcut('archive')} onSelect={() => archiveThread(thread.id)}>
            Archive
          </MenuItem>
        </Menu>
      )}
    </header>
  );
}
