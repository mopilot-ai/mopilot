// The step lines MoPilot's own tools read as when no card or control narration draws them (MoMo's memory and sources;
// messages to other chats; scheduled tasks; computer use; design systems; plugin skills; the sidebar;
// the task list; the coding tools MoMo re-offers),
// on every harness: what the call does while it runs, once done, and when it failed, never the tool's raw name.
import { OWN_LINES } from '../../shared/ownToolLines.mjs';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { nameOf } from './scheduledTaskCall';

type CallItem = {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: string;
  error?: unknown;
  result?: { isError?: boolean } | null;
};

type Line = { doing: string; done: string; failed: string };

const LINES: Record<string, Line> = OWN_LINES;
/** A coding-side MCP server's tool that MoMo re-offers (momo_mcp_<server>_<tool>, electron/momo/mcp/names.cjs): its name is the server's. */
const PROXIED = /^momo_mcp_[a-z0-9_]+$/;
const PROXIED_LINE: Line = { doing: 'Using a coding tool', done: 'Used a coding tool', failed: "A coding tool didn't run" };

/** The tools this table words, for the guard that every tool MoPilot registers reads as a line. */
export const OWN_TOOL_LINES: readonly string[] = Object.keys(LINES);

/** Whether a server is MoPilot's own tool server (sage_<nonce>), or none was named. */
export const isOwnServer = (server: string) => !server || /^sage(_|$)/i.test(server);

/** The line one of MoPilot's own tool calls reads as, running or finished; else null (another server's tool, or one not in the table). */
export function ownToolLine(item: unknown): { text: string; failed: boolean } | null {
  const it = toolInvocation(item) as CallItem | null;
  if (!it || (it.type !== 'mcpToolCall' && it.type !== 'dynamicToolCall')) return null;
  const name = nameOf(it);
  const found = name && isOwnServer(name.server) ? (LINES[name.tool] ?? (PROXIED.test(name.tool) ? PROXIED_LINE : undefined)) : undefined;
  if (!found) return null;
  const failed = it.status === 'failed' || !!it.error || it.result?.isError === true;
  if (failed) return { text: found.failed, failed };
  return { text: it.status !== undefined && it.status !== 'completed' ? found.doing : found.done, failed };
}

/** A tool call's name as a step shows it: "server · tool", MoPilot's own server (a per-session nonce) left out. */
export function shownToolName(item: { tool?: unknown; server?: unknown }): string {
  const name = nameOf(item);
  if (!name) return 'Tool';
  return isOwnServer(name.server) ? name.tool : `${name.server} · ${name.tool}`;
}
