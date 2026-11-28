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
import type { ConnectorAction } from './connectorActions';

/**
 * The MCP servers of the harness the chat is on now: a switched chat lists the new segment's. Rejects when the
 * harness can't be asked, so a failed read is not shown as "No MCP servers".
 */
export async function loadMcpRows(harness: HarnessId, chatId: string | null): Promise<McpRow[]> {
  if (harness === 'codex') return codexMcpRows((await codexApi.mcpStatus()).data ?? []);
  if (!chatId) return [];
  return claudeMcpRows(((await native.claude.control(nativeOf(chatId), 'mcpStatus')) as ClaudeMcpServer[]) ?? []);
}

/**
 * One connector row, the same shape on every harness. `status` is the harness's full wording. `state` places the row:
 * `attention` needs the user and has the `action` clicking it takes ('connect': sign in, or 'reconnect'); `configured`
 * is a harness that reports settings, not live connections.
 */
export type ConnectorState = 'connected' | 'attention' | 'pending' | 'off' | 'unavailable' | 'configured';
export type Connector = { name: string; status: string; state: ConnectorState; action?: ConnectorAction };
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
      if (event.kind === 'mcpChanged') change(false);
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
      // a sign-in the rail started for this thread finished (or one from settings, which names no thread)
      if (item.method === 'mcpServer/oauthLogin/completed' && (source === nativeId || source == null)) change(false);
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
  const name = row.name;
  switch (row.runtimeStatus) {
    case 'connected':
      return { name, status: 'Connected', state: 'connected' };
    case 'authenticationRequired':
      return { name, status: 'Sign-in required', state: 'attention', action: 'connect' };
    case 'failed':
      return { name, status: 'Connection failed', state: 'attention', action: 'reconnect' };
    case 'starting':
      return { name, status: 'Connecting…', state: 'pending' };
    case 'disabled':
      return { name, status: 'Disabled', state: 'off' };
    case 'cancelled':
      return { name, status: 'Connection cancelled', state: 'attention', action: 'reconnect' };
    default:
      return row.authStatus === 'notLoggedIn'
        ? { name, status: 'Sign-in required', state: 'attention', action: 'connect' }
        : { name, status: 'Status unavailable', state: 'unavailable' };
  }
}

const CLAUDE_STATE: Record<string, Pick<Connector, 'state' | 'action'>> = {
  connected: { state: 'connected' },
  'needs-auth': { state: 'attention', action: 'connect' },
  failed: { state: 'attention', action: 'reconnect' },
  pending: { state: 'pending' },
  disabled: { state: 'off' },
};

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
        ...(CLAUDE_STATE[status] ?? { state: 'unavailable' }),
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
    rows: config.servers.map(({ name, enabled, off, managed }): Connector => {
      if (managed === true) return { name, status: 'Managed by gateway', state: 'configured' };
      return config.load && enabled && !off
        ? { name, status: 'Configured', state: 'configured' }
        : { name, status: 'Disabled in settings', state: 'off' };
    }),
  };
}
