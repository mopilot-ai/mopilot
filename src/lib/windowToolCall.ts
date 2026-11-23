// A chat's call to MoPilot's window and pane tools (electron/capabilities/tools/windowTools.cjs, paneTools.cjs), read from
// the tool call item whichever harness made it: the line it reads as while it runs, once done, when it changed nothing,
// or when it failed (Claude Desktop's labels for its ccd_window and ccd_view tools and its terminal tool).
import { ownToolLine } from './ownToolLines';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { nameOf } from './scheduledTaskCall';
import { sessionCallLine } from './sessionToolCall';
import { toolOutput } from './toolOutput';

type CallItem = {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: string;
  error?: unknown;
  result?: { isError?: boolean } | null;
  arguments?: unknown;
};

type Line = { doing: string; done: string; failed: string };
const LINES: Record<string, Line> = {
  split: { doing: 'Opening session in split view', done: 'Opened session in split view', failed: 'Couldn’t open session in split view' },
  window: { doing: 'Opening session in new window', done: 'Opened session in new window', failed: 'Couldn’t open session in new window' },
  focus: { doing: 'Opening session', done: 'Opened session', failed: 'Couldn’t open session' },
  close: { doing: 'Closing split view', done: 'Closed split view', failed: 'Couldn’t close split view' },
  sidebar: { doing: 'Changing the sidebar', done: 'Changed the sidebar', failed: 'Couldn’t change the sidebar' },
  layout: { doing: 'Checking window layout', done: 'Checked window layout', failed: 'Couldn’t check window layout' },
};
const line = (doing: string, done: string, failed: string): Line => ({ doing, done, failed });
/** show_pane by the pane it shows, as Claude Desktop words each */
const SHOWN: Record<string, Line> = {
  diff: line('Opening diff', 'Opened diff', 'Couldn’t open diff'),
  file: line('Opening file', 'Opened file', 'Couldn’t open file'),
  terminal: line('Opening terminal', 'Opened terminal', 'Couldn’t open terminal'),
  tasks: line('Opening background tasks', 'Opened background tasks', 'Couldn’t open background tasks'),
  preview: line('Opening browser', 'Opened browser', 'Couldn’t open browser'),
  artifact: line('Opening artifact', 'Opened artifact', 'Couldn’t open artifact'),
};
const PANE = line('Opening pane', 'Opened pane', 'Couldn’t open pane');
const CLOSE_PANE = line('Closing pane', 'Closed pane', 'Couldn’t close pane');
const TERMINAL_TAB = line('Opening terminal tab', 'Opened terminal tab', 'Couldn’t open terminal tab');
/** A call that answered but changed nothing (not on screen, already visible, no room, not its pane). */
const UNCHANGED = 'Left the window as it was';

/** Which line a window tool call reads as, by its tool and target; null for any other call. */
function lineOf(item: unknown): Line | null {
  const it = item as CallItem | null;
  if (!it || (it.type !== 'mcpToolCall' && it.type !== 'dynamicToolCall')) return null;
  const name = nameOf(it);
  // MoPilot's tool server is sage_<nonce>; another server's tool of the same name is not ours
  if (!name || (name.server && !/^sage(_|$)/i.test(name.server))) return null;
  if (name.tool === 'show_pane') {
    const pane = (it.arguments as { pane?: unknown } | null)?.pane;
    return typeof pane === 'string' && Object.hasOwn(SHOWN, pane) ? SHOWN[pane] : PANE;
  }
  if (name.tool === 'close_pane') return CLOSE_PANE;
  if (name.tool === 'open_terminal_tab') return TERMINAL_TAB;
  if (name.tool === 'close_split') return LINES.close;
  if (name.tool === 'get_window_layout') return LINES.layout;
  if (name.tool === 'set_sidebar_collapsed') return LINES.sidebar;
  if (name.tool !== 'open_session_in') return null;
  const target = (it.arguments as { target?: unknown } | null)?.target;
  return LINES[target === 'window' || target === 'focus' ? target : 'split'];
}

/** Whether an answered call says it changed nothing (its result's `changed: false`). */
function unchanged(it: CallItem): boolean {
  try {
    return (JSON.parse(toolOutput(it).text) as { changed?: unknown } | null)?.changed === false;
  } catch {
    return false;
  }
}

/** The line one of MoPilot's window tool calls reads as, running or finished; else null. */
export function windowCallLine(item: unknown): { text: string; failed: boolean } | null {
  item = toolInvocation(item);
  const found = lineOf(item);
  if (!found) return null;
  const it = item as CallItem;
  const failed = it.status === 'failed' || !!it.error || it.result?.isError === true;
  if (failed) return { text: found.failed, failed };
  if (it.status !== undefined && it.status !== 'completed') return { text: found.doing, failed };
  return { text: found !== LINES.layout && unchanged(it) ? UNCHANGED : found.done, failed };
}

/** The line a MoPilot session or window tool call reads as, or null for any other tool. */
export const sageCallLine = (item: unknown) => sessionCallLine(item) ?? windowCallLine(item);

/** The line any of MoPilot's own tool calls reads as (sageCallLine's, else ownToolLines.ts's), or null for another tool. */
export const ownCallLine = (item: unknown) => sageCallLine(item) ?? ownToolLine(item);
