// Finds an agent run by its key in a chat's turns (or in a parent agent's transcript) and formats its stats line.
import { agentRunOf, type AgentRun } from './agentRun';
import { compactCount, formatDuration } from './format';

type TurnLike = { items?: readonly unknown[] | null };

type IndexedRun = { run: AgentRun; turn: number };
type SourceAt = (turn: number) => AgentRun['source'];
const indexes = new WeakMap<readonly TurnLike[], Map<string, IndexedRun>>();
const ownedRun = (entry: IndexedRun, sourceAt?: SourceAt) => (sourceAt ? { ...entry.run, source: sourceAt(entry.turn) } : entry.run);

const perItems = new WeakMap<readonly unknown[], AgentRun[]>();
const NO_ITEMS: readonly unknown[] = [];

/** The agent runs among one turn's items, read once per items array: a settled turn is never scanned again. */
export function agentRunsOfTurn(turn: TurnLike): AgentRun[] {
  const items = turn.items ?? NO_ITEMS;
  let runs = perItems.get(items);
  if (!runs) {
    runs = items.flatMap((item) => agentRunOf(item) ?? []);
    perItems.set(items, runs);
  }
  return runs;
}

function indexOf(turns: readonly TurnLike[]): Map<string, IndexedRun> {
  let index = indexes.get(turns);
  if (!index) {
    index = new Map();
    for (const [turn, t] of turns.entries()) for (const run of agentRunsOfTurn(t)) index.set(run.key, { run, turn });
    indexes.set(turns, index);
  }
  return index;
}

/** The agent run with `key` among the turns' items; the index is built once per turns array, from each turn's runs read once per items array. */
export function findAgentRun(turns: readonly TurnLike[] | null | undefined, key: string, sourceAt?: SourceAt): AgentRun | null {
  const entry = turns ? indexOf(turns).get(key) : undefined;
  return entry ? ownedRun(entry, sourceAt) : null;
}

/** Every agent run among the turns' items, in order. */
export function agentRunsIn(turns: readonly TurnLike[] | null | undefined, sourceAt?: SourceAt): AgentRun[] {
  return turns ? [...indexOf(turns).values()].map((entry) => ownedRun(entry, sourceAt)) : [];
}

/**
 * The run with `key` in the chat's turns, else inside an agent's transcript (a nested agent), searched
 * breadth-first through the transcripts `itemsOf` knows.
 */
export function findNestedAgentRun(
  turns: readonly TurnLike[] | null | undefined,
  key: string,
  itemsOf: (run: AgentRun) => readonly unknown[],
  sourceAt?: SourceAt,
): AgentRun | null {
  const top = findAgentRun(turns, key, sourceAt);
  if (top) return top;
  const queue = agentRunsIn(turns, sourceAt);
  const seen = new Set(queue.map((r) => r.key));
  while (queue.length) {
    const parent = queue.shift()!;
    for (const item of itemsOf(parent)) {
      const nested = agentRunOf(item);
      if (!nested || seen.has(nested.key)) continue;
      const run = parent.source ? { ...nested, source: parent.source } : nested;
      if (run.key === key) return run;
      seen.add(run.key);
      queue.push(run);
    }
  }
  return null;
}

/** Token counts as Claude Desktop shows them: 950, 1.2k, 165.4k, 2.1M. */
export function compactTokens(n: number): string {
  return compactCount(n);
}

/** "12 tool calls · 165.4k tokens · 2m 3s" for a settled run; parts the harness didn't report are left out. */
export function agentStatsLine(run: Pick<AgentRun, 'tokens' | 'startedAt' | 'completedAt'> & { toolUses: number | null }): string {
  const parts = run.toolUses == null ? [] : [`${run.toolUses} tool ${run.toolUses === 1 ? 'call' : 'calls'}`];
  if (run.tokens != null) parts.push(`${compactTokens(run.tokens)} tokens`);
  if (run.startedAt != null && run.completedAt != null) parts.push(formatDuration(run.completedAt - run.startedAt));
  return parts.join(' · ');
}

const NOT_A_CALL = new Set(['agentMessage', 'reasoning', 'userMessage', 'statusNote', 'plan', 'contextCompaction']);

/**
 * How many tool calls an agent made, for the stats line: the run's own count, else the calls in its loaded
 * transcript. Null when neither is known (a replayed run whose transcript has not loaded), so the line says nothing.
 */
export function agentToolCalls(run: Pick<AgentRun, 'toolUses'>, items: readonly { type: string }[]): number | null {
  if (run.toolUses > 0) return run.toolUses;
  return items.length ? items.filter((i) => !NOT_A_CALL.has(i.type)).length : null;
}
