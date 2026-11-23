// The right-hand side pane: its tabs for changes, files, skills, browser, terminal, side chats and background tasks.

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { dragPaneWidth, fitPaneWidth, openingPaneWidth, paneLane, paneWidthGroup, rememberPaneWidth } from '../../lib/paneLayout';
import { get as getState, setPrefs, set as setState, useStore } from '../../store/core';
import { DiffPanel } from './DiffPanel';
import { MachineFolderNote } from './MachineFolderNote';
import { parseRemoteCwd } from '../../lib/remoteFolder';
import { useChatMachine } from '../../lib/chatMachine';
import { FilesPanel, FilePreview } from './FilesPanel';
import { SkillPanel } from './SkillPanel';
import { PlanPanel } from './PlanPanel';
import { OutputsPanel } from './OutputsPanel';
import { UsagePanel } from './UsagePanel';
import { BrowserPanel } from './BrowserPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { TermView } from './TerminalPanel';
import { recheckClaude } from '../../session/harness/claude';
import { Composer } from '../composer/Composer';
import { ThreadView } from '../thread/ThreadView';
import { TasksTab } from '../tasks/TasksTab';
import { chatOf } from '../../store/chats';
import { closePaneTab, openChanges } from '../../store/panes';
import { frontTab, inView, paneLayer, viewChats } from '../../lib/agentTabs';
import { usePaneSpring } from './usePaneSpring';
import { startEdgeDrag } from '../../lib/edgeDrag';
import { projectToolLayout, rememberToolLayout, toolLayoutScope, useToolLayout } from '../../lib/toolPaneLayout';
import { ToolPaneGrid, toolCell } from './ToolPaneGrid';

// loaded on first use: a chat on a machine reads its files and changes through its Host (they bring the diff and file views with them)
const MachineChanges = lazy(() => import('./MachineChanges').then((m) => ({ default: m.MachineChanges })));
const RemoteFilesPanel = lazy(() => import('./files/RemoteFiles').then((m) => ({ default: m.RemoteFilesPanel })));
const RemoteFilePreview = lazy(() => import('./files/RemoteFiles').then((m) => ({ default: m.RemoteFilePreview })));

