// Route one native Claude session's translated notifications, preserving its usage provenance and agent transcripts.
import { putAgentItems, type AgentItem } from '../../store/agentThreads';

const itemsOf = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as AgentItem[];

export function claudeNotifications(nativeId: string, emit: (method: string, params: Record<string, unknown>) => void) {
  return (method: string, params: Record<string, unknown>) => {
    // a sub-agent's whole transcript so far, as main had it from the core: this is where it is parsed
    if (method === 'agent/items') putAgentItems(String(params.threadId), String(params.agentKey), itemsOf(params.items as Uint8Array));
    else emit(method, method === 'thread/tokenUsage/updated' ? { ...params, tokenUsageSource: { harness: 'claude', nativeId } } : params);
  };
}
