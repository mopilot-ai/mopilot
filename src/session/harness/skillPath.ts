// Where a chat's skill is on this Mac, whichever harness the chat runs on: one lookup by chat and skill name, so a skill's name can open its SKILL.md. Only a harness that can locate its skills answers (Claude, from its catalog); a chat on a machine, or any other harness, has no path here.
import { useStore } from '../../store/core';
import { useFolderHere } from '../../lib/chatMachine';
import type { ClaudeSkillFile } from '../../../shared/model/native';
import { useClaudeSkillFiles } from './claude';
import { ownGet } from '../../../shared/ownTable.mjs';

/** The skill's SKILL.md and its description for this chat, or null when it is not known on this Mac. @param name the skill as typed, with or without the slash */
export function useSkillFile(threadId: string | null, name: string): ClaudeSkillFile | null {
  const cwd = useFolderHere(
    threadId,
    useStore((s) => (threadId ? (s.threads[threadId]?.cwd ?? '') : '')),
  );
  const files = useClaudeSkillFiles(threadId, cwd);
  return (cwd && ownGet(files, name.replace(/^\//, ''))) || null;
}

/** The absolute path of the skill's SKILL.md for this chat, or null. */
export function useSkillPath(threadId: string | null, name: string): string | null {
  return useSkillFile(threadId, name)?.path ?? null;
}
