// Reads MCP inventory for the slash menu and connector status for the active session rail.
import { codexApi } from '../../harness/adapters/codexApi';
import { currentFamily, type HarnessFamily } from '../../harness/family';
import { mcpConnectionStatus, type ClaudeMcpServer as LiveClaudeMcpServer } from '../../harness/mcpConnection';
import { useLocalFolder } from '../../lib/chatMachine';
import { native } from '../../lib/native';
import { nativeOf } from '../../store/chats';
import { useStore } from '../../store/core';
import type { Route } from '../../store/types';
import { claudeMcpRows, codexMcpRows, type ClaudeMcpServer, type McpRow } from '../../harness/entries';
import { acpHarnessOf, type HarnessId } from '../../harness/types';
import type { McpServerStatus } from '../../protocol/v2/McpServerStatus';
import { currentNativeId } from '../../harness/ownership';
import { chatAccount } from './chatAccount';

/**
 * The MCP servers of the harness the chat is on now: a switched chat lists the new segment's. Rejects when the
 * harness can't be asked, so a failed read is not shown as "No MCP servers".
 */
export async function loadMcpRows(harness: HarnessId, chatId: string | null): Promise<McpRow[]> {
  if (harness === 'codex') return codexMcpRows((await codexApi.mcpStatus()).data ?? []);
  if (!chatId) return [];
  return claudeMcpRows(((await native.claude.control(nativeOf(chatId), 'mcpStatus')) as ClaudeMcpServer[]) ?? []);
}

type Connector = { name: string; status: string; reconnect?: boolean };
export type ConnectorInventory = { scope: 'session' | 'configuration'; rows: Connector[] } | { scope: 'unavailable' };

/** Read identity and management destination from the chat's current harness rather than the new-chat default. */
export function useConnectorSession(chatId: string) {
  const nativeId = useStore((s) => currentNativeId(s.segments?.[chatId], chatId));
  const family = useStore((s) => currentFamily(s.segments?.[chatId], chatId));
  const basic = acpHarnessOf(nativeId);
  const account = useStore((s) =>
    family === 'codex'
      ? (s.accounts?.chatAccounts?.[nativeId]?.id ?? s.accounts?.active)
      : family === 'claude'
        ? (s.claudeChats?.[chatId]?.serving ?? s.claudeChats?.[chatId]?.id ?? s.claudeAccounts?.active)
        : undefined,
  );
  const connection = useStore((s) => (family === 'codex' ? s.conn : undefined));
  const choice = useStore((s) => (basic ? s.prefs.acpMcp?.[basic] : undefined));
  const settings: Route = basic
    ? { name: 'settings', section: 'other-harnesses', tab: `harness:${basic}` }
    : { name: 'settings', section: family, tab: 'extensions:mcps', ...(family === 'claude' && { connectorChatId: chatId }) };
  return { nativeId, family, account, connection, choice, settings };
}

/** Settings opened from a chat keeps that chat's workspace and serving login. */
export function useClaudeConnectorTarget(chatId: string) {
  const folder = useStore((s) => s.threads?.[chatId]?.cwd ?? null);
  const isClaude = useStore((s) => currentFamily(s.segments?.[chatId], chatId) === 'claude');
  const account = useStore((s) => chatAccount('claude', chatId, s)?.serving ?? s.claudeAccounts.active);
  const { cwd, machine, pending, ownerUnavailable } = useLocalFolder(chatId, folder ?? '', true);
  return { cwd, account, pending, ownerUnavailable, available: folder !== null && isClaude && !machine && !pending };
}

