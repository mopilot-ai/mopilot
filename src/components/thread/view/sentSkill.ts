// The skill a sent message starts ("/fix-bug tidy up"), by the chat harness's own command list: what its bubble shows as
// the skill and the words after it, the way Claude Code shows a prompt that runs a skill.
import { useFolderHere } from '../../../lib/chatMachine';
import { useStore } from '../../../store/core';
import { useCommandProvider } from '../../../session/harness/claude';
import { sentSkill } from '../../../harness/commands';

export function useSentSkill(threadId: string, text: string): { name: string; rest: string } | null {
  const cwd = useFolderHere(
    threadId,
    useStore((st) => st.threads[threadId]?.cwd ?? ''),
  );
  return sentSkill(text, useCommandProvider(threadId, cwd));
}
