// The MCP servers of the harness a chat is on (WP7-12): loaded from that harness, listed the same way.
import { codexApi } from '../../harness/adapters/codexApi';
import { native } from '../../lib/native';
import { nativeOf } from '../../store/chats';
import { claudeMcpRows, codexMcpRows, type ClaudeMcpServer, type McpRow } from '../../harness/entries';
import type { HarnessId } from '../../harness/types';

/**
 * The MCP servers of the harness the chat is on now: a switched chat lists the new segment's. Rejects when the
 * harness can't be asked, so a failed read is not shown as "No MCP servers".
 */
export async function loadMcpRows(harness: HarnessId, chatId: string | null): Promise<McpRow[]> {
  if (harness === 'codex') return codexMcpRows((await codexApi.mcpStatus()).data ?? []);
  if (!chatId) return [];
  return claudeMcpRows(((await native.claude.control(nativeOf(chatId), 'mcpStatus')) as ClaudeMcpServer[]) ?? []);
}
