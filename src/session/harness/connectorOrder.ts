// The session rail's connector order, as Claude Desktop's: servers the chat used first, failing before healthy, off last,
// with one that needs the user always within the rows shown before "Show more".
import type { TurnState } from '../../store/types';
import type { Connector } from './mcpRows';

/** Rows the rail shows before "Show more". */
export const CONNECTORS_SHOWN = 3;

/** Claude Code's tool-name form of a server name (`mcp__<this>__tool`): other characters become underscores. */
export const toolPrefix = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * The chat's MCP tool calls, in first-use order, each as `<server prefix>__<tool>` (Claude Code's name past `mcp__`). A row
 * is matched by prefix, since a server name may itself hold `__`.
 */
export function usedServers(turns: readonly TurnState[]): string[] {
  const used = new Set<string>();
  for (const turn of turns)
    for (const it of turn.items ?? []) {
      if (it.type === 'mcpToolCall' && typeof it.server === 'string') used.add(`${toolPrefix(it.server)}__${it.tool}`);
      else if (it.type === 'dynamicToolCall' && typeof it.tool === 'string' && it.tool.startsWith('mcp__')) used.add(it.tool.slice(5));
    }
  return [...used];
}

/** Where the server's first call stands among the chat's calls, or Infinity when it made none. */
function firstUse(name: string, used: readonly string[]) {
  const prefix = `${toolPrefix(name)}__`;
  const at = used.findIndex((call) => call.startsWith(prefix));
  return at < 0 ? Infinity : at;
}

const failing = (row: Connector) => row.state === 'attention';
const resting = (row: Connector) => row.state === 'off' || row.state === 'unavailable';

/**
 * Group 0: used and failing; 1: used and healthy; 2: unused and failing; 3: unused and healthy; 4: off or unavailable.
 * Within a group, used servers keep first-use order and the rest the harness's order. A first failing row past the
 * shown rows moves up to the last shown place.
 */
export function orderConnectors(rows: readonly Connector[], used: readonly string[]): Connector[] {
  const group = (row: Connector, use: number) => {
    if (resting(row)) return 4;
    return (use < Infinity ? 0 : 2) + (failing(row) ? 0 : 1);
  };
  const order = rows
    .map((row, index) => ({ row, index, use: firstUse(row.name, used) }))
    .map((r) => ({ ...r, group: group(r.row, r.use) }))
    .sort((a, b) => a.group - b.group || a.use - b.use || a.index - b.index)
    .map(({ row }) => row);
  const attention = order.findIndex(failing);
  if (attention >= CONNECTORS_SHOWN) order.splice(CONNECTORS_SHOWN - 1, 0, ...order.splice(attention, 1));
  return order;
}
