// Which harness family a chat's next message goes to, and where that family's background tasks come from (a table, so shared code reads it instead of branching on a harness name).
import { ownTable } from '../../shared/ownTable.mjs';
import { isAcpThread, type Segment } from '../harness/types';
import { chatFamily, nativeOf } from './chats';

export type Family = 'claude' | 'codex' | 'acp';

/** The family a harness id belongs to; anything not listed here is Codex's. */
const FAMILY_OF_HARNESS: Record<string, Family> = ownTable({ claude: 'claude' });

/** Where a family's background tasks come from: main pushes them, the app-server lists shells and agents, or the chat's own turns hold the agents. */
export const TASK_SOURCE: Record<Family, 'main' | 'terminals' | 'turns'> = { claude: 'main', codex: 'terminals', acp: 'turns' };

export const taskSourceOf = (chatId: string) => TASK_SOURCE[chatFamily(chatId)];

/** Native task ownership changes even when the replacement uses the same harness family. */
export const taskSource = (chatId: string) => ({ kind: chatFamily(chatId), key: nativeOf(chatId) });
export const taskSourceKey = (chatId: string) => {
  const source = taskSource(chatId);
  return JSON.stringify([source.kind, source.key]);
};

/** The native owner of a historical turn, including ACP segments represented by Codex-shaped turns. */
export function taskSourceAt(chatId: string, turn: number, segments: Segment[] | null | undefined, turnsAbove = 0) {
  if (!segments?.length) return taskSource(chatId);
  const segment = segments.findLast((s) => s.start <= turn + turnsAbove) ?? segments[0];
  return {
    kind: isAcpThread(segment.nativeId) ? ('acp' as const) : (FAMILY_OF_HARNESS[segment.harness] ?? 'codex'),
    key: segment.nativeId,
  };
}