/** Right-hand pane hosting changes, files, skills, browser, terminal and side chat tabs. */
export function SidePane({
  cwd,
  threadId,
  leaving = false,
  hidden = false,
}: {
  cwd: string;
  threadId: string | null;
  leaving?: boolean;
  hidden?: boolean;
}) {
  const tabs = useStore((s) => s.paneTabs);
  // a folder on a machine has no git or files here: those tabs say so instead of reading this Mac
  const { machine, pending } = useChatMachine(threadId);
  const active = useStore((s) => s.paneActive);
  const agentTabs = useStore((s) => s.agentTabs);
  // whether the built-in browser is signed in to claude.ai: an artifact tab shows its page only then
  const claudeSignedIn = useStore((s) => s.claudeSite?.signedIn ?? null);
  useStore((s) => s.segments); // chatOf follows switched chats
  // an agent's browser tabs show only in their chat's view; they stay mounted (and painted behind
  // the pane while an agent drives them) so the agent keeps working while another chat is on screen
  const chats = viewChats(threadId, tabs);
  const shown = tabs.filter((t) => inView(t, chats, chatOf)).length;
  const front = frontTab(tabs, active, chats, chatOf);
  const scope = toolLayoutScope(threadId);
  const savedLayout = useToolLayout(scope);
  const layout = projectToolLayout(
    savedLayout,
    tabs.filter((t) => inView(t, chats, chatOf)).map((t) => t.id),
    front,
  );
  useLayoutEffect(() => rememberToolLayout(scope, layout), [scope, layout]);
  // the width the user last chose for the kind in front when the pane opens (a side chat, tasks and terminals apart)
  const group = useRef(paneWidthGroup(tabs.find((t) => t.id === front)?.kind));
  group.current = paneWidthGroup(tabs.find((t) => t.id === front)?.kind);
  const [width, setWidth] = useState(() => openingPaneWidth(window.innerWidth, getState().prefs?.paneWidths, group.current));
  // Opening the pane without a tab shows Changes, like the official toggle.
  useEffect(() => {
    if (!shown && !leaving && !hidden) openChanges();
  }, [shown, leaving, hidden]);
  const full = useStore((s) => s.paneFull);
  const ref = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  // the width springs open and shut, and reverses mid-way from where the edge is (Codex's right panel)
  const settleSpring = usePaneSpring(ref, leaving, width, full);
  // Measure before painting: window width includes the sidebar and can crowd out the chat. A pane kept mounted behind
  // (its browser pages and shells stay) opens again at the width remembered for the kind then in front.
  useLayoutEffect(() => {
    const lane = ref.current?.parentElement;
    if (!full && !hidden && lane) setWidth(openingPaneWidth(lane.clientWidth, getState().prefs?.paneWidths, group.current));
  }, [full, hidden]);
  // The title bar tab strip follows the pane's real width (it fills the window in full view).
  useEffect(() => {
    const el = ref.current!;
    const lane = el.parentElement;
    const ro = new ResizeObserver(() => {
      // a drag owns the width and the tab strip's until it is released (its frames write both, and fit the lane)
      if (stopDrag.current) return;
      setState({ paneWidth: Math.round(el.getBoundingClientRect().width) });
      // a window made smaller after the pane opened must not leave it wider than the room (its cards and Stop buttons would clip)
      if (lane) setWidth((w) => fitPaneWidth(w, lane.clientWidth));
    });
    ro.observe(el);
    if (lane) ro.observe(lane);
    return () => {
      ro.disconnect();
      stopDrag.current?.();
      setState({ paneWidth: 0, paneFull: false });
    };
  }, []);
  return (
    <div
      ref={ref}
      hidden={hidden}
      className={`side-pane ${full ? 'full' : ''} ${leaving ? 'leaving' : ''}`}
      style={full ? undefined : ({ width, '--pane-w': `${width}px` } as CSSProperties)}
    >
      <div
        className="pane-resize"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const sx = e.clientX;
          const sw = width;
          const el = ref.current!;
          stopDrag.current?.();
          settleSpring();
          // the pane and the title bar's tab strip follow each frame straight from here, so what the pane holds (a
          // diff of thousands of lines) is not rendered again on every move (#2049); its width state changes on release
          stopDrag.current = startEdgeDrag(e, {
            axis: 'column',
            // the lane the pane shares with the chat, not the window (the sidebar is part of the window too), read each
            // frame: a window resized mid-drag must not leave the pane wider than the room
            size: (ev) => dragPaneWidth(sw, sx - ev.clientX, paneLane(el)),
            apply: (w) => {
              el.style.width = `${w}px`;
              el.style.setProperty('--pane-w', `${w}px`);
              setState({ paneWidth: w });
            },
            ended: () => {
              stopDrag.current = null;
            },
            commit: (w) => {
              setWidth(w);
              // the next pane of this kind opens at this share of its lane, as Claude Desktop keeps each pane's size
              setPrefs({ paneWidths: rememberPaneWidth(getState().prefs?.paneWidths, group.current, w, paneLane(el)) });
            },
          });
        }}
        // a double-click puts the pane back at its default width, as Claude Desktop's panel edges do, and forgets the one chosen
        onDoubleClick={() => {
          const lane = paneLane(ref.current!);
          const widths = rememberPaneWidth(getState().prefs?.paneWidths, group.current, null, lane);
          setPrefs({ paneWidths: widths });
          setWidth(openingPaneWidth(lane, widths, group.current));
        }}
      />
      {full && threadId && (
        // Full view keeps the chat reachable through a floating composer, as in the official app.
        <div className="pane-float-composer">
          <Composer threadId={threadId} variant="thread" />
        </div>
      )}
      <ToolPaneGrid scope={scope} layout={layout} tabs={tabs} select={(id) => setState({ paneActive: id })}>
        {tabs.map((t) => {
          // Browser tabs stay mounted so pages keep their state while another tab is shown.
          const tile = layout.ids.indexOf(t.id);
          const visible = tile >= 0;
          const layer = paneLayer(t, visible ? t.id : front, agentTabs);
          return (
            <div
              key={t.id}
              className={`pane-tab-body ${layer === 'back' ? 'pane-tab-back' : ''}`}
              hidden={layer === 'none'}
              inert={layer === 'back'}
              aria-hidden={layer === 'back' || undefined}
              style={visible ? toolCell(layout, tile) : undefined}
              data-tool-tab={t.id}
              onFocusCapture={() => !hidden && !leaving && visible && active !== t.id && setState({ paneActive: t.id })}
              onPointerDownCapture={() => visible && active !== t.id && setState({ paneActive: t.id })}
            >
              {t.kind === 'changes' &&
                visible &&
                (machine ? (
                  machine.away ? (
                    <MachineFolderNote machine={machine} what="Changes" />
                  ) : (
                    <Suspense fallback={null}>
                      <MachineChanges machine={machine} threadId={threadId} />
                    </Suspense>
                  )
                ) : (
                  !pending && <DiffPanel cwd={cwd} threadId={threadId} />
                ))}
              {t.kind === 'files' &&
                visible &&
                (machine ? (
                  machine.away ? (
                    <MachineFolderNote machine={machine} what="Files" />
                  ) : (
                    <Suspense fallback={null}>
                      <RemoteFilesPanel machine={machine} threadId={threadId} />
                    </Suspense>
                  )
                ) : (
                  !pending && <FilesPanel cwd={cwd} />
                ))}
              {t.kind === 'file' && t.path && visible && parseRemoteCwd(t.cwd) && (
                <Suspense fallback={null}>
                  <RemoteFilePreview
                    machineId={parseRemoteCwd(t.cwd)!.machineId}
                    path={t.path}
                    line={t.line}
                    endLine={t.endLine}
                    reload={t.version}
                  />
                </Suspense>
              )}
              {t.kind === 'file' && t.path && visible && !parseRemoteCwd(t.cwd) && machine && !t.cwd && (
                <MachineFolderNote machine={machine} what="Files" />
              )}
              {t.kind === 'file' && t.path && visible && !parseRemoteCwd(t.cwd) && !(machine && !t.cwd) && !pending && (
                <FilePreview path={t.path} line={t.line} endLine={t.endLine} cwd={t.cwd ?? cwd} revision={t.version} />
              )}
              {t.kind === 'plan' && t.threadId && visible && <PlanPanel threadId={t.threadId} plan={t.plan} />}
              {t.kind === 'outputs' && t.threadId && visible && <OutputsPanel threadId={t.threadId} />}
              {t.kind === 'usage' && t.threadId && visible && <UsagePanel threadId={t.threadId} />}
              {t.kind === 'skill' && t.path && <SkillPanel path={t.path} />}
              {t.kind === 'chat' && t.threadId && <ThreadView threadId={t.threadId} inPane readOnly={!!t.readOnly} />}
              {t.kind === 'tasks' && visible && <TasksTab tab={t} chatId={t.threadId!} cwd={cwd} />}
              {t.kind === 'browser' && <BrowserPanel tabId={t.id} cwd={cwd} threadId={threadId} layer={layer} />}
              {t.kind === 'artifact' && <ArtifactPanel tab={t} shown={!hidden && visible} signedIn={claudeSignedIn} />}
              {t.kind === 'terminal' && (
                <div className="pane-term">
                  <TermView
                    tab={{
                      id: t.id,
                      cwd: t.cwd ?? cwd,
                      title: t.title ?? '',
                      command: t.command,
                      input: t.input,
                      signIn: t.signIn,
                      env: t.env,
                    }}
                    visible={!hidden && visible}
                    onExit={() => (closePaneTab(t.id), t.title === 'claude auth login' && void recheckClaude())}
                  />
                </div>
              )}
            </div>
          );
        })}
      </ToolPaneGrid>
    </div>
  );
}
