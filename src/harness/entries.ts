// Entry points that depend on the chat's current segment (WP7-12, A17): the Status rows, the MCP list, and
// where voice and the routing chips go. Pure functions over what the caller read, so every entry asks the same
// question and the tests can too.
import { COPY, fmt } from './copy';
import { HARNESS_LABEL, type HarnessId } from './types';
import { TEMPORARY_BASIC_HARNESS } from './family';
import { RESET_SINCE_READ } from './usageWindows';
import { contextShare, contextTokens } from '../lib/contextFormat';

/** Codex Cloud is a Codex feature: its chip appears only for a new chat that starts on Codex. */
export const usesCodexCloud = (harness: HarnessId | null | undefined): boolean => harness === 'codex';

/** "+" menu plugins are Codex's (its plugin marketplace); other harnesses keep their own. */
export const listsCodexPlugins = (harness: HarnessId | null | undefined): boolean => harness === 'codex';

/**
 * "Try now" on a Codex plugin or skill attaches a Codex mention (plugin://id, /skill). Another
 * harness would get it as plain text and ignore it, so the composer says why instead (D-22).
 */
export const codexAttachBlocked = (harness: HarnessId | null | undefined): string | null =>
  harness === 'codex' ? null : 'That is a Codex plugin or skill. Start a Codex chat to use it.';

export interface StatusInput {
  chatId: string | null;
  harnessLabel: string;
  model: string | null;
  effort: string | null;
  account: string | null;
  /** context window use: tokens now and the window, when the harness says */
  context: { used: number; window: number } | null;
  totalTokens: number | null;
  /** rate-limit windows from the harness's own usage: usedPercent null when its reset passed since the reading; `reset`
   * is when it starts over, when known */
  limits: { label: string; usedPercent: number | null; reset?: string | null }[];
}

/** The one Status template: the same rows for every harness, read from the current segment. */
export function statusRows(i: StatusInput): [string, string][] {
  const c = i.context && i.context.window ? i.context : null;
  return [
    ['Chat ID', i.chatId ?? 'New chat'],
    ['Harness', i.harnessLabel],
    ['Model', `${i.model ?? 'default'}${i.effort ? ` · ${i.effort}` : ''}`],
    ...(i.account ? ([['Account', i.account]] as [string, string][]) : []),
    ['Context', c ? `${contextShare(c.used, c.window)} used · ${contextTokens(c.used)} / ${contextTokens(c.window)} tokens` : '—'],
    ['Total tokens', i.totalTokens == null ? '—' : contextTokens(i.totalTokens)],
    ...i.limits.map(
      (l) =>
        [
          l.label,
          l.usedPercent == null
            ? RESET_SINCE_READ
            : `${Math.max(0, 100 - Math.round(l.usedPercent))}% left${l.reset ? ` · ${l.reset}` : ''}`,
        ] as [string, string],
    ),
  ];
}

export interface McpRow {
  name: string;
  desc: string;
}

/** The fields of a Codex McpServerStatus the rows read. */
export interface CodexMcpServer {
  name: string;
  authStatus?: unknown;
  tools?: Record<string, unknown> | null;
}

/** The fields of a Claude Code McpServerStatus the rows read. */
export interface ClaudeMcpServer {
  name: string;
  status?: string | null;
  tools?: unknown[] | null;
}

/** Codex's mcpServerStatus/list rows. */
export function codexMcpRows(data: CodexMcpServer[]): McpRow[] {
  return (data ?? []).map((m) => ({
    name: String(m.name),
    desc: m.authStatus === 'notLoggedIn' ? 'Not signed in' : `${Object.keys(m.tools ?? {}).length} tools`,
  }));
}

/** Claude Code's mcpServerStatus rows ({name, status, tools?}). */
export function claudeMcpRows(servers: ClaudeMcpServer[]): McpRow[] {
  return (servers ?? []).map((m) => ({
    name: String(m.name),
    desc:
      m.status === 'needs-auth'
        ? 'Not signed in'
        : m.status === 'connected'
          ? `${(m.tools ?? []).length} tools`
          : String(m.status ?? 'unknown'),
  }));
}

/** The Cloud chip above a new chat's composer. */
export const cloudChip = (account: string): string => fmt(COPY.routing.chipCloud, { account }).replace(/\s*·\s*Undo$/, '');

/** The chip for ⇧⌘N when the default harness is a basic-tier one that can't keep a chat off disk. */
export const temporaryChip = (account: string, label: string): string =>
  fmt(COPY.routing.chipTemporary, { harness: HARNESS_LABEL[TEMPORARY_BASIC_HARNESS], account, label }).replace(/\s*·\s*Undo$/, '');