/** Invalidate a live inventory when the adapter reports that the owning process or thread changed. */
export function watchSessionConnectors(family: HarnessFamily, nativeId: string, change: (closed: boolean) => void) {
  if (family === 'claude') {
    return native.claude.onEvent((event) => {
      if (!('key' in event) || event.key !== nativeId) return;
      if (event.kind === 'closed' || event.kind === 'error' || event.kind === 'processRetired') change(true);
      if (event.kind === 'processStarted') change(false);
      if (event.kind === 'message' && event.msg.type === 'system' && event.msg.subtype === 'init') change(false);
    });
  }
  if (family === 'codex') {
    const thread = native.codex.onItem((item) => {
      if (item.kind === 'lease' && item.threadId === nativeId) change(!item.held);
      if (item.kind !== 'notification') return;
      const event = item.params as { threadId?: unknown; sourceThreadId?: unknown; thread?: { id?: unknown }; status?: unknown } | null;
      const source = event?.sourceThreadId ?? event?.threadId;
      if (item.method === 'thread/closed' && source === nativeId) change(true);
      if (item.method === 'thread/started' && event?.thread?.id === nativeId) change(false);
      if (
        item.method === 'mcpServer/startupStatus/updated' &&
        source === nativeId &&
        (event?.status === 'ready' || event?.status === 'failed' || event?.status === 'cancelled')
      )
        change(false);
    });
    const server = native.codex.onStatus(({ kind }) => {
      if (kind === 'exit' || kind === 'error') change(true);
      if (kind === 'ready') change(false);
    });
    return () => {
      thread();
      server();
    };
  }
  return native.gateway.onChanged(() => change(false));
}

const validName = (name: unknown): name is string => typeof name === 'string' && !!name.trim();

function codexConnector(row: McpServerStatus): Connector {
  switch (row.runtimeStatus) {
    case 'connected':
      return { name: row.name, status: 'Connected' };
    case 'authenticationRequired':
      return { name: row.name, status: 'Sign-in required', reconnect: true };
    case 'failed':
      return { name: row.name, status: 'Connection failed' };
    case 'starting':
      return { name: row.name, status: 'Connecting…' };
    case 'disabled':
      return { name: row.name, status: 'Disabled' };
    case 'cancelled':
      return { name: row.name, status: 'Connection cancelled' };
    default:
      return row.authStatus === 'notLoggedIn'
        ? { name: row.name, status: 'Sign-in required', reconnect: true }
        : { name: row.name, status: 'Status unavailable' };
  }
}

/** A cancelled read may finish its current IPC request, but cannot fetch another page. */
export async function loadSessionConnectors(
  family: HarnessFamily,
  chatId: string,
  nativeId: string,
  signal: AbortSignal,
): Promise<ConnectorInventory> {
  if (family === 'codex') {
    const rows = new Map<string, Connector>();
    const visited = new Set<string>();
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page = await codexApi.mcpStatus({ chatId, nativeId, cursor });
      if (!Array.isArray(page?.data) || page.data.some((row) => !validName(row?.name))) {
        throw new Error('Invalid connector status response.');
      }
      for (const row of page.data) rows.set(row.name, codexConnector(row));
      cursor = page.nextCursor ?? null;
      if (cursor !== null) {
        if (!validName(cursor) || visited.has(cursor)) throw new Error('Invalid connector pagination cursor.');
        visited.add(cursor);
      }
    } while (cursor !== null);
    return { scope: 'session', rows: [...rows.values()] };
  }
  if (family === 'claude') {
    const servers = (await native.claude.control(nativeId, 'mcpStatus')) as LiveClaudeMcpServer[] | null;
    if (servers === null) return { scope: 'unavailable' };
    if (!Array.isArray(servers) || servers.some((row) => !validName(row?.name) || typeof row.status !== 'string')) {
      throw new Error('Invalid connector status response.');
    }
    return {
      scope: 'session',
      rows: servers.map(({ name, status }) => ({
        name,
        status: mcpConnectionStatus(status).label,
        reconnect: status === 'needs-auth',
      })),
    };
  }
  const harness = acpHarnessOf(nativeId);
  if (!harness) return { scope: 'unavailable' };
  const config = await native.acp.ownMcp(harness, true);
  if (config?.harness !== harness || config.supported === false) return { scope: 'unavailable' };
  if (
    config.supported !== true ||
    typeof config.load !== 'boolean' ||
    !Array.isArray(config.servers) ||
    config.servers.some((row) => !validName(row?.name) || typeof row.enabled !== 'boolean' || typeof row.off !== 'boolean')
  ) {
    throw new Error('Invalid harness connector configuration.');
  }
  return {
    scope: 'configuration',
    rows: config.servers.map(({ name, enabled, off, managed }) => ({
      name,
      status: managed === true ? 'Managed by gateway' : config.load && enabled && !off ? 'Configured' : 'Disabled in settings',
    })),
  };
}
